// Cloudflare Function backing the admin load-calculator deep-dive
// (PostHog side). Parallel to mini-split-analytics.ts — same 3 queries
// (funnel / help / A/B), different tool_slug + experiment name +
// help-field label mapping.
//
// POST /api/admin/load-analytics
// body: { password, startDate, endDate }
//   - password:  the admin password (same as the existing admin portal)
//   - startDate: 'YYYY-MM-DD' — inclusive lower bound for events; if missing,
//                defaults to all-time. If present, endDate must also be present.
//   - endDate:   'YYYY-MM-DD' — inclusive upper bound for events.
//
// Returns { funnel, help, ab } where each is the raw PostHog query response
// shape. Frontend normalizes + renders. Separate queries (not one combined)
// so each can be reasoned about independently and a failure in one doesn't
// fail the others.
//
// Requires Cloudflare Pages env var POSTHOG_PERSONAL_API_KEY — already set
// for the mini-split deep-dive; reused here.

interface AnalyticsEnv {
  POSTHOG_PERSONAL_API_KEY?: string;
}

const ADMIN_PASSWORD = 'nailthequoteangi26'; // matches admin portal + RPC
const POSTHOG_PROJECT_ID = '151664';          // NTQ EU project
const POSTHOG_HOST = 'https://eu.posthog.com';
const TOOL_SLUG = 'load-calculator';
const AB_EXPERIMENT = 'lc_gate_copy';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

    // 5-step user journey, unique persons per step
    const funnelQuery = `
      SELECT
        count(DISTINCT if(event = 'tool_viewed',      person_id, NULL)) AS landed,
        count(DISTINCT if(event = 'tool_used',        person_id, NULL)) AS started,
        count(DISTINCT if(event = 'segment_shown',    person_id, NULL)) AS calculated,
        count(DISTINCT if(event = 'segment_picked',   person_id, NULL)) AS picked_segment,
        count(DISTINCT if(event = 'email_captured',   person_id, NULL)) AS submitted_email
      FROM events
      WHERE properties.tool_slug = '${TOOL_SLUG}'
        AND event IN ('tool_viewed','tool_used','segment_shown','segment_picked','email_captured')
        ${dc}
    `.trim();

    const helpQuery = `
      SELECT properties.field AS field, count() AS opens
      FROM events
      WHERE event = 'help_opened'
        AND properties.tool_slug = '${TOOL_SLUG}'
        ${dc}
      GROUP BY field
      ORDER BY opens DESC
    `.trim();

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

    const [funnelR, helpR, abR] = await Promise.allSettled([
      runHogQL(apiKey, funnelQuery),
      runHogQL(apiKey, helpQuery),
      runHogQL(apiKey, abQuery),
    ]);

    return json({
      funnel: funnelR.status === 'fulfilled' ? funnelR.value : { error: String(funnelR.reason) },
      help:   helpR.status   === 'fulfilled' ? helpR.value   : { error: String(helpR.reason) },
      ab:     abR.status     === 'fulfilled' ? abR.value     : { error: String(abR.reason) },
    });
  } catch (err) {
    console.error('load-analytics error:', err);
    return json({ error: String(err) }, 500);
  }
};
