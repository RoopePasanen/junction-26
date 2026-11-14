/**
 * Live layer: real events from the roadside units (UNO Q wildlife-beacon app).
 *
 * - useLiveEvents(): loads /api/events and follows /api/events/stream (SSE).
 * - <LiveUnitsLayer>: draws each unit on top of whichever map is showing (canvas or
 *   Google), using the shared camera state, plus a live feed card on the right.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { latLngToWorldPixel, type CameraState, type LatLngPoint } from '../utils/mapMath';

export interface LiveEvent {
  event_id: string;
  device_id: string;
  ts: string;
  class: string;
  confidence: number;
  frames: number;
  duration_s: number;
  warning: boolean;
  status: 'active' | 'done';
  source: string;
  lat: number;
  lng: number;
  thumb?: string;
  received_at: string;
}

type Connection = 'connecting' | 'live' | 'offline';

export function useLiveEvents() {
  const [events, setEvents] = useState<LiveEvent[]>([]);
  const [connection, setConnection] = useState<Connection>('connecting');
  const [latestAlert, setLatestAlert] = useState<LiveEvent | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/events')
      .then((r) => r.json())
      .then((list: LiveEvent[]) => {
        if (!cancelled) setEvents(list);
      })
      .catch(() => undefined);

    const source = new EventSource('/api/events/stream');
    source.onopen = () => setConnection('live');
    source.onerror = () => setConnection('offline'); // EventSource reconnects by itself
    source.onmessage = (msg) => {
      const data = JSON.parse(msg.data) as { type: string; event?: LiveEvent };
      if (data.type === 'clear') {
        setEvents([]);
        setLatestAlert(null);
        return;
      }
      const ev = data.event;
      if (data.type !== 'event' || !ev) return;
      setEvents((prev) => {
        const old = prev.find((p) => p.event_id === ev.event_id);
        if (ev.warning && !old?.warning) setLatestAlert(ev); // beacon just turned on
        return [...prev.filter((p) => p.event_id !== ev.event_id), ev];
      });
    };
    return () => {
      cancelled = true;
      source.close();
    };
  }, []);

  return { events, connection, latestAlert, dismissAlert: () => setLatestAlert(null) };
}

const CLASS_LABEL: Record<string, string> = {
  warn_animal: 'Deer / moose',
  small_animal: 'Small animal',
  no_animal: 'No animal',
};

function timeOf(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ts
    : d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

interface UnitSummary {
  device_id: string;
  lat: number;
  lng: number;
  latest: LiveEvent;
  count: number;
  beaconOn: boolean;
}

interface LiveUnitsLayerProps {
  camera: CameraState;
  onFocus: (point: LatLngPoint, zoom?: number) => void;
}

export function LiveUnitsLayer({ camera, onFocus }: LiveUnitsLayerProps) {
  const { events, connection, latestAlert, dismissAlert } = useLiveEvents();
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ width: el.clientWidth, height: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Re-render every second so "beacon on" fades when the sighting ends.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Alert banner closes by itself.
  useEffect(() => {
    if (!latestAlert) return;
    const id = setTimeout(dismissAlert, 8000);
    return () => clearTimeout(id);
  }, [latestAlert]); // eslint-disable-line react-hooks/exhaustive-deps

  const units = useMemo(() => {
    const byDevice = new Map<string, UnitSummary>();
    for (const ev of events) {
      const u = byDevice.get(ev.device_id);
      byDevice.set(ev.device_id, {
        device_id: ev.device_id,
        lat: ev.lat,
        lng: ev.lng,
        latest: ev,
        count: (u?.count ?? 0) + 1,
        beaconOn: ev.status === 'active' && ev.warning,
      });
    }
    return [...byDevice.values()];
  }, [events]);

  const feed = useMemo(() => [...events].reverse().slice(0, 30), [events]);

  const centerWorld = latLngToWorldPixel(camera.center, camera.zoom);
  const toScreen = (lat: number, lng: number) => {
    const wp = latLngToWorldPixel({ lat, lng }, camera.zoom);
    return { x: wp.x - centerWorld.x + size.width / 2, y: wp.y - centerWorld.y + size.height / 2 };
  };

  return (
    <div ref={boxRef} className="pointer-events-none absolute inset-0 z-[15] overflow-hidden">
      {/* Unit markers */}
      {size.width > 0 &&
        units.map((u) => {
          const p = toScreen(u.lat, u.lng);
          if (p.x < -40 || p.y < -40 || p.x > size.width + 40 || p.y > size.height + 40) return null;
          const active = u.latest.status === 'active';
          const color = u.beaconOn
            ? 'bg-red-600'
            : active && u.latest.class === 'small_animal'
              ? 'bg-amber-500'
              : 'bg-slate-800';
          return (
            <button
              key={u.device_id}
              type="button"
              onClick={() => onFocus({ lat: u.lat, lng: u.lng }, 13)}
              className="pointer-events-auto absolute -translate-x-1/2 -translate-y-1/2"
              style={{ left: p.x, top: p.y }}
              title={`${u.device_id}: ${u.count} events`}
            >
              {u.beaconOn && (
                <span className="absolute inset-0 -m-3 animate-ping rounded-full bg-red-500/60" />
              )}
              <span
                className={`relative flex h-7 w-7 items-center justify-center rounded-full border-2 border-white text-sm shadow-lg ${color}`}
              >
                {u.beaconOn ? '⚠️' : '📷'}
              </span>
              <span className="absolute left-1/2 top-8 -translate-x-1/2 whitespace-nowrap rounded bg-white/95 px-1.5 py-0.5 text-[10px] font-semibold text-slate-800 shadow">
                {u.device_id}
              </span>
            </button>
          );
        })}

      <div className="pointer-events-none absolute right-3 top-16 flex w-72 max-w-[calc(100%-1.5rem)] flex-col gap-2 sm:right-4">
      {/* Beacon alert banner */}
      {latestAlert && (
        <div className="pointer-events-auto flex items-center gap-3 rounded-xl border-2 border-red-500 bg-red-50 px-3 py-2.5 shadow-xl">
          {latestAlert.thumb && (
            <img src={latestAlert.thumb} alt="" className="h-12 w-16 rounded object-cover" />
          )}
          <div className="text-sm text-red-900">
            <div className="font-bold">⚠️ Beacon on at {latestAlert.device_id}</div>
            <div>
              {CLASS_LABEL[latestAlert.class] ?? latestAlert.class} ·{' '}
              {Math.round(latestAlert.confidence * 100)}% · {timeOf(latestAlert.ts)}
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              onFocus({ lat: latestAlert.lat, lng: latestAlert.lng }, 13);
              dismissAlert();
            }}
            className="rounded-md bg-red-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-red-700"
          >
            Show
          </button>
        </div>
      )}

      {/* Live feed */}
      <div className="pointer-events-auto rounded-xl border border-slate-200 bg-white/95 shadow-lg backdrop-blur">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="flex w-full items-center justify-between px-3 py-2 text-left"
        >
          <span className="text-xs font-bold text-slate-900">
            Live units · {events.length} {events.length === 1 ? 'event' : 'events'}
          </span>
          <span className="flex items-center gap-1.5 text-[11px] text-slate-500">
            <span
              className={`h-2 w-2 rounded-full ${
                connection === 'live' ? 'bg-emerald-500' : connection === 'offline' ? 'bg-red-500' : 'bg-slate-400'
              }`}
            />
            {connection}
            <span className="ml-1">{open ? '▾' : '▸'}</span>
          </span>
        </button>
        {open && (
          <ul className="max-h-[45vh] overflow-y-auto border-t border-slate-100">
            {feed.length === 0 && (
              <li className="px-3 py-3 text-xs text-slate-500">
                Waiting for the first sighting. Show the board a photo on its page (port 7000).
              </li>
            )}
            {feed.map((ev) => {
              const live = ev.status === 'active' && now - new Date(ev.received_at).getTime() < 120000;
              return (
                <li key={ev.event_id}>
                  <button
                    type="button"
                    onClick={() => onFocus({ lat: ev.lat, lng: ev.lng }, 13)}
                    className="flex w-full items-center gap-2.5 border-b border-slate-100 px-3 py-2 text-left hover:bg-slate-50"
                  >
                    {ev.thumb ? (
                      <img src={ev.thumb} alt="" className="h-10 w-14 shrink-0 rounded object-cover" />
                    ) : (
                      <span className="flex h-10 w-14 shrink-0 items-center justify-center rounded bg-slate-100 text-lg">
                        {ev.class === 'warn_animal' ? '🦌' : '🦊'}
                      </span>
                    )}
                    <span className="min-w-0 flex-1 text-xs">
                      <span className="flex items-center gap-1.5 font-semibold text-slate-900">
                        {CLASS_LABEL[ev.class] ?? ev.class}
                        {ev.warning && (
                          <span className="rounded bg-red-100 px-1 text-[10px] font-bold text-red-700">BEACON</span>
                        )}
                        {live && (
                          <span className="rounded bg-emerald-100 px-1 text-[10px] font-bold text-emerald-700">LIVE</span>
                        )}
                      </span>
                      <span className="block text-slate-500">
                        {Math.round(ev.confidence * 100)}% · {ev.device_id} · {timeOf(ev.ts)} · {ev.source}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      </div>
    </div>
  );
}
