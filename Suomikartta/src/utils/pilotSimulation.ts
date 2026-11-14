/**
 * Simulated pilot data for the units we don't physically have (everything except the
 * real board, sign-001). Clearly labelled "simulated" wherever it is shown.
 *
 * Deterministic: the same unit and day always give the same detections, so numbers
 * don't jump on reload. Patterns come from real data where we have it:
 *  - season: the site's real collisions per month (Ramboll 2021–2025)
 *  - time of day: deer and moose move most at dusk and dawn
 *  - volume: busier collision sites see more animals
 */
import type { CustomerSite, SiteUnit } from '../data/customerSites';

export interface Detection {
  event_id: string;
  device_id: string;
  site_id: string;
  ts: string; // ISO
  t: number; // ms
  class: 'warn_animal' | 'small_animal';
  confidence: number;
  warning: boolean;
  source: 'simulated' | 'camera' | 'upload' | 'knob';
  lat: number;
  lng: number;
  thumb?: string;
  status?: 'active' | 'done';
}

export interface UnitHealth {
  battery_pct: number;
  temp_c: number;
  camera_ok: boolean;
}

export const SIM_DAYS = 30;

// Relative activity by local hour: peaks around dusk (16–20) and dawn (5–8) in autumn.
const HOUR_WEIGHT = [
  0.5, 0.4, 0.35, 0.35, 0.5, 1.0, 1.6, 1.8, 1.2, 0.5, 0.3, 0.25,
  0.25, 0.3, 0.45, 0.9, 1.7, 2.2, 2.0, 1.5, 1.1, 0.9, 0.7, 0.6,
];
const HOUR_TOTAL = HOUR_WEIGHT.reduce((a, b) => a + b, 0);

function hash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number) {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function poisson(rand: () => number, lambda: number): number {
  const l = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k++;
    p *= rand();
  } while (p > l && k < 100);
  return k - 1;
}

function pickHour(rand: () => number): number {
  let x = rand() * HOUR_TOTAL;
  for (let h = 0; h < 24; h++) {
    x -= HOUR_WEIGHT[h];
    if (x <= 0) return h;
  }
  return 23;
}

/** Detections for one simulated unit over the last SIM_DAYS days, up to `now`. */
export function simulateUnit(site: CustomerSite, unit: SiteUnit, now: number): Detection[] {
  const monthTotal = site.collisions.byMonth.reduce((a, b) => a + b, 0) || 1;
  // Average day: ~1–3 animals per unit, more at busier collision sites.
  const base = 0.6 + (site.collisions.total / 100) * (0.5 + unit.nearby / 40);
  const out: Detection[] = [];
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  for (let d = SIM_DAYS - 1; d >= 0; d--) {
    const day = new Date(today.getTime() - d * 86_400_000);
    const seasonal = (site.collisions.byMonth[day.getMonth()] / monthTotal) * 12;
    const rand = rng(hash(`${unit.id}:${day.toDateString()}`));
    const n = poisson(rand, base * Math.max(0.3, seasonal));
    for (let i = 0; i < n; i++) {
      const t = new Date(day);
      t.setHours(pickHour(rand), Math.floor(rand() * 60), Math.floor(rand() * 60));
      if (t.getTime() > now) continue;
      const big = rand() < 0.68; // deer and moose vs foxes, hares, badgers
      const confidence = +(0.72 + rand() * 0.26).toFixed(2);
      out.push({
        event_id: `${unit.id}-${t.getTime()}`,
        device_id: unit.id,
        site_id: site.id,
        ts: t.toISOString(),
        t: t.getTime(),
        class: big ? 'warn_animal' : 'small_animal',
        confidence,
        warning: big,
        source: 'simulated',
        lat: unit.lat,
        lng: unit.lng,
      });
    }
  }
  return out;
}

// ---- Pilot outcome: collisions since install vs expected -------------------------------
// Pilot units went up on this date (demo assumption).
export const PILOT_START = new Date('2026-09-01T00:00:00+03:00').getTime();
const BASELINE_YEARS = 5; // 2021–2025
// ASSUMPTION for the simulated "actual": share of expected collisions the warnings prevent.
// Real pilots measure this; the radar site in PLAN.md went from 12 collisions to 0.
export const SIMULATED_EFFECT = 0.45;

const daysInMonth = (y: number, m: number) => new Date(y, m + 1, 0).getDate();

/**
 * Expected collisions at a site between `from` and `to`, from the real 2021–2025
 * monthly baseline (so it follows the season), and a simulated actual count.
 */
export function pilotOutcome(site: CustomerSite, from: number, to: number) {
  let expected = 0;
  let actual = 0;
  const d = new Date(from);
  while (d.getTime() < to) {
    const y = d.getFullYear();
    const m = d.getMonth();
    const monthEnd = new Date(y, m + 1, 1).getTime();
    const sliceEnd = Math.min(monthEnd, to);
    const days = (sliceEnd - d.getTime()) / 86_400_000;
    const perDay = site.collisions.byMonth[m] / BASELINE_YEARS / daysInMonth(y, m);
    const exp = perDay * days;
    expected += exp;
    // Simulated: whole collisions per month, seeded so it doesn't change on reload.
    const rand = rng(hash(`collisions:${site.id}:${y}-${m}`));
    actual += poisson(rand, exp * (1 - SIMULATED_EFFECT));
    d.setTime(sliceEnd);
  }
  return { expected, actual };
}

export function simulateHealth(unit: SiteUnit): UnitHealth {
  const rand = rng(hash(`health:${unit.id}`));
  return {
    battery_pct: Math.round(12 + rand() * 86),
    temp_c: +(-3 + rand() * 6).toFixed(1),
    camera_ok: true,
  };
}
