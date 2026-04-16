// Cloudflare Function backing the admin AC-size deep-dive (PostHog side).
//
// POST /api/admin/ac-size-analytics
// body: { password, startDate, endDate }
//   - password:  the admin password (same as the existing admin portal)
//   - startDate: 'YYYY-MM-DD' — inclusive lower bound for events; if missing,
//                defaults to all-time. If present, endDate must also be present.
//   - endDate:   'YYYY-MM-DD' — inclusive upper bound for events.
//
// Returns { funnel, ab, help, space, unit } where each is the raw PostHog
// query response shape. Frontend normalizes + renders. Separate queries
// (not one combined) so each can be reasoned about independently and a
// failure in one doesn't fail the others.
//
// Consumer-specific shape:
//   - Funnel has 5 steps (no segment_picked — single audience), ending on
//     installer_match_clicked which is the money metric for this tool.
//   - A/B has 3 variants (A/B/C) — copy test on email-gate headlines.
//   - Help queries by `help_id` (not `field` like the pro tools) — consumer
//     calc wires its help buttons with a `help_id` payload key.
//   - Space breakdown: which rooms are users sizing for. Tracks both
//     "reached a result" (gate_shown ∪ gate_skipped_low_value) and
//     "submitted email" so we can read conversion per space.
//   - Unit-type breakdown: what are we recommending, and how does that
//     split between the email gate and the low-value skip (window /
//     portable recs bypass the gate — see ac-size-for-my-room.astro).
//     If the skip column is too aggressive we'll see it here.
//
// Requires Cloudflare Pages env var POSTHOG_PERSONAL_API_KEY — already
// set for the mini-split + load-calc analytics functions.

interface AnalyticsEnv {
  POSTHOG_PERSONAL_API_KEY?: string;
}

const ADMIN_PASSWORD = 'nailthequoteangi26'; // matches admin portal + RPC
const POSTHOG_PROJECT_ID = '151664';          // NTQ EU project
const POSTHOG_HOST = 'https://eu.posthog.com';
const TOOL_SLUG = 'ac-size-for-my-room';
const AB_EXPERIMENT = 'acsize_gate_copy';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Builds a date clause for a HogQL query. If both dates are blank, returns
// an empty clause (all-time). If only one is set, treats the other as
// unbounded on that side.
function dateClause(start?: string, end?: string): string {
  const parts: string[] = [];
  if (start && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
    parts.push(`toDate(timestamp) >= toDate('${start}')`);
  }
  if (end && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
    parts.push(`toDate(timestamp) <= toDate('${end}')`);
  }
  return parts.length ? 'AND ' + parts.join(' AND ') : '';
}

async function runHogQL(apiKey: string, query: string): Promise<any> {
  const res = await fetch(`${POSTHOG_HOST}/api/projects/${POSTHOG_PROJECT_ID}/query/`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query: { kind: 'HogQLQuery', query },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`PostHog ${res.status}: ${text.slice(0, 300)}`);
  }
  return await res.json();
}

export const onRequestPost: PagesFunction<AnalyticsEnv> = async (context) => {
  try {
    const body: any = await context.request.json();
    const { password, startDate, endDate } = body ?? {};

    if (password !== ADMIN_PASSWORD) {
      return json({ error: 'Unauthorized' }, 401);
    }

    const apiKey = context.env.POSTHOG_PERSONAL_API_KEY;
    if (!apiKey) {
      return json({
        error: 'POSTHOG_PERSONAL_API_KEY not configured on the Cloudflare Pages project',
      }, 500);
    }

    const dc = dateClause(startDate, endDate);

    // Funnel — 5 steps for the consumer flow.
    // landed (tool_viewed) → started (tool_used) → calculated
    // (either gate_shown for pro-grade recs OR gate_skipped_low_value
    // for window/portable recs) → emailed (email_captured) → clicked
    // installer (installer_match_clicked, the ultimate Angi-lead metric).
    const funnelQuery = `
      SELECT
        count(DISTINCT if(event = 'tool_viewed',                            person_id, NULL)) AS landed,
        count(DISTINCT if(event = 'tool_used',                              person_id, NULL)) AS started,
        count(DISTINCT if(event IN ('gate_shown','gate_skipped_low_value'), person_id, NULL)) AS calculated,
        count(DISTINCT if(event = 'email_captured',                         person_id, NULL)) AS emailed,
        count(DISTINCT if(event = 'installer_match_clicked',                person_id, NULL)) AS clicked_installer
      FROM events
      WHERE properties.tool_slug = '${TOOL_SLUG}'
        AND event IN ('tool_viewed','tool_used','gate_shown','gate_skipped_low_value','email_captured','installer_match_clicked')
        ${dc}
    `.trim();

    // A/B/C conversion per variant — gate_shown fires when the email gate
    // appears; email_captured when the user completes the gate. 3 arms.
    const abQuery = `
      SELECT
        properties.ab_variant AS variant,
        countIf(event = 'gate_shown')     AS gate_shown,
        countIf(event = 'email_captured') AS captured,
        round(
          100.0 * countIf(event = 'email_captured')
          / nullIf(countIf(event = 'gate_shown'), 0),
          1
        ) AS cvr_pct
      FROM events
      WHERE properties.experiment = '${AB_EXPERIMENT}'
        ${dc}
      GROUP BY variant
      ORDER BY variant
    `.trim();

    // Help-button opens, broken down by help_id.
    // NOTE: consumer calc uses `help_id` in the payload; pro calcs use
    // `field`. Kept separate on purpose — field labels differ anyway.
    const helpQuery = `
      SELECT properties.help_id AS help_id, count() AS opens
      FROM events
      WHERE event = 'help_opened'
        AND properties.tool_slug = '${TOOL_SLUG}'
        ${dc}
      GROUP BY help_id
      ORDER BY opens DESC
    `.trim();

    // Space breakdown — which rooms are users sizing for and how do they
    // convert. "calculated" = reached a recommendation (either gate or
    // low-value skip); "emailed" = submitted email (only possible via
    // the gate path).
    const spaceQuery = `
      SELECT
        properties.space AS space,
        count(DISTINCT if(event IN ('gate_shown','gate_skipped_low_value'), person_id, NULL)) AS calculated,
        count(DISTINCT if(event = 'email_captured', person_id, NULL)) AS emailed
      FROM events
      WHERE properties.tool_slug = '${TOOL_SLUG}'
        AND event IN ('gate_shown','gate_skipped_low_value','email_captured')
        AND properties.space IS NOT NULL
        ${dc}
      GROUP BY space
      ORDER BY calculated DESC
    `.trim();

    // Unit-type breakdown — what are we recommending and what path does
    // each recommendation take. gate_shown + gate_skipped are mutually
    // exclusive events (one or the other fires per calculation). If
    // gate_skipped rate is >90% for a unit_type that isn't window/
    // portable, something is off with the routing logic.
    const unitQuery = `
      SELECT
        properties.recommended_unit_type AS unit_type,
        countIf(event = 'gate_shown')             AS gate_shown,
        countIf(event = 'gate_skipped_low_value') AS gate_skipped,
        countIf(event = 'email_captured')         AS emailed
      FROM events
      WHERE properties.tool_slug = '${TOOL_SLUG}'
        AND event IN ('gate_shown','gate_skipped_low_value','email_captured')
        AND properties.recommended_unit_type IS NOT NULL
        ${dc}
      GROUP BY unit_type
      ORDER BY (gate_shown + gate_skipped) DESC
    `.trim();

    // Run in parallel. If any single one fails, include the error and
    // let the frontend render what it has.
    const [funnelR, abR, helpR, spaceR, unitR] = await Promise.allSettled([
      runHogQL(apiKey, funnelQuery),
      runHogQL(apiKey, abQuery),
      runHogQL(apiKey, helpQuery),
      runHogQL(apiKey, spaceQuery),
      runHogQL(apiKey, unitQuery),
    ]);

    return json({
      funnel: funnelR.status === 'fulfilled' ? funnelR.value : { error: String(funnelR.reason) },
      ab:     abR.status     === 'fulfilled' ? abR.value     : { error: String(abR.reason) },
      help:   helpR.status   === 'fulfilled' ? helpR.value   : { error: String(helpR.reason) },
      space:  spaceR.status  === 'fulfilled' ? spaceR.value  : { error: String(spaceR.reason) },
      unit:   unitR.status   === 'fulfilled' ? unitR.value   : { error: String(unitR.reason) },
    });
  } catch (err) {
    console.error('ac-size-analytics error:', err);
    return json({ error: String(err) }, 500);
  }
};
