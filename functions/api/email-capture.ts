import type { Env } from '../_lib/env';
import { getSupabaseAdmin } from '../_lib/supabase';
import { getResend, getAudienceId } from '../_lib/resend';
import { enrollPersona1 } from '../_lib/persona1-enroll';

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

// --- Email capture endpoint: POST /api/email-capture ---
export const onRequestPost: PagesFunction<Env> = async (context) => {
  try {
    const body: any = await context.request.json();
    const {
      email, toolSlug, toolName, tradeSlug, tradeName,
      marketingConsent, sourceUrl, calculationResults,
      segment,          // 'home' | 'customer' — from the "Who's this for?" gate
      isDiy,            // true | false | null — Q2, home path only (null for pro)
      contractorStage,  // 'not_yet' | 'has_estimates' | 'researching' | null — Q3, is_diy=false only
      abVariant,        // 'A' | 'B' | 'C' — email-gate copy experiment arm
      attribution,      // { gclid, utm_source, utm_medium, utm_campaign, utm_term, utm_content, landing_url, referrer }
    } = body;
    const attrib = attribution || {};

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
    const isTransactional = !!calculationResults;
    const emailHtml = isTransactional
      ? buildResultsEmailWithData(toolName, toolUrl, calculationResults)
      : buildResultsEmail(toolName, tradeName, toolUrl);
    // Transactional (gated-calculator) emails: simpler subject + headers that tell
    // Gmail this is a 1:1 transactional send, not bulk marketing. Without these,
    // Gmail classifies the email as Promotions because of the styled HTML and
    // the unsubscribe footer (which we now strip out of the transactional template).
    await resend.emails.send({
      from: 'NailTheQuote Results <results@nailthequote.com>',
      to: email,
      subject: isTransactional
        ? `Your ${toolName} Results`
        : `Your ${toolName} Results — NailTheQuote.com`,
      html: emailHtml,
      headers: isTransactional ? { 'Auto-Submitted': 'auto-generated' } : undefined,
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

    // 3. Log to Supabase email_captures table. Per migration 003 we persist
    // the full input+result snapshot (calculation_data jsonb) plus segment
    // and A/B variant; per migration 007 we also persist the Load Calculator
    // qualifying-question answers (is_diy + contractor_stage) as their own
    // columns so the admin per-tool deep-dive can filter/aggregate cleanly.
    // These are Load-Calc-specific today; will be NULL for every other tool
    // and for pre-2026-04-19 Load Calc captures.
    // Insert and surface the error to Cloudflare logs. The supabase-js
    // client returns { data, error } instead of throwing — a silent error
    // here was the cause of the 2026-04-19 regression where
    // is_diy/contractor_stage were written to a schema that didn't yet
    // have those columns; the Worker returned 200 and emails were lost
    // for ~4 hours before the mismatch surfaced downstream in the admin
    // RPC. Logging + throwing means the next schema drift shows up in
    // `wrangler tail` / Cloudflare logs immediately.
    const { error: insertError } = await supabase.from('email_captures').insert({
      email,
      trade: tradeSlug,
      tool_slug: toolSlug,
      source_url: sourceUrl || `/${tradeSlug}/${toolSlug}`,
      marketing_consent: marketingConsent ?? false,
      calculation_data: calculationResults ?? null,
      segment: segment ?? null,
      ab_variant: abVariant ?? null,
      is_diy: typeof isDiy === 'boolean' ? isDiy : null,
      contractor_stage: contractorStage ?? null,
      // Migration 008: ad attribution snapshot. Frontend captures URL params on
      // first pageview of a session (see BaseLayout.astro) and stamps them here
      // so every email has an acquisition trail independent of GAds attribution.
      // Pair with ad_clicks table (populated by google_ads_mcp/fetch_ad_clicks.py)
      // to resolve gclid -> keyword/ad group server-side. See email_captures_attributed
      // view for the joined read path.
      gclid: attrib.gclid || null,
      utm_source: attrib.utm_source || null,
      utm_medium: attrib.utm_medium || null,
      utm_campaign: attrib.utm_campaign || null,
      utm_term: attrib.utm_term || null,
      utm_content: attrib.utm_content || null,
      landing_url: attrib.landing_url || null,
      referrer: attrib.referrer || null,
    });
    if (insertError) {
      // Log-only, do NOT throw: by this point Resend has already sent
      // the user their results email and added their contact. Returning
      // 500 now would make the user see a failure despite the email
      // going through, and a resubmit would trigger a duplicate send.
      // The PostHog `email_captured` event is the authoritative record
      // for analytics; Supabase persistence is best-effort for admin
      // inspection. Surface the failure to Cloudflare logs so we catch
      // drift (schema mismatch, RLS, transient DB) without a stealth
      // outage like the 2026-04-19 regression.
      console.error('Supabase email_captures insert failed (NON-FATAL):', {
        code: insertError.code,
        message: insertError.message,
        details: insertError.details,
        hint: insertError.hint,
        tool_slug: toolSlug,
        email,
      });
    }

    // 4. Enroll in the persona-1 nurture sequence if this capture qualifies.
    //    Same non-fatal pattern as the email_captures insert above: the user-
    //    facing flow has already succeeded (transactional email sent + contact
    //    added). A failed enrollment is logged and does not 500 the response.
    //    The qualifier is captured by the wizard (segment + is_diy +
    //    contractor_stage) — see functions/_lib/persona1-enroll.ts for the
    //    decision logic.
    try {
      const enrollResult = await enrollPersona1(supabase, {
        email,
        segment: segment ?? null,
        isDiy: typeof isDiy === 'boolean' ? isDiy : null,
        contractorStage: contractorStage ?? null,
        toolSlug: toolSlug ?? null,
      });
      if (!enrollResult.enrolled && enrollResult.reason && enrollResult.reason !== 'not-qualified') {
        console.error('persona1 enrollment skipped (NON-FATAL):', {
          email,
          reason: enrollResult.reason,
        });
      }
    } catch (enrollErr) {
      console.error('persona1 enrollment threw (NON-FATAL):', enrollErr);
    }

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

// Transactional results email — deliberately plain to stay out of Gmail's
// Promotions tab. Key rules for this template:
//   - No unsubscribe link (unsubscribe signals = marketing, not transactional)
//   - No upsells or calls to action for unrelated products
//   - No styled CTA buttons — use a plain text link
//   - Minimal HTML styling, white background, no card / borders / colors
// Pair with the `Auto-Submitted: auto-generated` header set at send time.
// Transactional results email — deliberately plain to stay out of Gmail's
// Promotions tab. Branches on results.mode:
//   'whole-house'  → cooling/heating/tonnage + whole-house inputs
//   'mini-split'   → cooling/heating + closest standard size + CFM + room inputs
//   (legacy / none) → falls back to simplified Manual J table shape
function buildResultsEmailWithData(
  toolName: string,
  toolUrl: string,
  results: any,
): string {
  const fmt = (n?: number) => (n === 0 || !!n) ? n.toLocaleString('en-US') : '—';
  const row = (label: string, value: string) =>
    `<tr><td style="padding:6px 0;color:#555;font-size:14px;">${label}</td><td style="padding:6px 0;font-weight:600;color:#111;font-size:14px;text-align:right;">${value}</td></tr>`;
  const displayUrl = toolUrl.replace(/^https?:\/\//, '');

  const mode = results?.mode;

  // Results table varies by mode
  let resultRows = '';
  let inputRows = '';

  if (mode === 'whole-house') {
    resultRows = [
      row('Cooling load', `${fmt(results.coolingBTU)} BTU`),
      row('Heating load', `${fmt(results.heatingBTU)} BTU`),
      row('System tonnage', `${results.tonnage ?? '—'} ton`),
    ].join('');
    inputRows = [
      results.state ? row('Location', `${results.state} — ${results.region} region`) : '',
      results.sqft ? row('Square footage', `${fmt(results.sqft)} sq ft`) : '',
      results.ceilingHeight ? row('Ceiling height', `${results.ceilingHeight} ft`) : '',
      results.insulation ? row('Insulation', results.insulation) : '',
    ].join('');
  } else if (mode === 'mini-split') {
    resultRows = [
      row('Cooling load', `${fmt(results.coolingBTU)} BTU`),
      row('Closest standard size', results.closestStandardLabel || '—'),
      row('Heating load', `${fmt(results.heatingBTU)} BTU`),
      row('Suggested airflow', `${fmt(results.suggestedCFM)} CFM`),
    ].join('');
    inputRows = [
      results.state ? row('Location', `${results.state} — ${results.region} region`) : '',
      results.roomType ? row('Room type', String(results.roomType).charAt(0).toUpperCase() + String(results.roomType).slice(1)) : '',
      results.dimensions ? row('Dimensions', `${results.dimensions} (${fmt(results.sqft)} sq ft)`) : '',
      results.exposedWalls ? row('Exposed walls', String(results.exposedWalls)) : '',
      results.orientation ? row('Primary orientation', results.orientation) : '',
      results.insulation ? row('Insulation', results.insulation) : '',
      (results.windowArea || results.windowArea === 0) ? row('Window area', `${fmt(results.windowArea)} sq ft`) : '',
    ].join('');
  } else if (mode === 'ac-room') {
    // Consumer "What Size AC Do I Need?" tool — plain, homeowner-voiced email.
    // Renders a full recommendation card (unit type + why + cost + install notes)
    // plus the inputs used. Installer-match CTA is appended below in this branch
    // so it only shows for ac-room captures, not the pro tools.
    const spaceLabelMap: Record<string, string> = {
      'garage': 'Garage',
      'addition': 'Addition / Sunroom',
      'bedroom': 'Bedroom',
      'basement': 'Finished Basement',
      'home-office': 'Home Office',
      'other': 'Other single room',
    };
    const spaceLabel = spaceLabelMap[String(results.space)] || 'Your space';
    const costStr =
      (results.installCostLow || results.installCostLow === 0) && results.installCostHigh
        ? `$${fmt(results.installCostLow)}–$${fmt(results.installCostHigh)}`
        : '—';
    // Use a custom renderer for this mode (not the generic table layout)
    return renderAcRoomEmail({
      toolUrl,
      toolName,
      spaceLabel,
      sqft: results.sqft,
      state: results.state,
      region: results.region,
      coolingBTU: results.coolingBTU,
      closestStandardLabel: results.closestStandardLabel,
      tonnage: results.tonnage,
      recommendedUnitLabel: results.recommendedUnitLabel,
      recommendedUnitWhy: results.recommendedUnitWhy,
      installNotes: results.installNotes,
      costStr,
      isAngiLead: !!results.isAngiLead,
      dimensions: results.dimensions,
      insulation: results.insulation,
      sun: results.sun,
      displayUrl,
    });
  } else {
    // Legacy fallback (pre-mode calculationResults — old Manual J shape)
    resultRows = [
      row('Cooling load', `${fmt(results.coolBtu)} BTU`),
      row('Heating load', `${fmt(results.heatBtu)} BTU`),
      row('System tonnage', `${results.tonnage ?? '—'} ton`),
    ].join('');
    inputRows = [
      results.sqft ? row('Square footage', `${fmt(results.sqft)} sq ft`) : '',
      results.climateZone ? row('Climate zone', results.climateZone) : '',
      results.insulation ? row('Insulation', results.insulation) : '',
    ].join('');
  }

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;">
  <div style="max-width:520px;margin:0 auto;">

    <p style="font-size:15px;margin:0 0 20px 0;">Here are your ${toolName} results:</p>

    <table style="width:100%;border-collapse:collapse;margin:0 0 24px 0;">
      <tbody>
        ${resultRows}
      </tbody>
    </table>

    ${inputRows ? `
    <p style="font-size:14px;color:#555;margin:0 0 6px 0;font-weight:600;">Inputs used</p>
    <table style="width:100%;border-collapse:collapse;margin:0 0 24px 0;">
      <tbody>
        ${inputRows}
      </tbody>
    </table>
    ` : ''}

    <p style="font-size:13px;color:#666;line-height:1.5;margin:0 0 24px 0;">
      Estimate only. For permit-ready Manual J, use ACCA-accredited software.
    </p>

    <p style="font-size:14px;color:#333;margin:0;">
      Run another calculation: <a href="${toolUrl}" style="color:#FF6B2B;text-decoration:underline;">${displayUrl}</a>
    </p>

  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Consumer "What Size AC Do I Need?" email template
// ---------------------------------------------------------------------------
// Homeowner-voiced, transactional-style (plain HTML, no unsubscribe footer —
// Gmail-Promotions-tab avoidance — header `Auto-Submitted: auto-generated`
// is set at send time, same as the mini-split transactional path).
// Always ends with the installer-match CTA when isAngiLead is true.
function renderAcRoomEmail(params: {
  toolUrl: string;
  toolName: string;
  spaceLabel: string;
  sqft?: number;
  state?: string;
  region?: string;
  coolingBTU?: number;
  closestStandardLabel?: string;
  tonnage?: number;
  recommendedUnitLabel?: string;
  recommendedUnitWhy?: string;
  installNotes?: string;
  costStr: string;
  isAngiLead: boolean;
  dimensions?: string;
  insulation?: string;
  sun?: string;
  displayUrl: string;
}): string {
  const fmt = (n?: number) =>
    n === 0 || !!n ? n.toLocaleString('en-US') : '—';
  const {
    toolUrl, spaceLabel, sqft, state, region, coolingBTU, closestStandardLabel,
    tonnage, recommendedUnitLabel, recommendedUnitWhy, installNotes, costStr,
    isAngiLead, dimensions, insulation, sun, displayUrl,
  } = params;
  const locStr = state ? `${state}, ${region} climate` : (region ? `${region} climate` : '');
  const tonsSuffix = tonnage !== undefined ? ` (${tonnage} ton${tonnage !== 1 ? 's' : ''})` : '';
  const standardLine = closestStandardLabel
    ? `Closest standard size: ${String(closestStandardLabel).replace(' mini-split', '')}.`
    : '';
  // Build the Angi installer CTA — URL params let the pros see what the
  // homeowner is actually looking to install.
  const installerUrl = `https://www.angi.com/nearme/hvac/?utm_source=nailthequote&utm_medium=email&utm_campaign=ac-size-for-my-room`;

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:24px;background:#ffffff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#111;">
  <div style="max-width:560px;margin:0 auto;">

    <p style="font-size:15px;margin:0 0 8px 0;">Here are your sizing results for your ${spaceLabel.toLowerCase()}${sqft ? ` (${fmt(sqft)} sq ft)` : ''}${locStr ? `, ${locStr}` : ''}:</p>

    <div style="background:#F8F9FB;border-radius:8px;padding:20px;margin:16px 0 20px 0;">
      <p style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:1px;margin:0 0 4px 0;">You need approximately</p>
      <p style="font-size:32px;font-weight:800;color:#FF6B2B;margin:0 0 4px 0;line-height:1.1;">${fmt(coolingBTU)} BTU${tonsSuffix}</p>
      ${standardLine ? `<p style="font-size:13px;color:#555;margin:0;">${standardLine}</p>` : ''}
    </div>

    ${recommendedUnitLabel ? `
    <div style="border:1px solid #FFD4BD;border-radius:8px;padding:18px;margin:0 0 20px 0;">
      <p style="font-size:12px;color:#6B7280;text-transform:uppercase;letter-spacing:1px;margin:0 0 4px 0;">Best fit for your space</p>
      <p style="font-size:18px;font-weight:700;color:#111;margin:0 0 8px 0;">${recommendedUnitLabel}</p>
      ${recommendedUnitWhy ? `<p style="font-size:14px;color:#444;line-height:1.5;margin:0 0 12px 0;">${recommendedUnitWhy}</p>` : ''}
      <p style="font-size:14px;color:#111;margin:0 0 4px 0;"><strong>Typical installed cost:</strong> ${costStr}</p>
      ${installNotes ? `<p style="font-size:13px;color:#555;line-height:1.5;margin:8px 0 0 0;">${installNotes}</p>` : ''}
    </div>
    ` : ''}

    ${isAngiLead ? `
    <div style="background:#FFF5EF;border:1px solid #FFD4BD;border-radius:8px;padding:18px;margin:0 0 20px 0;text-align:center;">
      <p style="font-size:16px;font-weight:700;color:#111;margin:0 0 6px 0;">Get matched with 3 installers near you</p>
      <p style="font-size:13px;color:#555;margin:0 0 14px 0;line-height:1.5;">Free, no commitment — licensed HVAC pros in your ZIP will send you quotes in 24–48 hours.</p>
      <a href="${installerUrl}" style="display:inline-block;background:#FF6B2B;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;padding:12px 28px;border-radius:8px;">
        Find Installers Near Me →
      </a>
    </div>
    ` : ''}

    <p style="font-size:14px;color:#444;margin:0 0 6px 0;font-weight:600;">What to ask an installer</p>
    <ul style="font-size:13px;color:#555;line-height:1.6;margin:0 0 20px 0;padding-left:20px;">
      <li>Do you recommend a different size for my ${spaceLabel.toLowerCase()}? Why?</li>
      <li>What brand and model do you typically install in this BTU range, and why?</li>
      <li>What's the warranty on parts and labor?</li>
      <li>Is permitting included in the quote? Electrical permits?</li>
      <li>What's the lead time from signed quote to installed?</li>
    </ul>

    ${(dimensions || insulation || sun) ? `
    <p style="font-size:13px;color:#6B7280;margin:0 0 6px 0;font-weight:600;">Your inputs</p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;color:#555;margin:0 0 20px 0;">
      ${dimensions ? `<tr><td style="padding:4px 0;">Dimensions</td><td style="padding:4px 0;text-align:right;color:#111;">${dimensions}${sqft ? ` (${fmt(sqft)} sq ft)` : ''}</td></tr>` : ''}
      ${insulation ? `<tr><td style="padding:4px 0;">Insulation</td><td style="padding:4px 0;text-align:right;color:#111;">${insulation}</td></tr>` : ''}
      ${sun ? `<tr><td style="padding:4px 0;">Afternoon sun</td><td style="padding:4px 0;text-align:right;color:#111;">${sun}</td></tr>` : ''}
    </table>
    ` : ''}

    <p style="font-size:12px;color:#888;line-height:1.5;margin:0 0 20px 0;">
      Estimate only. Sizing, costs, and unit-type recommendations are ballparks. Your licensed HVAC installer can give you a firm quote based on your specific home.
    </p>

    <p style="font-size:13px;color:#333;margin:0;">
      Change any inputs: <a href="${toolUrl}" style="color:#FF6B2B;text-decoration:underline;">${displayUrl}</a>
    </p>

  </div>
</body>
</html>`;
}
