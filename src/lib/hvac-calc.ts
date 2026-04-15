// Shared HVAC load-calculation formulas for the two tools.
// Both formulas are simplified "pre-quote" estimates — NOT a full ACCA Manual J.
// The coefficient system follows ServiceTitan's public calculator; the room-level
// formula adds geometry, orientation, and exposure factors for mini-split sizing.

import type { ClimateLookup } from './climate';

// ---------------------------------------------------------------------------
// Whole-house formula
// ---------------------------------------------------------------------------

export type InsulationGrade = 'excellent' | 'better' | 'average' | 'worse' | 'bad';
export type SunExposure = 'lots' | 'medium' | 'little';
export type WindowAmount = 'standard' | 'many';
export type Tightness = 'sealed' | 'typical' | 'leaky';

export interface WholeHouseInputs {
  climate: ClimateLookup;
  sqft: number;
  ceilingHeight: number;
  insulation: InsulationGrade;
  sun: SunExposure;
  windows: WindowAmount;
  tightness: Tightness;
  occupants: number;         // headcount (2, 3, 4, 5, 6)
  deviceWatts: number;       // total extra device wattage
  kitchen: boolean;
}

export interface WholeHouseResult {
  coolingBTU: number;
  heatingBTU: number;
  tonnage: number;
}

const INSULATION_COEF: Record<InsulationGrade, number> = {
  excellent: -0.10, better: -0.05, average: 0, worse: 0.05, bad: 0.10,
};
const SUN_COEF: Record<SunExposure, number> = {
  lots: 0.08, medium: 0, little: -0.08,
};
const WINDOWS_COEF: Record<WindowAmount, number> = {
  standard: 0, many: 0.10,
};
const TIGHTNESS_COEF: Record<Tightness, number> = {
  sealed: -0.08, typical: 0, leaky: 0.08,
};

export function calcWholeHouse(i: WholeHouseInputs): WholeHouseResult {
  const heightMult = i.ceilingHeight / 8;
  const base = i.sqft * 20 * heightMult;
  const modSum = i.climate.zoneCoef
    + INSULATION_COEF[i.insulation]
    + SUN_COEF[i.sun]
    + WINDOWS_COEF[i.windows]
    + TIGHTNESS_COEF[i.tightness];
  const adjustedBase = base * (1 + modSum);
  const occupantBTU = Math.max(0, i.occupants - 2) * 600;   // 2 or less = baseline; each additional = +600
  const deviceBTU = i.deviceWatts * 3.412;
  const kitchenBonus = i.kitchen ? 4000 : 0;

  const coolingBTU = Math.round(adjustedBase + occupantBTU + deviceBTU + kitchenBonus);
  const heatingBTU = Math.round(coolingBTU * i.climate.heatingFactor);
  const tonnage = Math.round((coolingBTU / 12000) * 2) / 2;  // 0.5 ton rounding

  return { coolingBTU, heatingBTU, tonnage };
}

// ---------------------------------------------------------------------------
// Single-room / mini-split formula
// ---------------------------------------------------------------------------

export type RoomType =
  | 'bedroom' | 'living' | 'kitchen' | 'bathroom'
  | 'office' | 'dining' | 'other';
export type Orientation = 'N' | 'E' | 'S' | 'W';
export type ExposedWalls = 1 | 2 | 3 | 4;
export type RoomInsulation = 'excellent' | 'good' | 'average' | 'poor' | 'bad';

export interface RoomInputs {
  climate: ClimateLookup;
  roomType: RoomType;
  length: number;
  width: number;
  ceilingHeight: number;
  exposedWalls: ExposedWalls;
  orientation: Orientation;
  windowAreaSqFt: number;
  doorAreaSqFt: number;
  insulation: RoomInsulation;
}

export interface RoomResult {
  coolingBTU: number;
  heatingBTU: number;
  tonnage: number;
  closestStandardBTU: number;
  closestStandardLabel: string;   // e.g. "12,000 BTU mini-split"
  suggestedCFM: number;
  sqft: number;
  volume: number;
}

const EXPOSED_FACTOR: Record<ExposedWalls, number> = { 1: 0.85, 2: 1.0, 3: 1.15, 4: 1.25 };
const ORIENT_FACTOR: Record<Orientation, number> = { N: 0.95, E: 1.0, W: 1.10, S: 1.15 };
const ROOM_INS_FACTOR: Record<RoomInsulation, number> = {
  excellent: 0.85, good: 0.92, average: 1.0, poor: 1.15, bad: 1.30,
};
const ROOM_INTERNAL_BTU: Record<RoomType, number> = {
  bedroom: 460, living: 1400, kitchen: 4460, bathroom: 230,
  office: 700, dining: 920, other: 700,
};

// Standard mini-split sizes (BTU)
const STANDARD_SIZES = [9000, 12000, 18000, 24000, 36000];

function closestStandard(btu: number): number {
  return STANDARD_SIZES.reduce((best, s) =>
    Math.abs(s - btu) < Math.abs(best - btu) ? s : best,
    STANDARD_SIZES[0],
  );
}

export function calcRoom(i: RoomInputs): RoomResult {
  const sqft = i.length * i.width;
  const volume = sqft * i.ceilingHeight;
  const base = sqft * 25;
  const heightMult = i.ceilingHeight / 8;
  const expF = EXPOSED_FACTOR[i.exposedWalls];
  const oriF = ORIENT_FACTOR[i.orientation];
  const insF = ROOM_INS_FACTOR[i.insulation];
  const winLoad = i.windowAreaSqFt * 870;
  const doorLoad = i.doorAreaSqFt * 50;
  const internal = ROOM_INTERNAL_BTU[i.roomType];
  const climateMult = 1 + i.climate.zoneCoef;

  const coolingRaw = (base * heightMult * expF * oriF * insF + winLoad + doorLoad + internal) * climateMult;
  const coolingBTU = Math.round(coolingRaw);
  const heatingBTU = Math.round(coolingBTU * i.climate.heatingFactor);
  const tonnage = Math.round((coolingBTU / 12000) * 4) / 4;  // 0.25 ton rounding
  const closest = closestStandard(coolingBTU);
  const closestLabel = `${(closest / 1000).toFixed(0)},000 BTU mini-split`;
  const suggestedCFM = Math.round(coolingBTU / 30);

  return {
    coolingBTU,
    heatingBTU,
    tonnage,
    closestStandardBTU: closest,
    closestStandardLabel: closestLabel,
    suggestedCFM,
    sqft,
    volume,
  };
}
