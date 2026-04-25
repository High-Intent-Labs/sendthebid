// /api/email-scheduler — the "tick" endpoint for the persona-1 nurture queue.
//
// Hit every 15 min by the GitHub Actions cron at .github/workflows/email-scheduler-cron.yml.
// Auth: bearer token in the Authorization header (must match env.EMAIL_SCHEDULER_SECRET).
//
// What it does, in order:
//   1. Recover any rows stuck in 'sending' for >10 min back to 'pending'.
//   2. Atomically claim up to N due rows (status=pending, scheduled_at<=NOW()).
//   3. For each claimed row: look up the user's most recent email_captures
//      row, build the template data, render the persona1 template + subject,
//      check the unsubscribe list, and send via Resend.
//   4. Mark each row as sent / failed / unsubscribed accordingly.
//
// Idempotency: claim_due_email_sequence_rows uses FOR UPDATE SKIP LOCKED so
// two concurrent invocations never grab the same row. Sent rows transition
// to a terminal status; failed rows stay claimed (we'll surface them via
// the admin dashboard in Tier C).

import type { Env } from '../_lib/env';
import { getSupabaseAdmin } from '../_lib/supabase';
import { getResend } from '../_lib/resend';
import { renderPersona1Email } from '../_lib/template-engine';
import { buildPersona1TemplateData, PERSONA1_KEY } from '../_lib/persona1-enroll';
import { buildUnsubscribeUrl } from '../_lib/unsubscribe-token';
import { PERSONA1_MANIFEST } from '../_generated/email-templates';

// Don't claim more than this in a single tick. At 15-min cadence and current
// volume (~150 captures/wk → ~85 persona1-bucket sends/wk), we'd never hit
// double digits in a single tick. The cap protects against a future runaway.
const MAX_CLAIM_PER_TICK = 25;

interface QueueRow {
  id: number;
  email: string;
  persona: string;
  email_number: number;
  scheduled_at: string;
  status: string;
  claimed_at: string | null;
}

interface CaptureRow {
  email: string;
  calculation_data: Record<string, unknown> | null;
}

// Allow GET for cron simplicity (curl --get + bearer header) and POST for the
// recommended path. Both behave identically.
export const onRequestGet: PagesFunction<Env> = async (ctx) => handle(ctx);
export const onRequestPost: PagesFunction<Env> = async (ctx) => handle(ctx);

async function handle(context: Parameters<PagesFunction<Env>>[0]): Promise<Response> {
  // 1. Auth
  const auth = context.request.headers.get('authorization') || '';
  const expected = `Bearer ${context.env.EMAIL_SCHEDULER_SECRET}`;
  if (!context.env.EMAIL_SCHEDULER_SECRET || auth !== expected) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  }

  const supabase = getSupabaseAdmin(context.env);
  const resend = getResend(context.env);

  // 2. Recover stuck rows
  const { data: recoveredCount, error: recErr } = await supabase.rpc('recover_stuck_email_sequence_rows');
  if (recErr) {
    console.error('email-scheduler: recover_stuck failed', recErr);
    // Non-fatal — keep going; just means the cleanup pass didn't run.
  } else if (typeof recoveredCount === 'number' && recoveredCount > 0) {
    console.log(`email-scheduler: recovered ${recoveredCount} stuck rows`);
  }

  // 3. Claim due rows
  const { data: claimed, error: claimErr } = await supabase.rpc('claim_due_email_sequence_rows', {
    limit_n: MAX_CLAIM_PER_TICK,
  });
  if (claimErr) {
    console.error('email-scheduler: claim failed', claimErr);
    return new Response(JSON.stringify({ error: 'claim_failed' }), { status: 500 });
  }
  const rows: QueueRow[] = Array.isArray(claimed) ? (claimed as QueueRow[]) : [];
  if (rows.length === 0) {
    return new Response(JSON.stringify({ recovered: recoveredCount ?? 0, processed: 0 }), { status: 200 });
  }

  // 4. Process each claimed row
  const results: Array<{ id: number; outcome: string; detail?: string }> = [];
  for (const row of rows) {
    try {
      const outcome = await processOne(row, supabase, resend, context.env);
      results.push({ id: row.id, outcome });
    } catch (err) {
      console.error(`email-scheduler: row ${row.id} threw`, err);
      await markFailed(supabase, row.id, String(err));
      results.push({ id: row.id, outcome: 'error', detail: String(err) });
    }
  }

  return new Response(
    JSON.stringify({
      recovered: recoveredCount ?? 0,
      processed: results.length,
      results,
    }),
    { status: 200 }
  );
}

async function processOne(
  row: QueueRow,
  supabase: ReturnType<typeof getSupabaseAdmin>,
  resend: ReturnType<typeof getResend>,
  env: Env
): Promise<string> {
  // Skip if user is on the unsubscribe list (they may have unsubscribed
  // between enrollment and this send).
  const { data: unsub } = await supabase
    .from('email_unsubscribes')
    .select('email')
    .eq('email', row.email)
    .limit(1);
  if (unsub && unsub.length > 0) {
    await supabase
      .from('email_sequence_queue')
      .update({ status: 'unsubscribed' })
      .eq('id', row.id);
    return 'unsubscribed';
  }

  // We currently only support persona1. Other personas will return early
  // until their templates ship.
  if (row.persona !== PERSONA1_KEY) {
    await supabase
      .from('email_sequence_queue')
      .update({ status: 'cancelled', error_message: `unsupported persona: ${row.persona}` })
      .eq('id', row.id);
    return 'cancelled_unsupported_persona';
  }

  // Find the most recent load-calculator email_captures row for this user.
  const { data: captures, error: capErr } = await supabase
    .from('email_captures')
    .select('email, calculation_data')
    .eq('email', row.email)
    .eq('tool_slug', 'load-calculator')
    .order('created_at', { ascending: false })
    .limit(1);
  if (capErr) {
    await markFailed(supabase, row.id, `email_captures lookup: ${capErr.message}`);
    return 'failed_lookup';
  }
  if (!captures || captures.length === 0) {
    // No matching capture — cancel the row. Shouldn't happen (we enroll only
    // when a capture lands), but covers manual deletions.
    await supabase
      .from('email_sequence_queue')
      .update({ status: 'cancelled', error_message: 'no matching email_captures row' })
      .eq('id', row.id);
    return 'cancelled_no_capture';
  }
  const capture: CaptureRow = captures[0] as CaptureRow;

  // Build CTA URL from manifest template (utm_content per email_number).
  const sequenceEntry = PERSONA1_MANIFEST.sequence[row.email_number];
  if (!sequenceEntry) {
    await markFailed(supabase, row.id, `missing manifest entry for email_number=${row.email_number}`);
    return 'failed_manifest';
  }
  const ctaUrl = sequenceEntry.cta_url_template;

  const data = buildPersona1TemplateData(capture, row.email_number, ctaUrl);
  const { subject, html, preheader } = await renderPersona1Email(row.email_number, data);

  // Substitute Resend's {{{unsubscribe_url}}} placeholder with our HMAC-signed URL.
  const unsubUrl = await buildUnsubscribeUrl(row.email, env.UNSUBSCRIBE_SIGNING_KEY);
  const finalHtml = html.replace(/\{\{\{unsubscribe_url\}\}\}/g, unsubUrl);

  // Inject the preheader as a hidden first line — most email clients use this
  // as the inbox preview text. CSS-hidden so it doesn't show in the rendered
  // body. Belt-and-suspenders against client-specific quirks: zero font size
  // + zero line height + invisible color + display:none all in one.
  const preheaderInjection = `
<div style="display:none !important;font-size:1px;color:#ffffff;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(preheader)}</div>
`;
  const htmlWithPreheader = finalHtml.replace(/(<body[^>]*>)/i, `$1${preheaderInjection}`);

  // Send via Resend
  const { data: sendResult, error: sendErr } = await resend.emails.send({
    from: PERSONA1_MANIFEST.from_address,
    to: row.email,
    replyTo: PERSONA1_MANIFEST.reply_to,
    subject,
    html: htmlWithPreheader,
    headers: {
      // RFC 8058 + RFC 2369 — Gmail one-click unsub.
      'List-Unsubscribe': `<${unsubUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  });

  if (sendErr) {
    await markFailed(supabase, row.id, `resend send: ${sendErr.message ?? String(sendErr)}`);
    return 'failed_send';
  }

  await supabase
    .from('email_sequence_queue')
    .update({
      status: 'sent',
      sent_at: new Date().toISOString(),
      resend_email_id: sendResult?.id ?? null,
      error_message: null,
    })
    .eq('id', row.id);

  return 'sent';
}

async function markFailed(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  id: number,
  message: string
): Promise<void> {
  await supabase
    .from('email_sequence_queue')
    .update({ status: 'failed', error_message: message.slice(0, 1000) })
    .eq('id', id);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
