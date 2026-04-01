import type { Env } from '../_lib/env';
import { getSupabaseAdmin } from '../_lib/supabase';
import { getResend, getAudienceId } from '../_lib/resend';

// ---------------------------------------------------------------------------
// Basic in-memory duplicate-submission guard
// ---------------------------------------------------------------------------
// Cloudflare Workers are stateless across isolates, so this map only prevents
// rapid-fire duplicate requests hitting the SAME isolate (e.g. a user
// double-clicking submit). For proper rate limiting, configure Cloudflare WAF
// rate-limiting rules in the dashboard:
//   Zone > Security > WAF > Rate limiting rules
//   Suggested rule: /api/email-capture  — 5 requests per 10 seconds per IP.
// ---------------------------------------------------------------------------
const recentSubmissions = new Map<string, number>();
const DEDUP_WINDOW_MS = 10_000; // 10 seconds

function isDuplicate(email: string): boolean {
  const now = Date.now();
  const lastSeen = recentSubmissions.get(email);
  if (lastSeen && now - lastSeen < DEDUP_WINDOW_MS) {
    return true;
  }
  recentSubmissions.set(email, now);

  // Housekeeping: prune stale entries to avoid unbounded growth
  if (recentSubmissions.size > 500) {
    for (const [key, ts] of recentSubmissions) {
      if (now - ts > DEDUP_WINDOW_MS) {
        recentSubmissions.delete(key);
      }
    }
  }

  return false;
}

// --- Admin data endpoint: GET /api/email-capture?admin=1 ---
const ADMIN_PASSWORD = 'nailthequoteangi26';

export const onRequestGet: PagesFunction<Env> = async (context) => {
  try {
    const authHeader = context.request.headers.get('X-Admin-Key');
    if (authHeader !== ADMIN_PASSWORD) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const supabase = getSupabaseAdmin(context.env);

    const { data: profiles, error: e1 } = await supabase.from('profiles').select('*').order('created_at', { ascending: false });
    if (e1) return new Response(JSON.stringify({ error: 'profiles', detail: e1.message }), { status: 500 });

    const { data: calculations, error: e2 } = await supabase.from('saved_calculations').select('user_id, tool_slug, trade, label, created_at').order('created_at', { ascending: false });
    if (e2) return new Response(JSON.stringify({ error: 'calculations', detail: e2.message }), { status: 500 });

    const { data: documents, error: e3 } = await supabase.from('saved_documents').select('user_id, doc_type, client_name, amount, status, created_at').order('created_at', { ascending: false });
    if (e3) return new Response(JSON.stringify({ error: 'documents', detail: e3.message }), { status: 500 });

    const { data: emailCaptures, error: e4 } = await supabase.from('email_captures').select('*').order('created_at', { ascending: false });
    if (e4) return new Response(JSON.stringify({ error: 'emails', detail: e4.message }), { status: 500 });

    const activityMap: Record<string, { tools: Record<string, number>; totalCalcs: number; documents: any[]; lastActive: string }> = {};
    for (const calc of calculations || []) {
      if (!activityMap[calc.user_id]) activityMap[calc.user_id] = { tools: {}, totalCalcs: 0, documents: [], lastActive: calc.created_at };
      const key = `${calc.trade}/${calc.tool_slug}`;
      activityMap[calc.user_id].tools[key] = (activityMap[calc.user_id].tools[key] || 0) + 1;
      activityMap[calc.user_id].totalCalcs++;
    }
    for (const doc of documents || []) {
      if (!activityMap[doc.user_id]) activityMap[doc.user_id] = { tools: {}, totalCalcs: 0, documents: [], lastActive: doc.created_at };
      activityMap[doc.user_id].documents.push({ type: doc.doc_type, client: doc.client_name, amount: doc.amount, status: doc.status, created_at: doc.created_at });
    }

    const users = (profiles || []).map((p: any) => {
      const a = activityMap[p.id] || { tools: {}, totalCalcs: 0, documents: [], lastActive: null };
      return {
        id: p.id, email: p.email, created_at: p.created_at,
        business_name: p.business_name || null, owner_name: p.owner_name || null,
        trade: p.trade || null, phone: p.phone || null,
        address: p.address || null, zip_code: p.zip_code || null,
        license_number: p.license_number || null,
        default_hourly_rate: p.default_hourly_rate || null,
        default_markup: p.default_markup || null, marketing_consent: p.marketing_consent,
        tools_used: a.tools, total_calculations: a.totalCalcs,
        documents: a.documents, last_active: a.lastActive,
      };
    });

    return new Response(JSON.stringify({
      users, email_captures: emailCaptures || [],
      summary: { total_users: users.length, total_email_captures: (emailCaptures || []).length, total_calculations: (calculations || []).length, total_documents: (documents || []).length },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  } catch (e: any) {
    return new Response(JSON.stringify({ error: e?.message || 'Internal error' }), { status: 500 });
  }
};

// --- Email capture endpoint: POST /api/email-capture ---
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body: any = await context.request.json();
    const { email, toolSlug, toolName, tradeSlug, tradeName, marketingConsent, sourceUrl } = body;

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return new Response(JSON.stringify({ error: 'Invalid email' }), { status: 400 });
    }

    // Duplicate-submission guard (same email within 10 s on this isolate)
    if (isDuplicate(email.toLowerCase())) {
      return new Response(JSON.stringify({ success: true, deduplicated: true }), { status: 200 });
    }

    const resend = getResend(context.env);
    const supabase = getSupabaseAdmin(context.env);

    // 1. Send results email with link back to tool
    const toolUrl = `https://nailthequote.com/${tradeSlug}/${toolSlug}`;
    await resend.emails.send({
      from: 'NailTheQuote Results <results@nailthequote.com>',
      to: email,
      subject: `Your ${toolName} Results — NailTheQuote.com`,
      html: buildResultsEmail(toolName, tradeName, toolUrl),
    });

    // 2. Add to Resend Audience (if marketing consent)
    if (marketingConsent) {
      const audienceId = getAudienceId(context.env);
      if (audienceId) {
        await resend.contacts.create({
          audienceId,
          email,
          unsubscribed: false,
          firstName: '',
          lastName: '',
          data: {
            source: 'nailthequote.com',
            trade: tradeSlug || '',
            tool: toolSlug || '',
            signup_type: 'email_capture',
            signup_date: new Date().toISOString().split('T')[0],
          },
        });
      }
    }

    // 3. Log to Supabase email_captures table
    await supabase.from('email_captures').insert({
      email,
      trade: tradeSlug,
      tool_slug: toolSlug,
      source_url: sourceUrl || `/${tradeSlug}/${toolSlug}`,
      marketing_consent: marketingConsent ?? false,
    });

    return new Response(JSON.stringify({ success: true }), { status: 200 });
  } catch (err) {
    console.error('Email capture error:', err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 });
  }
};

function buildResultsEmail(toolName: string, tradeName: string, toolUrl: string): string {
  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:40px 20px;">
    <div style="background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e4e4e7;">
      <h1 style="font-size:20px;color:#18181b;margin:0 0 8px 0;">Your ${toolName} Results</h1>
      <p style="font-size:14px;color:#71717a;margin:0 0 24px 0;">${tradeName} &middot; NailTheQuote.com</p>
      <p style="font-size:14px;color:#3f3f46;line-height:1.6;margin:0 0 24px 0;">
        Your calculation results are ready. Click the link below to view them. Bookmark the page to access your results anytime.
      </p>
      <a href="${toolUrl}" style="display:inline-block;background:#FF6B2B;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;">
        View Your Results &rarr;
      </a>
      <hr style="border:none;border-top:1px solid #e4e4e7;margin:32px 0 16px 0;">
      <p style="font-size:12px;color:#a1a1aa;margin:0;">
        Create a <a href="https://nailthequote.com/dashboard" style="color:#FF6B2B;text-decoration:none;">free account</a> to save your calculations and pre-fill your business details.
      </p>
    </div>
    <p style="font-size:11px;color:#a1a1aa;text-align:center;margin:16px 0 0 0;">
      NailTheQuote.com &middot; Free tools for home service pros<br>
      <a href="{{{unsubscribe_url}}}" style="color:#a1a1aa;">Unsubscribe</a>
    </p>
  </div>
</body>
</html>`;
}
