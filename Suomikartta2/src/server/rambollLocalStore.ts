import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import {
  computePolygonBBox,
  isPointInLatLngPolygon,
  type SimpleLatLng,
} from '../utils/polygonGeometry.ts';

export interface LocalRambollAccident {
  lat: number;
  lng: number;
  speciesClass: number; // 1=moose, 2=fallowDeer, 3=roeDeer, 4=forestReindeer, 5=whiteTailedDeer
  year: number;
  month: number;
}

export interface LocalWarningCorridor {
  warningType: number;
  coords: Array<[number, number]>; // [lng, lat][]
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

interface LoadedRambollStore {
  accidents: LocalRambollAccident[];
  accidentGrid: Map<string, number[]>;
  warnings: LocalWarningCorridor[];
  warningGrid: Map<string, number[]>;
}

const ACC_GRID_DEG = 0.05;
const WARN_GRID_DEG = 0.1;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, 'data');

let cachedStore: LoadedRambollStore | null = null;

function loadStoreFromDisk(): LoadedRambollStore {
  if (cachedStore) return cachedStore;

  const binPath = path.join(DATA_DIR, 'rambollFinlandAccidents.bin');
  if (!fs.existsSync(binPath)) {
    throw new Error(`Downloaded Ramboll collision dataset missing at ${binPath}`);
  }

  const buf = fs.readFileSync(binPath);
  const magic = buf.toString('ascii', 0, 4);
  if (magic !== 'RMBA' || buf.byteLength < 12) {
    throw new Error('Invalid local Ramboll dataset binary header.');
  }

  const count = buf.readUInt32LE(8);
  const accidents: LocalRambollAccident[] = new Array(count);
  const accidentGrid = new Map<string, number[]>();

  let offset = 12;
  for (let i = 0; i < count; i++) {
    const lat = buf.readInt32LE(offset) / 100_000;
    const lng = buf.readInt32LE(offset + 4) / 100_000;
    const speciesClass = buf.readUInt8(offset + 8);
    const year = 2000 + buf.readUInt8(offset + 9);
    const month = buf.readUInt8(offset + 10);
    offset += 12;

    accidents[i] = { lat, lng, speciesClass, year, month };

    const gx = Math.floor(lng / ACC_GRID_DEG);
    const gy = Math.floor(lat / ACC_GRID_DEG);
    const key = `${gx}:${gy}`;
    const bucket = accidentGrid.get(key);
    if (bucket) bucket.push(i);
    else accidentGrid.set(key, [i]);
  }

  const warnings: LocalWarningCorridor[] = [];
  const warningGrid = new Map<string, number[]>();
  const warnPath = path.join(DATA_DIR, 'rambollWarnings.json.gz');

  if (fs.existsSync(warnPath)) {
    const rawGz = fs.readFileSync(warnPath);
    const jsonText = zlib.gunzipSync(rawGz).toString('utf-8');
    const parsed = JSON.parse(jsonText) as Array<[number, Array<[number, number]>]>;

    for (let i = 0; i < parsed.length; i++) {
      const [warningType, coords] = parsed[i];
      if (!coords || coords.length < 2) continue;
      let minLat = Infinity;
      let maxLat = -Infinity;
      let minLng = Infinity;
      let maxLng = -Infinity;
      for (const [lng, lat] of coords) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
      const wIdx = warnings.length;
      warnings.push({ warningType, coords, minLat, maxLat, minLng, maxLng });

      const gx0 = Math.floor(minLng / WARN_GRID_DEG);
      const gx1 = Math.floor(maxLng / WARN_GRID_DEG);
      const gy0 = Math.floor(minLat / WARN_GRID_DEG);
      const gy1 = Math.floor(maxLat / WARN_GRID_DEG);
      for (let gx = gx0; gx <= gx1; gx++) {
        for (let gy = gy0; gy <= gy1; gy++) {
          const k = `${gx}:${gy}`;
          const b = warningGrid.get(k);
          if (b) b.push(wIdx);
          else warningGrid.set(k, [wIdx]);
        }
      }
    }
  }

  cachedStore = { accidents, accidentGrid, warnings, warningGrid };
  return cachedStore;
}

export function getLocalRambollDatasetStats(): {
  nationwideAccidents: number;
  warningSegments: number;
  dataPeriod: string;
  offlineReady: boolean;
} {
  const store = loadStoreFromDisk();
  return {
    nationwideAccidents: store.accidents.length,
    warningSegments: store.warnings.length,
    dataPeriod: '2021–2025',
    offlineReady: true,
  };
}

/**
 * Queries the locally downloaded Ramboll collision dataset for:
 * - `insideAccidents`: points strictly inside `polygon`
 * - `bufferedAccidents`: points inside `polygon` OR within `bufferMeters` of its bounding box
 *   so road stretches hugging the drawn perimeter still score nearby historical collisions accurately.
 */
export function queryLocalAccidentsForPolygon(
  polygon: ReadonlyArray<SimpleLatLng>,
  bufferMeters = 450
): {
  insideAccidents: LocalRambollAccident[];
  bufferedAccidents: LocalRambollAccident[];
  nationwideTotal: number;
} {
  const store = loadStoreFromDisk();
  const bbox = computePolygonBBox(polygon);
  const cosLat = Math.max(0.2, Math.cos((bbox.centerLat * Math.PI) / 180));
  const dLat = bufferMeters / 111_132;
  const dLng = bufferMeters / (111_320 * cosLat);

  const searchMinLat = bbox.minLat - dLat;
  const searchMaxLat = bbox.maxLat + dLat;
  const searchMinLng = bbox.minLng - dLng;
  const searchMaxLng = bbox.maxLng + dLng;

  const gx0 = Math.floor(searchMinLng / ACC_GRID_DEG);
  const gx1 = Math.floor(searchMaxLng / ACC_GRID_DEG);
  const gy0 = Math.floor(searchMinLat / ACC_GRID_DEG);
  const gy1 = Math.floor(searchMaxLat / ACC_GRID_DEG);

  const insideAccidents: LocalRambollAccident[] = [];
  const bufferedAccidents: LocalRambollAccident[] = [];

  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      const bucket = store.accidentGrid.get(`${gx}:${gy}`);
      if (!bucket) continue;
      for (const idx of bucket) {
        const acc = store.accidents[idx];
        if (
          acc.lat < searchMinLat ||
          acc.lat > searchMaxLat ||
          acc.lng < searchMinLng ||
          acc.lng > searchMaxLng
        ) {
          continue;
        }
        bufferedAccidents.push(acc);
        if (
          acc.lat >= bbox.minLat &&
          acc.lat <= bbox.maxLat &&
          acc.lng >= bbox.minLng &&
          acc.lng <= bbox.maxLng &&
          isPointInLatLngPolygon(acc.lat, acc.lng, polygon)
        ) {
          insideAccidents.push(acc);
        }
      }
    }
  }

  return {
    insideAccidents,
    bufferedAccidents,
    nationwideTotal: store.accidents.length,
  };
}

export function queryLocalWarningCorridorsInBbox(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number
): LocalWarningCorridor[] {
  const store = loadStoreFromDisk();
  const gx0 = Math.floor(minLng / WARN_GRID_DEG);
  const gx1 = Math.floor(maxLng / WARN_GRID_DEG);
  const gy0 = Math.floor(minLat / WARN_GRID_DEG);
  const gy1 = Math.floor(maxLat / WARN_GRID_DEG);

  const seen = new Set<number>();
  const results: LocalWarningCorridor[] = [];

  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      const bucket = store.warningGrid.get(`${gx}:${gy}`);
      if (!bucket) continue;
      for (const idx of bucket) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const w = store.warnings[idx];
        if (w.maxLat < minLat || w.minLat > maxLat || w.maxLng < minLng || w.minLng > maxLng) {
          continue;
        }
        results.push(w);
      }
    }
  }

  return results;
}
