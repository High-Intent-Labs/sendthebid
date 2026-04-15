// Shared climate lookup for HVAC sizing tools.
// Maps a US ZIP code → one of 5 climate regions, plus region coefficients
// used by the cooling/heating load formulas.

import zipData from '../data/zip-climate.json';

export type Region = 'hot' | 'warm' | 'mixed' | 'cool' | 'cold';

export interface ClimateLookup {
  zip3: string;
  state: string;
  region: Region;
  regionLabel: string;   // "Hot", "Warm", "Mixed", "Cool", "Cold"
  zoneCoef: number;      // +0.10 to -0.10, applied to cooling base
  heatingFactor: number; // multiplier on coolingBTU to estimate heatingBTU
}

// Region metadata — coefficients reproduce ServiceTitan's modifiers and
// heating factors extend the pattern to cold zones.
export const REGIONS: Record<Region, { label: string; zoneCoef: number; heatingFactor: number }> = {
  hot:   { label: 'Hot',   zoneCoef:  0.10, heatingFactor: 0.70 },
  warm:  { label: 'Warm',  zoneCoef:  0.05, heatingFactor: 0.90 },
  mixed: { label: 'Mixed', zoneCoef:  0.00, heatingFactor: 1.10 },
  cool:  { label: 'Cool',  zoneCoef: -0.05, heatingFactor: 1.25 },
  cold:  { label: 'Cold',  zoneCoef: -0.10, heatingFactor: 1.45 },
};

// Narrow typing for the imported JSON
const DATA = zipData as Record<string, { state: string; region: Region }>;

/**
 * Look up a ZIP code (5 digits, or just ZIP3 prefix).
 * Returns null if the ZIP3 isn't in the mapping — caller should show the
 * manual region picker fallback.
 */
export function lookupZip(zip: string): ClimateLookup | null {
  const zip3 = zip.trim().slice(0, 3);
  if (!/^\d{3}$/.test(zip3)) return null;
  const entry = DATA[zip3];
  if (!entry) return null;
  const meta = REGIONS[entry.region];
  return {
    zip3,
    state: entry.state,
    region: entry.region,
    regionLabel: meta.label,
    zoneCoef: meta.zoneCoef,
    heatingFactor: meta.heatingFactor,
  };
}

/**
 * Build a ClimateLookup from a user-picked region (fallback path when the
 * ZIP isn't recognized).
 */
export function lookupRegion(region: Region, zip: string, state: string = ''): ClimateLookup {
  const meta = REGIONS[region];
  return {
    zip3: zip.slice(0, 3),
    state,
    region,
    regionLabel: meta.label,
    zoneCoef: meta.zoneCoef,
    heatingFactor: meta.heatingFactor,
  };
}
