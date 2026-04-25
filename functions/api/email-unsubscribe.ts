// /api/email-unsubscribe?token=<hmac-signed-token>
//
// Handles unsub clicks from email footers AND Gmail one-click unsubscribe
// requests (RFC 8058 — POSTs from a List-Unsubscribe header).
//
// On valid token:
//   1. Insert into email_unsubscribes (PK = email; ON CONFLICT DO NOTHING).
//   2. Cancel any pending email_sequence_queue rows for that email.
//   3. Return a small confirmation page (GET) or 200 OK (POST).
//
// On invalid/missing token: 400.

import type { Env } from '../_lib/env';
import { getSupabaseAdmin } from '../_lib/supabase';
import { verifyUnsubscribeToken } from '../_lib/unsubscribe-token';

export const onRequestGet: PagesFunction<Env> = async (context) => handle(context, false);
export const onRequestPost: PagesFunction<Env> = async (context) => handle(context, true);

async function handle(
  context: Parameters<PagesFunction<Env>>[0],
  isPost: boolean
): Promise<Response> {
  const url = new URL(context.request.url);
  let token = url.searchParams.get('token') ?? '';

  // Gmail one-click POST sends body as form-encoded; spec ignores body, but
  // some clients put the token in the body. Cover that case.
  if (!token && isPost) {
    try {
      const body = await context.request.text();
      const params = new URLSearchParams(body);
      token = params.get('token') ?? '';
    } catch {
      // ignore
    }
  }

  if (!token) {
    return htmlResponse(400, errorPage('Missing token.'));
  }

  const email = await verifyUnsubscribeToken(token, context.env.UNSUBSCRIBE_SIGNING_KEY);
  if (!email) {
    return htmlResponse(400, errorPage('Invalid unsubscribe link.'));
  }

  const supabase = getSupabaseAdmin(context.env);

  // Suppress
  const { error: insertErr } = await supabase
    .from('email_unsubscribes')
    .upsert({ email, source: 'list_unsubscribe' }, { onConflict: 'email', ignoreDuplicates: true });
  if (insertErr) {
    console.error('email-unsubscribe: insert failed', insertErr);
    return htmlResponse(500, errorPage('Could not record unsubscribe. Please try again later.'));
  }

  // Cancel any pending queue rows for this email
  const { error: cancelErr } = await supabase
    .from('email_sequence_queue')
    .update({ status: 'unsubscribed' })
    .eq('email', email)
    .eq('status', 'pending');
  if (cancelErr) {
    // Non-fatal: suppression is recorded, sends will be skipped at process time.
    console.error('email-unsubscribe: queue cancel failed (non-fatal)', cancelErr);
  }

  // Gmail one-click POST expects 200 OK with no body required.
  if (isPost) {
    return new Response(JSON.stringify({ unsubscribed: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  return htmlResponse(200, confirmationPage(email));
}

function htmlResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function confirmationPage(email: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribed — NailTheQuote</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#27272a;">
  <div style="max-width:520px;margin:48px auto;padding:32px 24px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">
    <h1 style="font-size:20px;color:#18181b;margin:0 0 12px 0;">You're unsubscribed</h1>
    <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">
      We've removed <strong>${escapeHtml(email)}</strong> from the NailTheQuote nurture sequence. You won't get any more follow-up emails about your HVAC load calculation.
    </p>
    <p style="font-size:14px;color:#71717a;line-height:1.6;margin:0;">
      If you change your mind later, just run the calculator again at
      <a href="https://nailthequote.com/hvac/load-calculator/" style="color:#FF6B2B;">nailthequote.com</a>
      and the sequence will start fresh.
    </p>
  </div>
</body>
</html>`;
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Unsubscribe — NailTheQuote</title>
</head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#27272a;">
  <div style="max-width:520px;margin:48px auto;padding:32px 24px;background:#ffffff;border:1px solid #e4e4e7;border-radius:12px;">
    <h1 style="font-size:20px;color:#18181b;margin:0 0 12px 0;">Unsubscribe didn't work</h1>
    <p style="font-size:15px;line-height:1.6;margin:0 0 16px 0;">${escapeHtml(message)}</p>
    <p style="font-size:14px;color:#71717a;line-height:1.6;margin:0;">
      Reply to any of our emails and we'll remove you manually.
    </p>
  </div>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
