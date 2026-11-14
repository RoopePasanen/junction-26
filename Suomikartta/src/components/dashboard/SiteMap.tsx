/**
 * Dashboard map: light basemap, real collision heat layer, the customer's sites and
 * their units. Drag to pan, wheel or +/- to zoom. Markers are HTML on top of the tiles.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Minus, Plus, Scan } from 'lucide-react';
import type { CustomerSite } from '../../data/customerSites';
import { latLngToWorldPixel, worldPixelToLatLng, type LatLngPoint } from '../../utils/mapMath';

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

const TILE = 256;
const MIN_Z = 7;
const MAX_Z = 16;
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas';
const tileUrl = (z: number, x: number, y: number) => `${ESRI}/World_Light_Gray_Base/MapServer/tile/${z}/${y}/${x}`;
const labelUrl = (z: number, x: number, y: number) =>
  `${ESRI}/World_Light_Gray_Reference/MapServer/tile/${z}/${y}/${x}`;

// Sequential ramp (one hue family, light -> dark) for collision density.
const HEAT_RAMP = ['#fde7c8', '#fbc78d', '#f59e53', '#e8702a', '#c9461a', '#9a2b12'];

function fitView(sites: CustomerSite[], width: number, height: number) {
  const lats = sites.map((s) => s.center.lat);
  const lngs = sites.map((s) => s.center.lng);
  const center = {
    lat: (Math.min(...lats) + Math.max(...lats)) / 2,
    lng: (Math.min(...lngs) + Math.max(...lngs)) / 2,
  };
  for (let z = MAX_Z; z >= MIN_Z; z--) {
    const a = latLngToWorldPixel({ lat: Math.max(...lats), lng: Math.min(...lngs) }, z);
    const b = latLngToWorldPixel({ lat: Math.min(...lats), lng: Math.max(...lngs) }, z);
    if (b.x - a.x < width - 160 && b.y - a.y < height - 140) return { center, zoom: z };
  }
  return { center, zoom: MIN_Z };
}

export function SiteMap({ sites, units, heat, selectedSiteId, onSelectSite, focus }: SiteMapProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const heatRef = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState<{ center: LatLngPoint; zoom: number } | null>(null);
  const [showHeat, setShowHeat] = useState(true);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; moved: boolean } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    if (size.width) setView(fitView(sites, size.width, size.height));
  }, [sites, size.width, size.height]);

  useEffect(() => {
    if (!view && size.width) fit();
  }, [view, size.width, fit]);

  useEffect(() => {
    if (focus) setView({ center: focus.point, zoom: focus.zoom });
  }, [focus]);

  const zoom = view?.zoom ?? 9;
  const centerWorld = view ? latLngToWorldPixel(view.center, zoom) : { x: 0, y: 0 };
  const toScreen = useCallback(
    (lat: number, lng: number) => {
      const wp = latLngToWorldPixel({ lat, lng }, zoom);
      return { x: wp.x - centerWorld.x + size.width / 2, y: wp.y - centerWorld.y + size.height / 2 };
    },
    [zoom, centerWorld.x, centerWorld.y, size.width, size.height]
  );

  // Tiles in view
  const tiles = useMemo(() => {
    if (!view || !size.width) return [];
    const left = centerWorld.x - size.width / 2;
    const top = centerWorld.y - size.height / 2;
    const n = 2 ** zoom;
    const list: Array<{ key: string; url: string; label: string; x: number; y: number }> = [];
    for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + size.height) / TILE); ty++) {
      if (ty < 0 || ty >= n) continue;
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + size.width) / TILE); tx++) {
        const wx = ((tx % n) + n) % n;
        list.push({
          key: `${zoom}/${tx}/${ty}`,
          url: tileUrl(zoom, wx, ty),
          label: labelUrl(zoom, wx, ty),
          x: tx * TILE - left,
          y: ty * TILE - top,
        });
      }
    }
    return list;
  }, [view, zoom, centerWorld.x, centerWorld.y, size.width, size.height]);

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
    if (!canvas || !size.width || !view) return;
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
  }, [heat, heatMax, centerWorld.x, centerWorld.y, size.width, size.height, view, showHeat, zoom]);

  const zoomAt = (delta: number, sx = size.width / 2, sy = size.height / 2) => {
    if (!view) return;
    const nz = Math.max(MIN_Z, Math.min(MAX_Z, zoom + delta));
    if (nz === zoom) return;
    const anchor = worldPixelToLatLng(
      { x: centerWorld.x + sx - size.width / 2, y: centerWorld.y + sy - size.height / 2 },
      zoom
    );
    const aw = latLngToWorldPixel(anchor, nz);
    setView({
      zoom: nz,
      center: worldPixelToLatLng({ x: aw.x - sx + size.width / 2, y: aw.y - sy + size.height / 2 }, nz),
    });
  };

  // The map sits in a scrolling page: plain wheel scrolls the page, Ctrl/⌘ + wheel zooms.
  const [wheelHint, setWheelHint] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) {
        setWheelHint(true);
        clearTimeout(hintTimer.current);
        hintTimer.current = setTimeout(() => setWheelHint(false), 1200);
        return;
      }
      e.preventDefault(); // stop the browser's page zoom
      const rect = el.getBoundingClientRect();
      zoomRef.current(e.deltaY < 0 ? 1 : -1, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  const zoomRef = useRef(zoomAt);
  zoomRef.current = zoomAt;

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button')) return;
    drag.current = { x: e.clientX, y: e.clientY, cx: centerWorld.x, cy: centerWorld.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
    setView({ zoom, center: worldPixelToLatLng({ x: d.cx - dx, y: d.cy - dy }, zoom) });
  };
  const onPointerUp = () => {
    drag.current = null;
  };

  const showUnits = zoom >= 11;

  return (
    <div
      ref={boxRef}
      className="relative h-full w-full touch-none select-none overflow-hidden bg-[#f2f1ee]"
      onDoubleClick={(e) => {
        const rect = boxRef.current!.getBoundingClientRect();
        zoomAt(1, e.clientX - rect.left, e.clientY - rect.top);
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ cursor: drag.current ? 'grabbing' : 'grab' }}
    >
      {tiles.map((t) => (
        <img
          key={t.key}
          src={t.url}
          alt=""
          draggable={false}
          className="pointer-events-none absolute h-64 w-64 max-w-none"
          style={{ left: t.x, top: t.y }}
        />
      ))}
      <canvas ref={heatRef} className="pointer-events-none absolute inset-0 h-full w-full" />
      {tiles.map((t) => (
        <img
          key={`l${t.key}`}
          src={t.label}
          alt=""
          draggable={false}
          className="pointer-events-none absolute h-64 w-64 max-w-none"
          style={{ left: t.x, top: t.y }}
        />
      ))}

      {/* Sites */}
      {view &&
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
      {view &&
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

      {wheelHint && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-slate-900/25">
          <span className="rounded-lg bg-slate-900/85 px-3 py-2 text-sm font-medium text-white">
            Hold Ctrl and scroll to zoom the map
          </span>
        </div>
      )}

      {/* Controls */}
      <div className="absolute right-3 top-3 flex flex-col overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
        <button type="button" onClick={() => zoomAt(1)} className="p-2 text-slate-700 hover:bg-slate-50" aria-label="Zoom in">
          <Plus className="h-4 w-4" />
        </button>
        <button type="button" onClick={() => zoomAt(-1)} className="border-t border-slate-100 p-2 text-slate-700 hover:bg-slate-50" aria-label="Zoom out">
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
      <div className="absolute bottom-1 right-2 text-[10px] text-slate-500">
        Basemap © Esri, HERE, Garmin, © OpenStreetMap contributors · collisions: Ramboll
      </div>
    </div>
  );
}
