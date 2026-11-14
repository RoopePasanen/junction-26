/**
 * Customer dashboard: what a regional road authority sees once our units are installed.
 *
 * Real data: collisions per site (Ramboll 2021–2025) and the live board (sign-001).
 * Simulated data (labelled): detections from the other pilot units.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  BatteryMedium,
  Camera,
  CarFront,
  ChevronRight,
  Euro,
  Moon,
  Radio,
  ShieldCheck,
  Sun,
  Sunrise,
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
import { SIM_DAYS, simulateHealth, simulateUnit, type Detection } from '../../utils/pilotSimulation';
import { useLiveEvents } from '../LiveUnitsLayer';
import { BarChart, HBarList } from './BarChart';
import { SiteMap, type MapUnit } from './SiteMap';

// ---- Settings ----------------------------------------------------------------------
export const CUSTOMER_NAME = 'Uusimaa road region';
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
const timeAgo = (t: number, now: number) => {
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
};

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
    const id = setTimeout(dismissAlert, 10000);
    return () => clearTimeout(id);
  }, [latestAlert]); // eslint-disable-line react-hooks/exhaustive-deps

  const unitIndex = useMemo(() => {
    const m = new Map<string, { site: CustomerSite; lat: number; lng: number; real: boolean }>();
    for (const s of CUSTOMER_SITES) for (const u of s.units) m.set(u.id, { site: s, lat: u.lat, lng: u.lng, real: u.real });
    return m;
  }, []);

  // Simulated history, recomputed once per hour bucket so it stays stable.
  const hourBucket = Math.floor(now / 3_600_000);
  const simulated = useMemo(() => {
    const t = Date.now();
    return CUSTOMER_SITES.flatMap((s) => s.units.filter((u) => !u.real).flatMap((u) => simulateUnit(s, u, t)));
  }, [hourBucket]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const selectedSite = CUSTOMER_SITES.find((s) => s.id === selectedSiteId) ?? null;
  const scopeSites = selectedSite ? [selectedSite] : CUSTOMER_SITES;
  const detections = selectedSite ? allDetections.filter((d) => d.site_id === selectedSite.id) : allDetections;
  const collisions = useMemo(() => sumStats(scopeSites), [selectedSiteId]); // eslint-disable-line react-hooks/exhaustive-deps

  const realOnline = (id: string) =>
    unitStatus.boardOnline ||
    (unitStatus.lastSeen[id] ? now - new Date(unitStatus.lastSeen[id]).getTime() < 10 * 60_000 : false);

  const beaconUnits = new Set(
    real.filter((d) => d.status === 'active' && d.warning).map((d) => d.device_id)
  );

  const mapUnits: MapUnit[] = CUSTOMER_SITES.flatMap((s) =>
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

  const warnings = detections.filter((d) => d.warning);
  const bigAnimals = detections.filter((d) => d.class === 'warn_animal');
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

  const selectSite = (id: string | null) => {
    setSelectedSiteId(id);
    const s = CUSTOMER_SITES.find((x) => x.id === id);
    if (s) setFocus({ point: s.center, zoom: 13, key: Date.now() });
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-slate-50">
      {/* Header */}
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 bg-white px-5 py-3 sm:px-6">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-emerald-700">
            Wildlife warning pilot
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-amber-800">
              17 of 18 units simulated
            </span>
          </div>
          <h1 className="truncate text-xl font-bold tracking-tight text-slate-950">
            {CUSTOMER_NAME}
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
          {/* Beacon alert */}
          {latestAlert && (
            <div className="flex items-center gap-4 rounded-2xl border-2 border-red-500 bg-red-50 p-3 shadow-sm">
              {latestAlert.thumb ? (
                <img src={latestAlert.thumb} alt="" className="h-16 w-24 rounded-lg object-cover" />
              ) : (
                <AlertTriangle className="h-10 w-10 text-red-600" />
              )}
              <div className="min-w-0 flex-1">
                <div className="text-sm font-bold text-red-900">
                  Beacon on · {unitIndex.get(latestAlert.device_id)?.site.name ?? latestAlert.device_id}
                </div>
                <div className="text-sm text-red-800">
                  Deer or moose on the road, detected by {latestAlert.device_id} with{' '}
                  {Math.round(latestAlert.confidence * 100)}% confidence. Drivers are being warned now.
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  const u = unitIndex.get(latestAlert.device_id);
                  if (u) {
                    setSelectedSiteId(u.site.id);
                    setFocus({ point: { lat: u.lat, lng: u.lng }, zoom: 15, key: Date.now() });
                  }
                  dismissAlert();
                }}
                className="rounded-lg bg-red-600 px-3 py-2 text-xs font-semibold text-white hover:bg-red-700"
              >
                Show on map
              </button>
            </div>
          )}

          {/* KPIs */}
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <Kpi
              icon={<CarFront className="h-4 w-4" />}
              label={`Collisions in ${LAST_FULL_YEAR}`}
              value={fmt(lastYear)}
              sub={
                selectedSite
                  ? `within ${selectedSite.radiusKm} km of this site${roadKmText ? ` · ${roadKmText}` : ''}`
                  : `on your ${CUSTOMER_SITES.length} stretches${roadKmText ? ` · ${roadKmText}` : ''} · ${fmt(REGION.collisions.byYear[LAST_FULL_YEAR] ?? 0)} in the region`
              }
              tag="real"
            />
            <Kpi
              icon={<Camera className="h-4 w-4" />}
              label={`Animals detected · ${SIM_DAYS} d`}
              value={fmt(detections.length)}
              sub={`${fmt(bigAnimals.length)} deer & moose · ${fmt(detections.length - bigAnimals.length)} small`}
              tag="pilot"
            />
            <Kpi
              icon={<Radio className="h-4 w-4" />}
              label={`Driver warnings · ${SIM_DAYS} d`}
              value={fmt(warnings.length)}
              sub={`≈ ${Math.round(warnings.length / SIM_DAYS)} a day, while an animal was on the road`}
              tag="pilot"
              accent
            />
            <Kpi
              icon={<ShieldCheck className="h-4 w-4" />}
              label="Units online"
              value={`${onlineCount}/${scopeUnits.length}`}
              sub={
                scopeUnits.some((u) => u.real)
                  ? realOnline('sign-001')
                    ? 'incl. sign-001 (real board, live)'
                    : 'sign-001 (real board) offline'
                  : 'all reporting'
              }
              warn={onlineCount < scopeUnits.length}
            />
            <Kpi
              icon={<Euro className="h-4 w-4" />}
              label="Cost vs radar sites"
              value={`€${fmt(Math.round(ourCost / 1000))}k`}
              sub={`vs €${fmt(radarCost / 1000)}k for radar at ${scopeSites.length} site${scopeSites.length > 1 ? 's' : ''} (est.)`}
            />
          </section>

          {/* Map + right column */}
          <section className="grid gap-4 xl:grid-cols-12">
            <Card className="overflow-hidden p-0 xl:col-span-8">
              <div className="h-[460px] sm:h-[540px]">
                <SiteMap
                  sites={CUSTOMER_SITES}
                  units={mapUnits}
                  heat={REGION_HEAT}
                  selectedSiteId={selectedSiteId}
                  onSelectSite={selectSite}
                  focus={focus}
                />
              </div>
            </Card>

            <div className="flex min-h-0 flex-col gap-4 xl:col-span-4">
              <RiskCard risk={risk} hour={hourNow} month={monthNow} monthShare={monthShare} lastHour={lastHour.length} />
              <Card className="flex min-h-0 flex-1 flex-col p-0">
                <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
                  <h2 className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                    <Activity className="h-4 w-4 text-emerald-700" /> Latest detections
                  </h2>
                  <span className="text-[11px] text-slate-500">{selectedSite ? selectedSite.name : 'all sites'}</span>
                </div>
                <ul className="max-h-[330px] min-h-0 flex-1 overflow-y-auto">
                  {detections.slice(0, 25).map((d) => (
                    <li key={d.event_id}>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedSiteId(d.site_id);
                          setFocus({ point: { lat: d.lat, lng: d.lng }, zoom: 15, key: Date.now() });
                        }}
                        className="flex w-full items-center gap-3 border-b border-slate-50 px-4 py-2 text-left hover:bg-slate-50"
                      >
                        {d.thumb ? (
                          <img src={d.thumb} alt="" className="h-9 w-12 shrink-0 rounded-md object-cover" />
                        ) : (
                          <span className="flex h-9 w-12 shrink-0 items-center justify-center rounded-md bg-slate-100 text-base">
                            {d.class === 'warn_animal' ? '🦌' : '🦊'}
                          </span>
                        )}
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5 text-xs font-semibold text-slate-900">
                            {d.class === 'warn_animal' ? 'Deer / moose' : 'Small animal'}
                            {d.warning && (
                              <span className="rounded bg-red-50 px-1 text-[10px] font-bold text-red-700">WARNED</span>
                            )}
                            {d.source !== 'simulated' && (
                              <span className="rounded bg-emerald-50 px-1 text-[10px] font-bold text-emerald-700">REAL</span>
                            )}
                          </span>
                          <span className="block truncate text-[11px] text-slate-500">
                            {unitIndex.get(d.device_id)?.site.name ?? d.device_id} · {d.device_id} ·{' '}
                            {Math.round(d.confidence * 100)}%
                          </span>
                        </span>
                        <span className="shrink-0 text-[11px] tabular-nums text-slate-400">{timeAgo(d.t, now)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          </section>

          {/* Charts */}
          <section className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardTitle
                title="When animals are on the road"
                note={`Detections by hour, last ${SIM_DAYS} days`}
                tag="pilot"
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
                Average {fmt(Math.round(prevAvg))} a year before {LAST_FULL_YEAR}. The pilot report compares this
                season against that baseline.
              </p>
            </Card>
          </section>

          {/* Sites + species */}
          <section className="grid gap-4 lg:grid-cols-3">
            <Card className="overflow-hidden p-0 lg:col-span-2">
              <div className="border-b border-slate-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-900">Pilot sites</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="text-[11px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-4 py-2 font-semibold">Site</th>
                      <th className="px-3 py-2 text-right font-semibold">Collisions {LAST_FULL_YEAR}</th>
                      <th className="px-3 py-2 text-right font-semibold">Detections {SIM_DAYS} d</th>
                      <th className="px-3 py-2 text-right font-semibold">Warnings</th>
                      <th className="px-3 py-2 font-semibold">Units</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...CUSTOMER_SITES]
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
              ) and the live board sign-001. <Tag kind="pilot" /> Detections of the 17 other units are simulated from
              real seasonal and daily patterns.
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

function Kpi({
  icon,
  label,
  value,
  sub,
  tag,
  accent,
  warn,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  tag?: 'real' | 'pilot';
  accent?: boolean;
  warn?: boolean;
}) {
  return (
    <div
      className={`rounded-2xl border p-4 shadow-sm ${
        accent ? 'border-emerald-800 bg-emerald-900 text-white' : 'border-slate-200 bg-white'
      }`}
    >
      <div className={`flex items-center justify-between text-xs font-medium ${accent ? 'text-emerald-100' : 'text-slate-500'}`}>
        <span className="flex items-center gap-1.5">
          {icon}
          {label}
        </span>
        {tag && !accent && <Tag kind={tag} />}
        {tag && accent && (
          <span className="rounded bg-white/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-50">
            {tag === 'real' ? 'Real data' : 'Simulated'}
          </span>
        )}
      </div>
      <div className={`mt-2 text-3xl font-bold tracking-tight tabular-nums ${warn ? 'text-amber-600' : ''}`}>{value}</div>
      <div className={`mt-1 text-[11px] leading-snug ${accent ? 'text-emerald-100' : 'text-slate-500'}`}>{sub}</div>
    </div>
  );
}

function RiskCard({
  risk,
  hour,
  month,
  monthShare,
  lastHour,
}: {
  risk: string;
  hour: number;
  month: number;
  monthShare: number;
  lastHour: number;
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
    <div className={`rounded-2xl border p-4 shadow-sm ${style.box}`}>
      <div className="flex items-center justify-between">
        <h2 className={`flex items-center gap-2 text-sm font-semibold ${style.text}`}>
          <Icon className="h-4 w-4" /> Collision risk right now
        </h2>
        <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-bold ${style.badge}`}>
          {risk !== 'Normal' && <AlertTriangle className="h-3 w-3" />}
          {risk}
        </span>
      </div>
      <p className={`mt-2 text-xs leading-relaxed ${style.text}`}>
        {dusk ? 'Dusk' : dawn ? 'Dawn' : hour > 20 || hour < 5 ? 'Night' : 'Daytime'}
        {monthShare * 12 > 1.2 ? ` in ${MONTHS[month]}, the peak collision month` : ` in ${MONTHS[month]}`}.{' '}
        {lastHour} animal{lastHour === 1 ? '' : 's'} detected in the last hour.
      </p>
    </div>
  );
}
