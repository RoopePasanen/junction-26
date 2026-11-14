/**
 * Live events from the roadside units (the UNO Q "wildlife-beacon" app).
 *
 * The board POSTs one JSON record per sighting to /api/events (format B1 in PLAN.md,
 * plus event_id / status / lat / lng / source / thumb). The same event is sent again
 * when the beacon turns on and when the sighting ends, so records are upserted by
 * event_id. The browser gets every change over Server-Sent Events.
 *
 *   POST   /api/events          record or array of records from a unit
 *   GET    /api/events          all known events, oldest first
 *   GET    /api/events/stream   SSE: one `data:` line per new or updated event
 *   DELETE /api/events          clear everything (reset between demo runs)
 *
 * If the board can't reach the laptop, set BOARD_URL=http://<board-ip>:7000 and the
 * server pulls <BOARD_URL>/events every 2 s instead.
 *
 * Finished events are appended to data/live-events.jsonl and reloaded on restart.
 */
import express, { type Express, type Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';

export interface LiveEvent {
  event_id: string;
  device_id: string;
  ts: string;
  class: string; // warn_animal | small_animal | no_animal
  confidence: number;
  frames: number;
  duration_s: number;
  warning: boolean;
  status: 'active' | 'done';
  source: string; // camera | upload | knob | simulated
  lat: number;
  lng: number;
  thumb?: string; // data:image/jpeg;base64,... (uploaded photos only)
  received_at: string;
}

const MAX_EVENTS = 500;
const BOARD_POLL_MS = 2000;

function toEvent(raw: unknown): LiveEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const lat = Number(r.lat);
  const lng = Number(r.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (typeof r.class !== 'string') return null;
  const deviceId = typeof r.device_id === 'string' ? r.device_id : 'unknown';
  const ts = typeof r.ts === 'string' ? r.ts : new Date().toISOString();
  return {
    event_id: typeof r.event_id === 'string' ? r.event_id : `${deviceId}-${ts}`,
    device_id: deviceId,
    ts,
    class: r.class,
    confidence: Number(r.confidence) || 0,
    frames: Number(r.frames) || 0,
    duration_s: Number(r.duration_s) || 0,
    warning: r.warning === true,
    status: r.status === 'active' ? 'active' : 'done',
    source: typeof r.source === 'string' ? r.source : 'camera',
    lat,
    lng,
    thumb: typeof r.thumb === 'string' && r.thumb.startsWith('data:image/') ? r.thumb : undefined,
    received_at: typeof r.received_at === 'string' ? r.received_at : new Date().toISOString(),
  };
}

export function registerLiveEventRoutes(app: Express, dataDir: string): void {
  const events = new Map<string, LiveEvent>();
  const clients = new Set<Response>();
  const lastSeen = new Map<string, string>(); // device_id -> last time we heard from it
  const boardState = { url: '', online: false, lastOk: null as string | null };
  const logFile = path.join(dataDir, 'live-events.jsonl');

  // Reload finished events from earlier runs.
  try {
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const ev = toEvent(JSON.parse(line));
      if (ev) events.set(ev.event_id, ev);
    }
    if (events.size) console.log(`[live] loaded ${events.size} events from ${logFile}`);
  } catch {
    // no log yet
  }

  const broadcast = (payload: unknown) => {
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of clients) res.write(line);
  };

  const upsert = (ev: LiveEvent): boolean => {
    const prev = events.get(ev.event_id);
    if (
      prev &&
      prev.status === ev.status &&
      prev.frames === ev.frames &&
      prev.warning === ev.warning &&
      prev.class === ev.class
    ) {
      return false; // nothing new (e.g. the same record pulled twice)
    }
    if (prev && !ev.thumb) ev.thumb = prev.thumb;
    events.delete(ev.event_id);
    events.set(ev.event_id, ev);
    while (events.size > MAX_EVENTS) events.delete(events.keys().next().value as string);
    if (ev.status === 'done') {
      fs.mkdir(dataDir, { recursive: true }, () =>
        fs.appendFile(logFile, JSON.stringify(ev) + '\n', (err) => {
          if (err) console.warn('[live] could not write the event log:', err.message);
        })
      );
    }
    console.log(
      `[live] ${ev.status} ${ev.device_id} ${ev.class} ${Math.round(ev.confidence * 100)}%` +
        `${ev.warning ? ' BEACON' : ''} (${ev.source})`
    );
    broadcast({ type: 'event', event: ev });
    return true;
  };

  app.post('/api/events', express.json({ limit: '5mb' }), (req, res) => {
    const items = Array.isArray(req.body) ? req.body : [req.body];
    let accepted = 0;
    for (const item of items) {
      if (item && typeof item === 'object') delete (item as Record<string, unknown>).received_at; // ours to set
      const ev = toEvent(item);
      if (!ev) continue;
      lastSeen.set(ev.device_id, new Date().toISOString());
      upsert(ev);
      accepted++;
    }
    if (!accepted) {
      res.status(400).json({ error: 'Expected a record with numeric lat, lng and a class.' });
      return;
    }
    res.json({ ok: true, accepted });
  });

  app.get('/api/events', (_req, res) => {
    res.json([...events.values()]);
  });

  app.delete('/api/events', (_req, res) => {
    events.clear();
    fs.rm(logFile, { force: true }, () => undefined);
    broadcast({ type: 'clear' });
    res.json({ ok: true });
  });

  app.get('/api/events/stream', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    clients.add(res);
    const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => {
      clearInterval(keepAlive);
      clients.delete(res);
    });
  });

  // Unit status: last time each device was heard from (events pushed or pulled), and
  // whether the board answers in pull mode. The dashboard shows units as online from this.
  app.get('/api/units', (_req, res) => {
    for (const ev of events.values()) {
      const prev = lastSeen.get(ev.device_id);
      if (!prev || prev < ev.received_at) lastSeen.set(ev.device_id, ev.received_at);
    }
    res.json({ board: boardState.url ? boardState : null, lastSeen: Object.fromEntries(lastSeen) });
  });

  // Pull mode: ask the board for its recent events.
  const boardUrl = (process.env.BOARD_URL ?? '').trim().replace(/\/$/, '');
  if (boardUrl) {
    boardState.url = boardUrl;
    let failing = false;
    console.log(`[live] pulling events from ${boardUrl}/events every ${BOARD_POLL_MS / 1000} s`);
    setInterval(async () => {
      try {
        const res = await fetch(`${boardUrl}/events`, { signal: AbortSignal.timeout(3000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = (await res.json()) as unknown[];
        for (const item of list) {
          const ev = toEvent(item);
          if (ev) upsert(ev);
        }
        if (failing) console.log('[live] board reachable again');
        failing = false;
        boardState.online = true;
        boardState.lastOk = new Date().toISOString();
      } catch (err) {
        if (!failing) console.warn(`[live] board not reachable at ${boardUrl}:`, (err as Error).message);
        failing = true;
        boardState.online = false;
      }
    }, BOARD_POLL_MS);
  }
}
