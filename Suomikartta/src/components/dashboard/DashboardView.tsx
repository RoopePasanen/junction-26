/**
 * Customer dashboard: what a regional road authority sees once our units are installed.
 *
 * Real data: collisions per site (Ramboll 2021–2025) and the live board (sign-001).
 * Simulated data (labelled): detections from the other pilot units.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BatteryLow,
  BatteryMedium,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Moon,
  Radio,
  Sun,
  Sunrise,
  TrendingDown,
  WifiOff,
  Wrench,
  X,
} from 'lucide-react';
import {
  CUSTOMER_SITES,
  DATA_SOURCE,
  DATA_SOURCE_URL,
  REGION,
  REGION_HEAT,
  type CustomerSite,
} from '../../data/customerSites';
import {
  PILOT_START,
  SIM_DAYS,
  pilotOutcome,
  simulateHealth,
  simulateUnit,
  type Detection,
} from '../../utils/pilotSimulation';
import { useLiveEvents } from '../LiveUnitsLayer';
import { BarChart, HBarList } from './BarChart';
import { DetectionAlert } from './DetectionAlert';
import { SiteMap, type MapUnit } from './SiteMap';

// ---- Settings ----------------------------------------------------------------------
const MASALA = CUSTOMER_SITES.find((s) => s.id === 'kirkkonummi')!;

// Customers the dashboard can show. Open one directly with ?customer=<id>.
//  - uusimaa: the full regional pilot (1 real board + 17 simulated units)
//  - demo:    only the real board at Masala, nothing simulated (live demo)
const CUSTOMERS = [
  { id: 'uusimaa', name: 'Uusimaa road region', sites: CUSTOMER_SITES },
  {
    id: 'demo',
    name: 'Kirkkonummi municipality',
    sites: [{ ...MASALA, units: MASALA.units.filter((u) => u.real) }],
  },
] satisfies Array<{ id: string; name: string; sites: CustomerSite[] }>;
type Customer = (typeof CUSTOMERS)[number];

function initialCustomer(): Customer {
  let id = new URLSearchParams(window.location.search).get('customer');
  if (!id) {
    try {
      id = localStorage.getItem('dashboard-customer');
    } catch {
      // storage blocked
    }
  }
  return CUSTOMERS.find((c) => c.id === id) ?? CUSTOMERS[0];
}

const ALERT_SHOW_MS = 30_000; // the big "deer detected" pop-up closes by itself after this
const RADAR_PER_SITE_EUR = 40_000; // InnoTrafik radar warning site (PLAN.md)
const UNIT_PRICE_EUR = 1_500; // ASSUMPTION: our unit installed. Replace with the real BOM + install cost.
const LAST_FULL_YEAR = '2025';

const SPECIES_LABEL: Record<string, string> = {
  whiteTailedDeer: 'White-tailed deer',
  roeDeer: 'Roe deer',
  moose: 'Moose',
  fallowDeer: 'Fallow deer',
  forestReindeer: 'Forest reindeer',
};
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const fmt = (n: number) => n.toLocaleString('fi-FI');

function sumStats(sites: CustomerSite[]) {
  const byYear: Record<string, number> = {};
  const bySpecies: Record<string, number> = {};
  const byMonth = Array(12).fill(0) as number[];
  for (const s of sites) {
    for (const [y, n] of Object.entries(s.collisions.byYear)) byYear[y] = (byYear[y] ?? 0) + n;
    for (const [k, n] of Object.entries(s.collisions.bySpecies)) bySpecies[k] = (bySpecies[k] ?? 0) + n;
    s.collisions.byMonth.forEach((n, i) => (byMonth[i] += n));
  }
  return { byYear, bySpecies, byMonth, total: sites.reduce((a, s) => a + s.collisions.total, 0) };
}

function useUnitStatus() {
  const [status, setStatus] = useState<{ boardOnline: boolean; lastSeen: Record<string, string> }>({
    boardOnline: false,
    lastSeen: {},
  });
  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch('/api/units')
        .then((r) => r.json())
        .then((d) => alive && setStatus({ boardOnline: !!d.board?.online, lastSeen: d.lastSeen ?? {} }))
        .catch(() => alive && setStatus((s) => ({ ...s, boardOnline: false })));
    load();
    const id = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  return status;
}

export function DashboardView() {
  const [customer, setCustomer] = useState<Customer>(initialCustomer);
  const sites: CustomerSite[] = customer.sites;
  const [now, setNow] = useState(() => Date.now());
  const [selectedSiteId, setSelectedSiteId] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ point: { lat: number; lng: number }; zoom: number; key: number } | null>(null);
  const { events: liveEvents, connection, latestAlert, dismissAlert } = useLiveEvents();
  const unitStatus = useUnitStatus();

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!latestAlert) return;
    const id = setTimeout(dismissAlert, ALERT_SHOW_MS);
    return () => clearTimeout(id);
  }, [latestAlert]); // eslint-disable-line react-hooks/exhaustive-deps

  const unitIndex = useMemo(() => {
    const m = new Map<string, { site: CustomerSite; lat: number; lng: number; real: boolean }>();
    for (const s of sites) for (const u of s.units) m.set(u.id, { site: s, lat: u.lat, lng: u.lng, real: u.real });
    return m;
  }, [customer.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Simulated history, recomputed once per hour bucket so it stays stable.
  const hourBucket = Math.floor(now / 3_600_000);
  const simulated = useMemo(() => {
    const t = Date.now();
    return sites.flatMap((s) => s.units.filter((u) => !u.real).flatMap((u) => simulateUnit(s, u, t)));
  }, [hourBucket, customer.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const unitCount = sites.reduce((a, s) => a + s.units.length, 0);
  const simulatedCount = sites.reduce((a, s) => a + s.units.filter((u) => !u.real).length, 0);
  const detTag = simulatedCount > 0 ? 'pilot' : 'real'; // detections: simulated or all from the real board

  const switchCustomer = (id: string) => {
    const c = CUSTOMERS.find((x) => x.id === id) ?? CUSTOMERS[0];
    setCustomer(c);
    setSelectedSiteId(null);
    setFocus(null);
    try {
      localStorage.setItem('dashboard-customer', c.id);
    } catch {
      // storage blocked
    }
    const url = new URL(window.location.href);
    url.searchParams.set('customer', c.id);
    window.history.replaceState(null, '', url);
  };

  // Only alert for this customer's own units.
  const alert = latestAlert && unitIndex.has(latestAlert.device_id) ? latestAlert : null;
  const mapRef = useRef<HTMLDivElement>(null);
  const showOnMap = (deviceId: string) => {
    const u = unitIndex.get(deviceId);
    if (u) {
      setSelectedSiteId(u.site.id);
      setFocus({ point: { lat: u.lat, lng: u.lng }, zoom: 15, key: Date.now() });
    }
    dismissAlert();
    mapRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // Real detections from the board, placed at the unit's position on the map.
  const real: Detection[] = useMemo(
    () =>
      liveEvents
        .filter((e) => e.class !== 'no_animal')
        .map((e) => {
          const u = unitIndex.get(e.device_id);
          const t = new Date(e.ts).getTime();
          return {
            event_id: e.event_id,
            device_id: e.device_id,
            site_id: u?.site.id ?? 'unknown',
            ts: e.ts,
            t: Number.isNaN(t) ? Date.now() : t,
            class: e.class === 'warn_animal' ? 'warn_animal' : 'small_animal',
            confidence: e.confidence,
            warning: e.warning,
            source: (e.source as Detection['source']) ?? 'camera',
            lat: u?.lat ?? e.lat,
            lng: u?.lng ?? e.lng,
            thumb: e.thumb,
            status: e.status,
          } satisfies Detection;
        }),
    [liveEvents, unitIndex]
  );

  const since = now - SIM_DAYS * 86_400_000;
  const allDetections = useMemo(
    () => [...simulated, ...real].filter((d) => d.t >= since).sort((a, b) => b.t - a.t),
    [simulated, real, since]
  );

  const selectedSite = sites.find((s) => s.id === selectedSiteId) ?? null;
  const scopeSites = selectedSite ? [selectedSite] : sites;
  const detections = selectedSite ? allDetections.filter((d) => d.site_id === selectedSite.id) : allDetections;
  const collisions = useMemo(() => sumStats(scopeSites), [selectedSiteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const realOnline = (id: string) =>
    unitStatus.boardOnline ||
    (unitStatus.lastSeen[id] ? now - new Date(unitStatus.lastSeen[id]).getTime() < 10 * 60_000 : false);

  const beaconUnits = new Set(
    real.filter((d) => d.status === 'active' && d.warning).map((d) => d.device_id)
  );

  const mapUnits: MapUnit[] = sites.flatMap((s) =>
    s.units.map((u) => ({
      id: u.id,
      siteId: s.id,
      lat: u.lat,
      lng: u.lng,
      real: u.real,
      online: u.real ? realOnline(u.id) : true,
      beaconOn: beaconUnits.has(u.id),
      detections: allDetections.filter((d) => d.device_id === u.id).length,
    }))
  );
  const scopeUnits = mapUnits.filter((u) => !selectedSite || u.siteId === selectedSite.id);
  const onlineCount = scopeUnits.filter((u) => u.online).length;

  const lastYear = collisions.byYear[LAST_FULL_YEAR] ?? 0;
  const prevYears = ['2021', '2022', '2023', '2024'].map((y) => collisions.byYear[y] ?? 0);
  const prevAvg = prevYears.reduce((a, b) => a + b, 0) / prevYears.length;

  // Detections by hour of day
  const byHour = Array(24).fill(0) as number[];
  for (const d of detections) byHour[new Date(d.t).getHours()]++;
  const hourNow = new Date(now).getHours();
  const monthNow = new Date(now).getMonth();

  // Risk right now: season (real collisions this month) x time of day (detections this hour)
  const monthShare = collisions.byMonth[monthNow] / (collisions.total || 1);
  const hourShare = byHour[hourNow] / (detections.length || 1);
  const riskScore = monthShare * 12 * (hourShare * 24);
  const risk = riskScore > 2 ? 'High' : riskScore > 0.9 ? 'Elevated' : 'Normal';
  const lastHour = allDetections.filter((d) => now - d.t < 3_600_000 && (!selectedSite || d.site_id === selectedSite.id));

  const roadKm = scopeSites.reduce((a, s) => a + (s.roadKm ?? 0), 0);
  const roadKmText =
    roadKm > 0 ? `${roadKm.toLocaleString('fi-FI', { maximumFractionDigits: roadKm < 20 ? 1 : 0 })} km of road` : null;

  const radarCost = scopeSites.length * RADAR_PER_SITE_EUR;
  const ourCost = scopeUnits.length * UNIT_PRICE_EUR;

  // Pilot outcome: collisions since install vs expected from the real baseline.
  const dayBucket = Math.floor(now / 86_400_000);
  const outcome = useMemo(() => {
    const t = Date.now();
    return scopeSites.reduce(
      (acc, s) => {
        const o = pilotOutcome(s, PILOT_START, t);
        return { expected: acc.expected + o.expected, actual: acc.actual + o.actual };
      },
      { expected: 0, actual: 0 }
    );
  }, [selectedSiteId, dayBucket]); // eslint-disable-line react-hooks/exhaustive-deps
  const outcomeChange = outcome.expected > 0 ? (outcome.actual - outcome.expected) / outcome.expected : 0;
  const pilotWeeks = Math.max(1, Math.round((now - PILOT_START) / (7 * 86_400_000)));
  const pilotStartText = new Date(PILOT_START).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

  // This week
  const weekAgo = now - 7 * 86_400_000;
  const week = detections.filter((d) => d.t >= weekAgo);
  const weekWarnings = week.filter((d) => d.warning).length;
  const weekByHour = Array(24).fill(0) as number[];
  for (const d of week) weekByHour[new Date(d.t).getHours()]++;
  let peakHour = 0;
  for (let h = 0; h < 24; h++) {
    if (weekByHour[h] + weekByHour[(h + 1) % 24] > weekByHour[peakHour] + weekByHour[(peakHour + 1) % 24]) peakHour = h;
  }
  const deerBySite = new Map<string, number>();
  for (const d of week) if (d.class === 'warn_animal') deerBySite.set(d.site_id, (deerBySite.get(d.site_id) ?? 0) + 1);
  const topSiteId = [...deerBySite.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const topSite = sites.find((s) => s.id === topSiteId);

  // Needs attention: offline units, low batteries.
  const attention: Array<{ unit: string; site: string; text: string; kind: 'offline' | 'battery' }> = [];
  for (const u of scopeUnits) {
    const siteName = sites.find((s) => s.id === u.siteId)?.name ?? '';
    if (!u.online) attention.push({ unit: u.id, site: siteName, text: u.real ? 'offline (real board)' : 'offline', kind: 'offline' });
    if (!u.real) {
      const h = simulateHealth({ id: u.id, real: false, lat: 0, lng: 0, nearby: 0 });
      if (h.battery_pct < 25) attention.push({ unit: u.id, site: siteName, text: `battery ${h.battery_pct}%`, kind: 'battery' });
    }
  }

  const selectSite = (id: string | null) => {
    setSelectedSiteId(id);
    const s = sites.find((x) => x.id === id);
    if (s) setFocus({ point: s.center, zoom: 13, key: Date.now() });
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-slate-50">
      {/* Beacon alert: big pop-up the moment a unit turns its beacon on */}
      {alert && (
        <DetectionAlert
          key={alert.event_id}
          event={alert}
          siteName={unitIndex.get(alert.device_id)?.site.name ?? alert.device_id}
          showMs={ALERT_SHOW_MS}
          onShowOnMap={() => showOnMap(alert.device_id)}
          onClose={dismissAlert}
        />
      )}

      {/* Header */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3 sm:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
            Wildlife warning pilot
            {simulatedCount > 0 ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-amber-800">
                {simulatedCount} of {unitCount} units simulated
              </span>
            ) : (
              <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-emerald-800">
                {unitCount === 1 ? '1 real unit' : `${unitCount} real units`} · live
              </span>
            )}
          </div>
          <h1 className="flex min-w-0 items-center text-xl font-bold tracking-tight text-slate-950">
            <label className="relative inline-flex min-w-0 items-center">
              <span className="sr-only">Customer</span>
              <select
                value={customer.id}
                onChange={(e) => switchCustomer(e.target.value)}
                className="min-w-0 cursor-pointer appearance-none truncate rounded-md bg-transparent pr-6 font-bold hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
              >
                {CUSTOMERS.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-0 h-4 w-4 text-slate-400" />
            </label>
            {selectedSite && (
              <span className="text-slate-400">
                {' '}
                <ChevronRight className="inline h-5 w-5" /> {selectedSite.name}
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-3">
          {selectedSite && (
            <button
              type="button"
              onClick={() => setSelectedSiteId(null)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
            >
              <X className="h-3.5 w-3.5" /> All sites
            </button>
          )}
          <span className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600">
            <span
              className={`h-2 w-2 rounded-full ${
                connection === 'live' ? 'animate-pulse bg-emerald-500' : connection === 'offline' ? 'bg-red-500' : 'bg-slate-400'
              }`}
            />
            {connection === 'live' ? 'Live' : connection === 'offline' ? 'Reconnecting' : 'Connecting'}
            <span className="text-slate-400">·</span>
            {new Date(now).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </span>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[1600px] space-y-4 p-4 sm:p-5">

          {/* Hero: result, activity, what needs me */}
          <section className="grid gap-3 lg:grid-cols-12">
            {/* Pilot outcome */}
            <div className="rounded-2xl border border-emerald-900 bg-emerald-950 p-5 text-white shadow-sm lg:col-span-5">
              <div className="flex items-center justify-between text-xs font-medium text-emerald-200">
                <span className="flex items-center gap-1.5">
                  <TrendingDown className="h-4 w-4" /> Collisions since install ({pilotStartText})
                </span>
                <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-50">Simulated</span>
              </div>
              <div className="mt-3 flex items-end gap-4">
                <div className="text-5xl font-bold tracking-tight tabular-nums">{fmt(outcome.actual)}</div>
                <div className="pb-1.5 text-sm text-emerald-100">
                  vs <b className="text-white">{fmt(Math.round(outcome.expected))}</b> expected
                </div>
                <div
                  className={`mb-1 ml-auto rounded-full px-3 py-1 text-lg font-bold tabular-nums ${
                    outcomeChange <= 0 ? 'bg-emerald-400 text-emerald-950' : 'bg-amber-400 text-amber-950'
                  }`}
                >
                  {outcomeChange <= 0 ? '−' : '+'}
                  {Math.abs(Math.round(outcomeChange * 100))}%
                </div>
              </div>
              {/* actual vs expected bar */}
              <div className="mt-4 h-2 rounded-full bg-white/15">
                <div
                  className="h-2 rounded-full bg-emerald-400"
                  style={{ width: `${Math.min(100, (outcome.actual / Math.max(1, outcome.expected)) * 100)}%` }}
                />
              </div>
              <p className="mt-2 text-[11px] leading-snug text-emerald-200">
                {pilotWeeks} weeks of pilot. Expected = the same weeks' average in 2021–2025 (real data) on{' '}
                {selectedSite ? 'this site' : `your ${sites.length} stretches`}
                {roadKmText ? ` (${roadKmText})` : ''}.
              </p>
            </div>

            {/* Warnings this week */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-3">
              <div className="flex items-center justify-between text-xs font-medium text-slate-500">
                <span className="flex items-center gap-1.5">
                  <Radio className="h-4 w-4" /> Driver warnings · 7 days
                </span>
                <Tag kind={detTag} />
              </div>
              <div className="mt-3 text-5xl font-bold tracking-tight tabular-nums text-slate-950">{fmt(weekWarnings)}</div>
              <p className="mt-2 text-[11px] leading-snug text-slate-500">
                Each one while a deer or moose was on the road. {fmt(week.length)} animals detected in total.
              </p>
            </div>

            {/* Needs attention */}
            <div
              className={`rounded-2xl border p-5 shadow-sm lg:col-span-4 ${
                attention.length ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'
              }`}
            >
              <div className="flex items-center justify-between text-xs font-medium text-slate-500">
                <span className="flex items-center gap-1.5">
                  <Wrench className="h-4 w-4" /> Needs attention
                </span>
                <span className="tabular-nums">
                  {onlineCount}/{scopeUnits.length} units online
                </span>
              </div>
              {attention.length === 0 ? (
                <div className="mt-3 flex items-center gap-2 text-lg font-bold text-emerald-800">
                  <CheckCircle2 className="h-6 w-6" /> All {scopeUnits.length} units OK
                </div>
              ) : (
                <ul className="mt-3 space-y-1.5">
                  {attention.slice(0, 4).map((a) => (
                    <li key={a.unit + a.kind} className="flex items-center gap-2 text-sm">
                      {a.kind === 'offline' ? (
                        <WifiOff className="h-4 w-4 shrink-0 text-amber-700" />
                      ) : (
                        <BatteryLow className="h-4 w-4 shrink-0 text-amber-700" />
                      )}
                      <span className="font-semibold text-slate-900">{a.unit}</span>
                      <span className="text-amber-900">{a.text}</span>
                      <span className="ml-auto truncate text-[11px] text-slate-500">{a.site}</span>
                    </li>
                  ))}
                  {attention.length > 4 && (
                    <li className="text-[11px] text-slate-500">+{attention.length - 4} more</li>
                  )}
                </ul>
              )}
            </div>
          </section>

          {/* Right now + this week */}
          <section className="grid gap-3 lg:grid-cols-12">
            <div className="lg:col-span-5">
              <RiskCard risk={risk} hour={hourNow} month={monthNow} monthShare={monthShare} lastHour={lastHour.length} beacons={beaconUnits.size} />
            </div>
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm lg:col-span-7">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-slate-900">This week</h2>
                <Tag kind={detTag} />
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-700">
                Your units warned drivers <b className="text-slate-950">{fmt(weekWarnings)} times</b>, mostly at{' '}
                <b className="text-slate-950">
                  {String(peakHour).padStart(2, '0')}–{String((peakHour + 2) % 24).padStart(2, '0')}
                </b>
                .{' '}
                {topSite && !selectedSite && (
                  <>
                    <b className="text-slate-950">{topSite.name}</b> saw the most deer and moose.{' '}
                  </>
                )}
                {attention.length === 0
                  ? 'No unit needs maintenance.'
                  : `${attention.length} unit${attention.length > 1 ? 's need' : ' needs'} attention.`}
              </p>
            </div>
          </section>

          {/* Map */}
          <Card className="overflow-hidden p-0">
            <div ref={mapRef} className="h-[460px] sm:h-[540px]">
              <SiteMap
                sites={sites}
                units={mapUnits}
                heat={REGION_HEAT}
                selectedSiteId={selectedSiteId}
                onSelectSite={selectSite}
                focus={focus}
              />
            </div>
          </Card>

          {/* Charts */}
          <section className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardTitle
                title="When animals are on the road"
                note={`Detections by hour, last ${SIM_DAYS} days`}
                tag={detTag}
              />
              <BarChart
                ariaLabel="Detections by hour of day"
                bars={byHour.map((v, h) => ({
                  label: String(h).padStart(2, '0'),
                  value: v,
                  tooltip: `${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00 · ${fmt(v)} detections`,
                  emphasis: h === hourNow,
                }))}
                labelEvery={3}
                bands={[
                  { from: 5, to: 8, label: 'dawn' },
                  { from: 16, to: 20, label: 'dusk' },
                ]}
              />
              <p className="mt-3 text-xs text-slate-600">
                {Math.round(((byHour.slice(5, 9).reduce((a, b) => a + b, 0) + byHour.slice(16, 21).reduce((a, b) => a + b, 0)) / (detections.length || 1)) * 100)}
                % of detections happen at dawn and dusk, when visibility is worst.
              </p>
            </Card>

            <Card>
              <CardTitle title="Collision season" note="Collisions by month, 2021–2025" tag="real" />
              <BarChart
                ariaLabel="Collisions by month"
                color="#c9461a"
                bars={collisions.byMonth.map((v, i) => ({
                  label: MONTHS[i].slice(0, 1),
                  value: v,
                  tooltip: `${MONTHS[i]} · ${fmt(v)} collisions`,
                  emphasis: i === monthNow,
                }))}
              />
              <p className="mt-3 text-xs text-slate-600">
                {MONTHS[monthNow]} is {monthShare * 12 > 1.2 ? 'peak season' : 'a quieter month'}:{' '}
                <b className="text-slate-900">{Math.round(monthShare * 100)}%</b> of this area's collisions happen in{' '}
                {MONTHS[monthNow]}.
              </p>
            </Card>

            <Card>
              <CardTitle title="Collisions per year" note="Before the pilot, and the season we're measuring" tag="real" />
              <BarChart
                ariaLabel="Collisions per year"
                color="#c9461a"
                bars={[
                  ...['2021', '2022', '2023', '2024', '2025'].map((y) => ({
                    label: y,
                    value: collisions.byYear[y] ?? 0,
                    tooltip: `${y} · ${fmt(collisions.byYear[y] ?? 0)} collisions`,
                  })),
                  { label: '2026', value: 0, tooltip: 'Pilot season: measuring', pending: true },
                ]}
              />
              <p className="mt-3 text-xs text-slate-600">
                {fmt(lastYear)} in {LAST_FULL_YEAR}
                {selectedSite ? ' at this site' : ` on your stretches, ${fmt(REGION.collisions.byYear[LAST_FULL_YEAR] ?? 0)} in the whole region`}
                . Average {fmt(Math.round(prevAvg))} a year in 2021–2024: the baseline the pilot is measured against.
              </p>
            </Card>
          </section>

          {/* Sites + species */}
          <section className="grid gap-4 lg:grid-cols-3">
            <Card className="overflow-hidden p-0 lg:col-span-2">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-900">Pilot sites</h2>
                <span className="text-[11px] text-slate-500">
                  {mapUnits.length} units ≈ €{fmt(Math.round((mapUnits.length * UNIT_PRICE_EUR) / 1000))}k (est.) vs €
                  {fmt((sites.length * RADAR_PER_SITE_EUR) / 1000)}k for radar at {sites.length} sites
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Site</th>
                      <th className="px-3 py-2 text-right font-semibold">Collisions {LAST_FULL_YEAR}</th>
                      <th className="px-3 py-2 text-right font-semibold">Since install</th>
                      <th className="px-3 py-2 text-right font-semibold">Detections {SIM_DAYS} d</th>
                      <th className="px-3 py-2 text-right font-semibold">Warnings</th>
                      <th className="px-3 py-2 font-semibold">Units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...sites]
                      .sort((a, b) => (b.collisions.byYear[LAST_FULL_YEAR] ?? 0) - (a.collisions.byYear[LAST_FULL_YEAR] ?? 0))
                      .map((s) => {
                        const sd = allDetections.filter((d) => d.site_id === s.id);
                        const units = mapUnits.filter((u) => u.siteId === s.id);
                        const beacon = units.some((u) => u.beaconOn);
                        return (
                          <tr
                            key={s.id}
                            onClick={() => selectSite(s.id)}
                            className={`cursor-pointer border-t border-slate-100 hover:bg-slate-50 ${
                              s.id === selectedSiteId ? 'bg-emerald-50/60' : ''
                            }`}
                          >
                            <td className="px-4 py-2.5">
                              <div className="font-semibold text-slate-900">{s.name}</div>
                              <div className="text-[11px] text-slate-500">{s.municipality}</div>
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">{s.collisions.byYear[LAST_FULL_YEAR] ?? 0}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums">
                              {(() => {
                                const o = pilotOutcome(s, PILOT_START, now);
                                return (
                                  <>
                                    <b className="text-slate-900">{o.actual}</b>
                                    <span className="text-slate-400"> / {Math.round(o.expected)} exp.</span>
                                  </>
                                );
                              })()}
                            </td>
                            <td className="px-3 py-2.5 text-right tabular-nums">{fmt(sd.length)}</td>
                            <td className="px-3 py-2.5 text-right tabular-nums">{fmt(sd.filter((d) => d.warning).length)}</td>
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-1.5">
                                {units.map((u) => {
                                  const h = u.real ? null : simulateHealth({ id: u.id, real: false, lat: 0, lng: 0, nearby: 0 });
                                  return (
                                    <span
                                      key={u.id}
                                      title={`${u.id}${h ? ` · battery ${h.battery_pct}% · ${h.temp_c} °C` : ' · real board'}`}
                                      className={`h-2.5 w-2.5 rounded-full ${
                                        u.beaconOn ? 'bg-red-600' : !u.online ? 'bg-amber-500' : u.real ? 'bg-emerald-700' : 'bg-emerald-400'
                                      }`}
                                    />
                                  );
                                })}
                                {beacon && <span className="ml-1 text-[10px] font-bold text-red-700">BEACON ON</span>}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </Card>

            <Card>
              <CardTitle title="Which animals" note="Collisions by species, 2021–2025" tag="real" />
              <HBarList
                color="#c9461a"
                rows={Object.entries(collisions.bySpecies)
                  .filter(([, n]) => n > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, n]) => ({ label: SPECIES_LABEL[k] ?? k, value: n }))}
              />
              <p className="mt-3 text-xs text-slate-600">
                Deer, not moose, cause most collisions here. Moose fences and radar sites don't cover them; our units do.
              </p>
            </Card>
          </section>

          <footer className="flex flex-wrap items-center justify-between gap-2 pb-2 text-[11px] text-slate-500">
            <span>
              <Tag kind="real" /> {DATA_SOURCE} (
              <a href={DATA_SOURCE_URL} target="_blank" rel="noreferrer" className="underline">
                source
              </a>
              ) and the live board sign-001.{' '}
              {simulatedCount > 0 && (
                <>
                  <Tag kind="pilot" /> Detections of the {simulatedCount} other units are simulated from real seasonal and
                  daily patterns.
                </>
              )}
            </span>
            <span className="inline-flex items-center gap-1">
              <BatteryMedium className="h-3.5 w-3.5" /> Unit price is an estimate.
            </span>
          </footer>
        </div>
      </div>
    </div>
  );
}

// ---- Small building blocks ----------------------------------------------------------
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>{children}</div>;
}

function Tag({ kind }: { kind: 'real' | 'pilot' }) {
  return kind === 'real' ? (
    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">Real data</span>
  ) : (
    <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold text-amber-800">Simulated</span>
  );
}

function CardTitle({ title, note, tag }: { title: string; note: string; tag?: 'real' | 'pilot' }) {
  return (
    <div className="mb-5 flex items-start justify-between gap-2">
      <div>
        <h2 className="text-sm font-semibold text-slate-900">{title}</h2>
        <p className="text-[11px] text-slate-500">{note}</p>
      </div>
      {tag && <Tag kind={tag} />}
    </div>
  );
}

function RiskCard({
  risk,
  hour,
  month,
  monthShare,
  lastHour,
  beacons,
}: {
  risk: string;
  hour: number;
  month: number;
  monthShare: number;
  lastHour: number;
  beacons: number;
}) {
  const dusk = hour >= 16 && hour <= 20;
  const dawn = hour >= 5 && hour <= 8;
  const style =
    risk === 'High'
      ? { box: 'border-red-200 bg-red-50', text: 'text-red-800', badge: 'bg-red-600 text-white' }
      : risk === 'Elevated'
        ? { box: 'border-amber-200 bg-amber-50', text: 'text-amber-900', badge: 'bg-amber-500 text-white' }
        : { box: 'border-emerald-200 bg-emerald-50', text: 'text-emerald-900', badge: 'bg-emerald-700 text-white' };
  const Icon = dusk || hour > 20 || hour < 5 ? Moon : dawn ? Sunrise : Sun;
  return (
    <div className={`h-full rounded-2xl border p-4 shadow-sm ${style.box}`}>
      <div className="flex items-center justify-between">
        <h2 className={`flex items-center gap-2 text-sm font-semibold ${style.text}`}>
          <Icon className="h-4 w-4" /> Right now
        </h2>
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${style.badge}`}>
          {risk !== 'Normal' && <AlertTriangle className="h-3 w-3" />}
          {risk} risk
        </span>
      </div>
      <p className={`mt-2 text-sm leading-relaxed ${style.text}`}>
        {dusk ? 'Dusk' : dawn ? 'Dawn' : hour > 20 || hour < 5 ? 'Night' : 'Daytime'}
        {monthShare * 12 > 1.2 ? ` in ${MONTHS[month]}, the peak collision month` : ` in ${MONTHS[month]}`}.{' '}
        {lastHour} animal{lastHour === 1 ? '' : 's'} detected in the last hour.{' '}
        {beacons > 0 ? (
          <b className="text-red-700">
            {beacons} beacon{beacons > 1 ? 's' : ''} warning drivers now.
          </b>
        ) : (
          'No beacon active.'
        )}
      </p>
    </div>
  );
}
