/**
 * Dashboard map. The base map is the planner's own map (CanvasFinlandMap: canvas tiles,
 * smooth wheel zoom, drag to pan, kept inside Finland). On top of it, using the same
 * camera: the real collision heat layer (canvas) and the customer's sites and units
 * (HTML markers).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, Scan } from 'lucide-react';
import type { CustomerSite } from '../../data/customerSites';
import { CanvasFinlandMap } from '../CanvasFinlandMap';
import { DEFAULT_COVERAGE_CONFIG } from '../../utils/cameraPlanGeometry';
import { DEFAULT_SIMULATOR_CONFIG } from '../../utils/crossingSimulator';
import {
  clampCamera,
  latLngToWorldPixel,
  zoomAroundScreenPoint,
  ZOOM_STEP,
  type CameraState,
  type LatLngPoint,
} from '../../utils/mapMath';

export interface MapUnit {
  id: string;
  siteId: string;
  lat: number;
  lng: number;
  real: boolean;
  online: boolean;
  beaconOn: boolean;
  detections: number;
}

interface SiteMapProps {
  sites: CustomerSite[];
  units: MapUnit[];
  heat: Array<[number, number, number]>;
  selectedSiteId: string | null;
  onSelectSite: (id: string | null) => void;
  focus?: { point: LatLngPoint; zoom: number; key: number } | null;
}

// Sequential ramp (one hue family, light -> dark) for collision density.
const HEAT_RAMP = ['#fde7c8', '#fbc78d', '#f59e53', '#e8702a', '#c9461a', '#9a2b12'];

const NOOP = () => {};

function fitView(sites: CustomerSite[], width: number, height: number): CameraState {
  const lats = sites.map((s) => s.center.lat);
  const lngs = sites.map((s) => s.center.lng);
  const center = {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
  };
  for (let z = 15; z >= 6; z -= 0.25) {
    const a = latLngToWorldPixel({ lat: Math.max(...lats), lng: Math.min(...lngs) }, z);
    const b = latLngToWorldPixel({ lat: Math.min(...lats), lng: Math.max(...lngs) }, z);
    if (b.x - a.x < width - 160 && b.y - a.y < height - 140) {
      return clampCamera({ center, zoom: z }, { width, height });
    }
  }
  return clampCamera({ center, zoom: 6 }, { width, height });
}

export function SiteMap({ sites, units, heat, selectedSiteId, onSelectSite, focus }: SiteMapProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const heatRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [camera, setCamera] = useState<CameraState | null>(null);
  const [showHeat, setShowHeat] = useState(true);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() =>
      setSize({ width: Math.floor(el.clientWidth), height: Math.floor(el.clientHeight) })
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (size.width) setCamera(fitView(sites, size.width, size.height));
  }, [sites, size.width, size.height]);

  useEffect(() => {
    if (!camera && size.width) fit();
  }, [camera, size.width, fit]);

  useEffect(() => {
    if (focus && size.width) setCamera(clampCamera({ center: focus.point, zoom: focus.zoom }, size));
    // only when a new focus request comes in
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus]);

  const zoom = camera?.zoom ?? 9;
  const centerWorld = camera ? latLngToWorldPixel(camera.center, zoom) : { x: 0, y: 0 };
  const toScreen = useCallback(
    (lat: number, lng: number) => {
      const wp = latLngToWorldPixel({ lat, lng }, zoom);
      return { x: wp.x - centerWorld.x + size.width / 2, y: wp.y - centerWorld.y + size.height / 2 };
    },
    [zoom, centerWorld.x, centerWorld.y, size.width, size.height]
  );

  // Heat layer
  const heatMax = useMemo(() => {
    const sorted = heat.map((h) => h[2]).sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length * 0.98)] || 1;
  }, [heat]);

  // The blurred heat layer is expensive to draw, so it is drawn once into a cache canvas
  // covering the view plus a margin. Panning only copies from the cache; it is redrawn
  // when the zoom changes or the view leaves the cached area.
  const heatCache = useRef<{ key: string; x0: number; y0: number; w: number; h: number; canvas: HTMLCanvasElement } | null>(
    null
  );

  useEffect(() => {
    const canvas = heatRef.current;
    if (!canvas || !size.width || !camera) return;
    if (canvas.width !== size.width || canvas.height !== size.height) {
      canvas.width = size.width; // 1:1 pixels is plenty for a blurred layer
      canvas.height = size.height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, size.width, size.height);
    if (!showHeat) return;

    const left = centerWorld.x - size.width / 2;
    const top = centerWorld.y - size.height / 2;
    const key = `${zoom}:${heatMax}:${size.width}x${size.height}`;
    let c = heatCache.current;
    const inside =
      c && c.key === key && left >= c.x0 && top >= c.y0 && left + size.width <= c.x0 + c.w && top + size.height <= c.y0 + c.h;

    if (!inside) {
      const mx = size.width / 2;
      const my = size.height / 2;
      const w = size.width + 2 * mx;
      const h = size.height + 2 * my;
      const x0 = left - mx;
      const y0 = top - my;
      const cellPx = Math.abs(
        latLngToWorldPixel({ lat: 60.3, lng: 24.02 }, zoom).x - latLngToWorldPixel({ lat: 60.3, lng: 24.0 }, zoom).x
      );
      const r = Math.max(3, cellPx * 0.7);
      // Cells are ~1 km: zoomed in they turn into big blobs, so fade them to keep roads readable.
      const fade = zoom >= 13 ? 0.35 : zoom >= 12 ? 0.6 : 1;

      const dots = document.createElement('canvas');
      dots.width = w;
      dots.height = h;
      const d = dots.getContext('2d')!;
      for (const [lng, lat, count] of heat) {
        const wp = latLngToWorldPixel({ lat, lng }, zoom);
        const x = wp.x - x0;
        const y = wp.y - y0;
        if (x < -r || y < -r || x > w + r || y > h + r) continue;
        const v = Math.min(1, count / heatMax);
        d.globalAlpha = (0.35 + v * 0.45) * fade;
        d.fillStyle = HEAT_RAMP[Math.min(HEAT_RAMP.length - 1, Math.floor(v * HEAT_RAMP.length))];
        d.beginPath();
        d.arc(x, y, r, 0, Math.PI * 2);
        d.fill();
      }
      // One blur for the whole layer (blurring each dot separately was ~10x slower).
      const blurred = c?.canvas && c.canvas.width === w && c.canvas.height === h ? c.canvas : document.createElement('canvas');
      blurred.width = w;
      blurred.height = h;
      const b = blurred.getContext('2d')!;
      b.filter = `blur(${Math.min(40, Math.max(2, r * 0.45))}px)`;
      b.drawImage(dots, 0, 0);
      c = heatCache.current = { key, x0, y0, w, h, canvas: blurred };
    }
    ctx.drawImage(c!.canvas, left - c!.x0, top - c!.y0, size.width, size.height, 0, 0, size.width, size.height);
  }, [heat, heatMax, centerWorld.x, centerWorld.y, size.width, size.height, camera, showHeat, zoom]);

  const zoomBy = (delta: number) => {
    if (!camera) return;
    setCamera(zoomAroundScreenPoint(camera, camera.zoom + delta, { dx: 0, dy: 0 }, size));
  };

  const showUnits = zoom >= 11;

  return (
    <div ref={boxRef} className="relative h-full w-full overflow-hidden bg-[#eef2f6]">
      {camera && (
        <CanvasFinlandMap
          camera={camera}
          mode="base"
          mapTypeId="roadmap"
          showLabels
          showTerrain={false}
          showGraticule={false}
          areasOfInterest={[]}
          selectedAreaId={null}
          selectedCameraId={null}
          coverageConfig={DEFAULT_COVERAGE_CONFIG}
          visibleCameras={[]}
          evaluatedEvents={[]}
          simulatorConfig={DEFAULT_SIMULATOR_CONFIG}
          selectedCrossingEventId={null}
          onCameraChange={setCamera}
          onCursorMove={NOOP}
          onSelectCamera={NOOP}
          onSelectArea={NOOP}
          onSelectCrossingEvent={NOOP}
        />
      )}
      <canvas ref={heatRef} className="pointer-events-none absolute inset-0 h-full w-full mix-blend-multiply" />

      {/* Sites */}
      {camera &&
        sites.map((s) => {
          const p = toScreen(s.center.lat, s.center.lng);
          const edge = toScreen(s.center.lat + s.radiusKm / 111.2, s.center.lng);
          const rPx = Math.abs(p.y - edge.y);
          const siteUnits = units.filter((u) => u.siteId === s.id);
          const beacon = siteUnits.some((u) => u.beaconOn);
          const offline = siteUnits.some((u) => !u.online);
          const selected = s.id === selectedSiteId;
          return (
            <div key={s.id}>
              {rPx > 14 && (
                <div
                  className={`pointer-events-none absolute rounded-full border-2 ${
                    selected ? 'border-emerald-600 bg-emerald-500/10' : 'border-slate-700/40 bg-white/5'
                  }`}
                  style={{ left: p.x - rPx, top: p.y - rPx, width: rPx * 2, height: rPx * 2 }}
                />
              )}
              {!showUnits && (
                <button
                  type="button"
                  onClick={() => onSelectSite(selected ? null : s.id)}
                  className="absolute -translate-x-1/2 -translate-y-1/2"
                  style={{ left: p.x, top: p.y }}
                >
                  {beacon && <span className="absolute inset-0 -m-2 animate-ping rounded-full bg-red-500/50" />}
                  <span
                    className={`relative flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold shadow-md transition-colors ${
                      beacon
                        ? 'border-red-600 bg-red-600 text-white'
                        : selected
                          ? 'border-emerald-700 bg-emerald-700 text-white'
                          : 'border-slate-200 bg-white text-slate-800 hover:border-slate-400'
                    }`}
                  >
                    <span
                      className={`h-2 w-2 rounded-full ${
                        beacon ? 'bg-white' : offline ? 'bg-amber-500' : 'bg-emerald-500'
                      }`}
                    />
                    {s.name}
                    <span className={beacon || selected ? 'text-white/80' : 'text-slate-500'}>{siteUnits.length}</span>
                  </span>
                </button>
              )}
            </div>
          );
        })}

      {/* Units (zoomed in) */}
      {camera &&
        showUnits &&
        units.map((u) => {
          const p = toScreen(u.lat, u.lng);
          if (p.x < -30 || p.y < -30 || p.x > size.width + 30 || p.y > size.height + 30) return null;
          return (
            <button
              key={u.id}
              type="button"
              onClick={() => onSelectSite(u.siteId)}
              className="absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: p.x, top: p.y }}
              title={`${u.id} · ${u.detections} detections (30 d)`}
            >
              {u.beaconOn && <span className="absolute inset-0 -m-3 animate-ping rounded-full bg-red-500/60" />}
              <span
                className={`relative flex h-6 w-6 items-center justify-center rounded-full border-2 border-white shadow-md ${
                  u.beaconOn ? 'bg-red-600' : !u.online ? 'bg-amber-500' : u.real ? 'bg-emerald-700' : 'bg-slate-800'
                }`}
              >
                <span className="h-1.5 w-1.5 rounded-full bg-white" />
              </span>
              <span className="absolute left-1/2 top-7 -translate-x-1/2 whitespace-nowrap rounded bg-white/95 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700 shadow-sm">
                {u.id}
                {u.real && <span className="ml-1 text-emerald-700">● live</span>}
              </span>
            </button>
          );
        })}

      {/* Controls */}
      <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <button type="button" onClick={() => zoomBy(ZOOM_STEP)} className="p-2 text-slate-700 hover:bg-slate-50" aria-label="Zoom in">
          <Plus className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => zoomBy(-ZOOM_STEP)} className="border-t border-slate-100 p-2 text-slate-700 hover:bg-slate-50" aria-label="Zoom out">
          <Minus className="h-4 w-4" />
        </button>
        <button type="button" onClick={fit} className="border-t border-slate-100 p-2 text-slate-700 hover:bg-slate-50" aria-label="Show all sites">
          <Scan className="h-4 w-4" />
        </button>
      </div>

      {/* Legend */}
      <div className="absolute bottom-3 left-3 rounded-lg border border-slate-200 bg-white/95 px-3 py-2 text-[11px] text-slate-600 shadow-sm backdrop-blur">
        <label className="flex cursor-pointer items-center gap-2 font-semibold text-slate-800">
          <input type="checkbox" checked={showHeat} onChange={(e) => setShowHeat(e.target.checked)} className="accent-emerald-700" />
          Wildlife collisions 2021–2025
        </label>
        {showHeat && (
          <div className="mt-1.5 flex items-center gap-1.5">
            <span>fewer</span>
            <span className="flex h-2 overflow-hidden rounded-full">
              {HEAT_RAMP.map((c) => (
                <span key={c} className="w-4" style={{ background: c }} />
              ))}
            </span>
            <span>more</span>
          </div>
        )}
      </div>
      <div className="pointer-events-none absolute bottom-1 right-2 text-[10px] text-slate-500">
        Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors · collisions: Ramboll
      </div>
    </div>
  );
}
