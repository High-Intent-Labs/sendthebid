// Persona-1 (home / hiring / not_yet) enrollment helpers.
//
// Called from functions/api/email-capture.ts after a successful capture row
// is inserted. If the user qualifies for the persona, we insert 4 rows into
// email_sequence_queue with staggered scheduled_at timestamps. The scheduler
// (functions/api/email-scheduler.ts) handles delivery from there.

import type { SupabaseClient } from '@supabase/supabase-js';
import { PERSONA1_MANIFEST } from '../_generated/email-templates';

export const PERSONA1_KEY = 'home_hiring_not_yet';

// Day offsets for the 4 emails. The first one fires 30 min after capture
// so it doesn't collide with the transactional results email.
//
// 30 min, 3 days, 7 days, 14 days.
const PERSONA1_OFFSET_MINUTES: number[] = [30, 3 * 24 * 60, 7 * 24 * 60, 14 * 24 * 60];

export interface CaptureContext {
  email: string;
  segment: string | null;
  isDiy: boolean | null;
  contractorStage: string | null;
  toolSlug: string | null;
}

/** Returns true if this capture qualifies for persona1 enrollment. */
export function qualifiesForPersona1(c: CaptureContext): boolean {
  return (
    c.toolSlug === 'load-calculator' &&
    c.segment === 'home' &&
    c.isDiy === false &&
    c.contractorStage === 'not_yet'
  );
}

/**
 * Enroll a capture in the persona1 sequence. Idempotent — the unique index
 * (email, persona, email_number) makes re-enrollment a no-op for users who
 * resubmit the calculator. Suppresses enrollment if the user is on the
 * email_unsubscribes list.
 *
 * Logs failures but never throws — enrollment must not break the user-facing
 * capture flow. The scheduler tolerates partial enrollments (it'll send
 * whichever rows actually got inserted).
 */
export async function enrollPersona1(
  supabase: SupabaseClient,
  c: CaptureContext
): Promise<{ enrolled: boolean; reason?: string; rowCount?: number }> {
  if (!qualifiesForPersona1(c)) {
    return { enrolled: false, reason: 'not-qualified' };
  }

  // Suppression check — if they unsubscribed earlier, do not re-enroll.
  const { data: suppressRow, error: suppressErr } = await supabase
    .from('email_unsubscribes')
    .select('email')
    .eq('email', c.email)
    .limit(1);
  if (suppressErr) {
    console.error('persona1-enroll: suppression lookup failed', suppressErr);
    // Fail closed: skip enrollment. Better to under-enroll than to bypass an
    // unsubscribe due to a transient DB error.
    return { enrolled: false, reason: 'suppression-lookup-failed' };
  }
  if (suppressRow && suppressRow.length > 0) {
    return { enrolled: false, reason: 'suppressed' };
  }

  const now = Date.now();
  const rows = PERSONA1_MANIFEST.sequence.map((_, idx) => ({
    email: c.email,
    persona: PERSONA1_KEY,
    email_number: idx,
    scheduled_at: new Date(now + PERSONA1_OFFSET_MINUTES[idx] * 60_000).toISOString(),
    status: 'pending',
  }));

  // ON CONFLICT DO NOTHING — re-enrollments for the same persona+email_number
  // are silently ignored, preserving the original scheduled_at.
  const { error: insertErr, count } = await supabase
    .from('email_sequence_queue')
    .upsert(rows, { onConflict: 'email,persona,email_number', ignoreDuplicates: true, count: 'exact' });

  if (insertErr) {
    console.error('persona1-enroll: queue insert failed', insertErr);
    return { enrolled: false, reason: 'insert-failed' };
  }

  return { enrolled: true, rowCount: count ?? rows.length };
}

// ---------------------------------------------------------------------------
// Template-data builder
// ---------------------------------------------------------------------------
// Translates an email_captures row into the shape the Liquid templates expect.
// Lives here (not in template-engine.ts) because it's persona-specific —
// other personas may project from a different subset of calculation_data.

export interface CaptureRow {
  email: string;
  calculation_data: Record<string, unknown> | null;
}

const STATE_NAME_BY_ABBR: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
};

/**
 * Given an email_captures row + its calculation_data jsonb, project to the
 * shape the Liquid templates expect: { home, location, cta_url, rebate_lookup_url }.
 *
 * `cta_url` is per-email and built by the caller (the scheduler).
 */
export function buildPersona1TemplateData(
  capture: CaptureRow,
  emailNumber: number,
  ctaUrl: string
): Record<string, unknown> {
  const calc: Record<string, unknown> = capture.calculation_data ?? {};

  const stateAbbr = String(calc.state ?? '').toUpperCase();
  const stateName = STATE_NAME_BY_ABBR[stateAbbr] ?? stateAbbr;
  const stateSlug = stateAbbr.toLowerCase();

  const home = {
    sqft: numOr(calc.sqft, 0),
    cooling_btu: numOr(calc.coolingBTU, 0),
    heating_btu: numOr(calc.heatingBTU, 0),
    tonnage: numOr(calc.tonnage, 0),
    occupants: numOr(calc.occupants, 0),
    insulation: String(calc.insulation ?? 'Average'),
  };

  const location = {
    city: String(calc.city ?? ''),
    state: stateName,
    state_slug: stateSlug,
    climate_region: capitalize(String(calc.region ?? 'Mixed')),
    iecc_zone: String(calc.ieccZone ?? calc.iecc_zone ?? ''),
    design_temp_low: numOr(calc.designTempLow ?? calc.design_temp_low, 0),
    design_temp_high: numOr(calc.designTempHigh ?? calc.design_temp_high, 0),
  };

  const rebateLookupUrl = stateSlug
    ? `https://programs.dsireusa.org/system/program?state=${stateSlug}`
    : 'https://programs.dsireusa.org/';

  // emailNumber is currently unused but kept in the signature so future per-email
  // data shaping (e.g. rebate URL only on Day 7) stays a one-line change.
  void emailNumber;

  return {
    home,
    location,
    cta_url: ctaUrl,
    rebate_lookup_url: rebateLookupUrl,
  };
}

function numOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1).toLowerCase();
}
