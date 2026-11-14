import type {
  PlannedCameraNode,
  SectorId,
  SpeciesCollisionBreakdown,
} from '../data/finlandWildlifePlan.ts';
import type {
  CustomAreaPlanResult,
  CustomAreaRequestParams,
} from '../types/customAreaPlan.ts';

const RAMBOLL_TILE_BASE_URL =
  'https://mobilityanalytics.ramboll.com/onn/hirvielain/data/tiles';
const RAMBOLL_SOURCE_URL = 'https://mobilityanalytics.ramboll.com/onn/hirvielain/';
const VAYLA_OGC_BASE_URL =
  'https://avoinapi.vaylapilvi.fi/vaylatiedot/ogc/features/v1/collections';

const EARTH_RADIUS_M = 6_371_008.8;
const TARGET_CAMERA_COUNT = 100;

export interface DecodedRambollAccident {
  lat: number;
  lng: number;
  speciesClass: number; // 1=moose, 2=fallowDeer, 3=roeDeer, 4=forestReindeer, 5=whiteTailedDeer
  year: number;
  month: number;
}

interface RoadSegmentChain {
  roadLabel: string;
  hierarchyWeight: number;
  coords: Array<[number, number]>; // [lng, lat][]
  cumDistM: number[];
  totalLengthM: number;
}

interface CandidateRoadStation {
  chainIdx: number;
  stationDistM: number;
  lat: number;
  lng: number;
  bearingDeg: number;
  altBearingDeg: number | null;
  roadLabel: string;
  hierarchyWeight: number;
  turnAngleDeg: number;
  score: number;
  accidents500m: number;
  whiteTailedDeer: number;
  roeDeer: number;
  moose: number;
  nearbyAccidentIndices: number[];
}

// Simple bounded in-memory LRU cache for Ramboll .pbf tiles so repeat radius tweaks are instant
const tileBufferCache = new Map<string, Uint8Array | null>();
const MAX_TILE_CACHE_SIZE = 180;

function getCachedTile(key: string): Uint8Array | null | undefined {
  if (!tileBufferCache.has(key)) return undefined;
  const val = tileBufferCache.get(key) ?? null;
  tileBufferCache.delete(key);
  tileBufferCache.set(key, val);
  return val;
}

function setCachedTile(key: string, val: Uint8Array | null): void {
  if (tileBufferCache.has(key)) {
    tileBufferCache.delete(key);
  } else if (tileBufferCache.size >= MAX_TILE_CACHE_SIZE) {
    const oldest = tileBufferCache.keys().next().value;
    if (oldest !== undefined) {
      tileBufferCache.delete(oldest);
    }
  }
  tileBufferCache.set(key, val);
}

export function groundDistanceM(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const meanLatRad = (((lat1 + lat2) / 2) * Math.PI) / 180;
  const dx = (lng2 - lng1) * 111_320 * Math.cos(meanLatRad);
  const dy = (lat2 - lat1) * 111_132;
  return Math.hypot(dx, dy);
}

export function compassBearingDeg(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const meanLatRad = (((lat1 + lat2) / 2) * Math.PI) / 180;
  const dx = (lng2 - lng1) * 111_320 * Math.cos(meanLatRad);
  const dy = (lat2 - lat1) * 111_132;
  const raw = (Math.atan2(dx, dy) * 180) / Math.PI;
  return ((Math.round(raw) % 360) + 360) % 360;
}

export function projectPointMeters(
  lat: number,
  lng: number,
  distanceM: number,
  bearingDeg: number
): { lat: number; lng: number } {
  const angularDistance = distanceM / EARTH_RADIUS_M;
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAd = Math.sin(angularDistance);
  const cosAd = Math.cos(angularDistance);

  const sinLat2 = sinLat1 * cosAd + cosLat1 * sinAd * Math.cos(bearingRad);
  const lat2 = Math.asin(Math.max(-1, Math.min(1, sinLat2)));
  const y = Math.sin(bearingRad) * sinAd * cosLat1;
  const x = cosAd - sinLat1 * Math.sin(lat2);
  const lng2 = lng1 + Math.atan2(y, x);

  return {
    lat: (lat2 * 180) / Math.PI,
    lng: (lng2 * 180) / Math.PI,
  };
}

function shortestAngleDiff(aDeg: number, bDeg: number): number {
  return Math.abs((((aDeg - bDeg) % 360) + 540) % 360 - 180);
}

function lonLatToTileXY(lng: number, lat: number, z: number): { x: number; y: number } {
  const n = 1 << z;
  const clampedLat = Math.max(-85.0511, Math.min(85.0511, lat));
  const x = Math.max(0, Math.min(n - 1, Math.floor(((lng + 180) / 360) * n)));
  const latRad = (clampedLat * Math.PI) / 180;
  const y = Math.max(
    0,
    Math.min(
      n - 1,
      Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
    )
  );
  return { x, y };
}

function tileSubpixelToLngLat(
  z: number,
  tileX: number,
  tileY: number,
  px: number,
  py: number,
  extent: number
): { lat: number; lng: number } {
  const n = 1 << z;
  const lng = ((tileX + px / extent) / n) * 360 - 180;
  const mercN = Math.PI - (2 * Math.PI * (tileY + py / extent)) / n;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(mercN) - Math.exp(-mercN)));
  return { lat, lng };
}

/**
 * Pure-TypeScript Mapbox Vector Tile (.pbf) decoder for Ramboll's `accidents` point layer.
 */
export function decodeRambollMvtAccidentsTile(
  buf: Uint8Array,
  z: number,
  tileX: number,
  tileY: number
): DecodedRambollAccident[] {
  const results: DecodedRambollAccident[] = [];
  if (!buf || buf.length === 0) return results;

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const textDecoder = new TextDecoder('utf-8');
  let pos = 0;

  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++];
      result += (b & 0x7f) * Math.pow(2, shift);
      if ((b & 0x80) === 0) return result;
      shift += 7;
    }
    return result;
  };

  const zigzagDecode = (n: number): number => (n >>> 1) ^ -(n & 1);

  const skipWire = (wireType: number): void => {
    if (wireType === 0) {
      readVarint();
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 2) {
      const len = readVarint();
      pos += len;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      pos = buf.length;
    }
  };

  while (pos < buf.length) {
    const tag = readVarint();
    const field = tag >>> 3;
    const wireType = tag & 7;

    if (field === 3 && wireType === 2) {
      const layerLen = readVarint();
      const layerEnd = Math.min(buf.length, pos + layerLen);

      let layerName = '';
      let extent = 4096;
      const keys: string[] = [];
      const values: Array<string | number | boolean | null> = [];
      const featureSlices: Array<[number, number]> = [];

      while (pos < layerEnd) {
        const lTag = readVarint();
        const lField = lTag >>> 3;
        const lWire = lTag & 7;

        if (lField === 1 && lWire === 2) {
          const sLen = readVarint();
          layerName = textDecoder.decode(buf.subarray(pos, pos + sLen));
          pos += sLen;
        } else if (lField === 2 && lWire === 2) {
          const fLen = readVarint();
          featureSlices.push([pos, pos + fLen]);
          pos += fLen;
        } else if (lField === 3 && lWire === 2) {
          const kLen = readVarint();
          keys.push(textDecoder.decode(buf.subarray(pos, pos + kLen)));
          pos += kLen;
        } else if (lField === 4 && lWire === 2) {
          const vLen = readVarint();
          const vEnd = pos + vLen;
          let parsedVal: string | number | boolean | null = null;
          while (pos < vEnd) {
            const vTag = readVarint();
            const vField = vTag >>> 3;
            const vWire = vTag & 7;
            if (vField === 1 && vWire === 2) {
              const strLen = readVarint();
              parsedVal = textDecoder.decode(buf.subarray(pos, pos + strLen));
              pos += strLen;
            } else if (vField === 2 && vWire === 5) {
              parsedVal = view.getFloat32(pos, true);
              pos += 4;
            } else if (vField === 3 && vWire === 1) {
              parsedVal = view.getFloat64(pos, true);
              pos += 8;
            } else if ((vField === 4 || vField === 5) && vWire === 0) {
              parsedVal = readVarint();
            } else if (vField === 6 && vWire === 0) {
              parsedVal = zigzagDecode(readVarint());
            } else if (vField === 7 && vWire === 0) {
              parsedVal = readVarint() !== 0;
            } else {
              skipWire(vWire);
            }
          }
          pos = vEnd;
          values.push(parsedVal);
        } else if (lField === 5 && lWire === 0) {
          extent = readVarint();
        } else {
          skipWire(lWire);
        }
      }

      pos = layerEnd;

      if (layerName !== 'accidents') {
        continue;
      }

      const classKeyIdx = keys.indexOf('class');
      const yearKeyIdx = keys.indexOf('year');
      const monthKeyIdx = keys.indexOf('month');

      for (const [fStart, fEnd] of featureSlices) {
        const savedPos = pos;
        pos = fStart;
        let geomType = 0;
        let tagsStart = -1;
        let tagsEnd = -1;
        let geomStart = -1;
        let geomEnd = -1;

        while (pos < fEnd) {
          const fTag = readVarint();
          const fField = fTag >>> 3;
          const fWire = fTag & 7;
          if (fField === 2 && fWire === 2) {
            const len = readVarint();
            tagsStart = pos;
            tagsEnd = pos + len;
            pos += len;
          } else if (fField === 3 && fWire === 0) {
            geomType = readVarint();
          } else if (fField === 4 && fWire === 2) {
            const len = readVarint();
            geomStart = pos;
            geomEnd = pos + len;
            pos += len;
          } else {
            skipWire(fWire);
          }
        }

        // Only decode POINT features (geomType === 1)
        if (geomType === 1 && geomStart >= 0) {
          let speciesClass = 5;
          let year = 2024;
          let month = 1;

          if (tagsStart >= 0) {
            pos = tagsStart;
            while (pos < tagsEnd) {
              const kIdx = readVarint();
              const vIdx = readVarint();
              const v = values[vIdx];
              if (kIdx === classKeyIdx && typeof v === 'number') {
                speciesClass = v;
              } else if (kIdx === yearKeyIdx && typeof v === 'number') {
                year = v;
              } else if (kIdx === monthKeyIdx && typeof v === 'number') {
                month = v;
              }
            }
          }

          pos = geomStart;
          let cx = 0;
          let cy = 0;
          while (pos < geomEnd) {
            const cmdInt = readVarint();
            const cmdId = cmdInt & 0x7;
            const cmdCount = cmdInt >>> 3;
            if (cmdId === 1 || cmdId === 2) {
              for (let c = 0; c < cmdCount && pos < geomEnd; c++) {
                cx += zigzagDecode(readVarint());
                cy += zigzagDecode(readVarint());
                // Ignore buffered margin points outside [0, extent] to prevent duplicate tile-gutter points
                if (cx >= 0 && cx < extent && cy >= 0 && cy < extent) {
                  const pt = tileSubpixelToLngLat(z, tileX, tileY, cx, cy, extent);
                  results.push({
                    lat: pt.lat,
                    lng: pt.lng,
                    speciesClass,
                    year,
                    month,
                  });
                }
              }
            } else {
              break;
            }
          }
        }

        pos = savedPos;
      }
    } else {
      skipWire(wireType);
    }
  }

  return results;
}

function chooseRambollTileZoom(radiusKm: number): number {
  if (radiusKm <= 7) return 11;
  if (radiusKm <= 18) return 10;
  if (radiusKm <= 38) return 9;
  return 8;
}

async function fetchRambollTileBytes(
  z: number,
  x: number,
  y: number
): Promise<Uint8Array | null> {
  const key = `${z}/${x}/${y}`;
  const cached = getCachedTile(key);
  if (cached !== undefined) {
    return cached;
  }

  const url = `${RAMBOLL_TILE_BASE_URL}/${z}/${x}/${y}.pbf`;
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/x-protobuf,*/*',
        'User-Agent': 'SuomiKartta-Planner/1.0',
      },
      signal: AbortSignal.timeout(8500),
    });
    if (!res.ok) {
      setCachedTile(key, null);
      return null;
    }
    const ab = await res.arrayBuffer();
    const bytes = new Uint8Array(ab);
    setCachedTile(key, bytes);
    return bytes;
  } catch {
    return null;
  }
}

export async function fetchRambollAccidentsInCircle(
  centerLat: number,
  centerLng: number,
  radiusKm: number
): Promise<DecodedRambollAccident[]> {
  const dLat = (radiusKm * 1.05) / 111.132;
  const cosLat = Math.max(0.2, Math.cos((centerLat * Math.PI) / 180));
  const dLng = (radiusKm * 1.05) / (111.32 * cosLat);

  const minLat = centerLat - dLat;
  const maxLat = centerLat + dLat;
  const minLng = centerLng - dLng;
  const maxLng = centerLng + dLng;

  const z = chooseRambollTileZoom(radiusKm);
  const nw = lonLatToTileXY(minLng, maxLat, z);
  const se = lonLatToTileXY(maxLng, minLat, z);

  const tileCoords: Array<{ x: number; y: number }> = [];
  for (let ty = nw.y; ty <= se.y; ty++) {
    for (let tx = nw.x; tx <= se.x; tx++) {
      tileCoords.push({ x: tx, y: ty });
    }
  }

  const tilePayloads = await Promise.all(
    tileCoords.map(async ({ x, y }) => {
      const bytes = await fetchRambollTileBytes(z, x, y);
      if (!bytes) return [];
      return decodeRambollMvtAccidentsTile(bytes, z, x, y);
    })
  );

  const radiusM = radiusKm * 1000;
  const inCircle: DecodedRambollAccident[] = [];
  for (const batch of tilePayloads) {
    for (const acc of batch) {
      if (groundDistanceM(centerLat, centerLng, acc.lat, acc.lng) <= radiusM) {
        inCircle.push(acc);
      }
    }
  }
  return inCircle;
}

interface RawRoadLink {
  roadLabel: string;
  hierarchyWeight: number;
  coords: Array<[number, number]>; // [lng, lat][]
}

function formatStateRoadLabel(tie: number, fallbackName?: string): {
  label: string;
  weight: number;
} {
  if (tie >= 1 && tie <= 39) return { label: `Vt ${tie}`, weight: 1.55 };
  if (tie >= 40 && tie <= 99) return { label: `Kt ${tie}`, weight: 1.45 };
  if (tie >= 100 && tie <= 999) return { label: `St ${tie}`, weight: 1.28 };
  if (tie >= 1000 && tie <= 19999) return { label: `Yt ${tie}`, weight: 1.12 };
  return {
    label: fallbackName && fallbackName.trim() ? fallbackName.trim() : 'Regional road',
    weight: 1.0,
  };
}

interface GeoJsonFeatureCollection {
  features?: Array<{
    properties?: Record<string, unknown>;
    geometry?: {
      type?: string;
      coordinates?: unknown;
    };
  }>;
}

async function fetchVaylaRoadsInCircle(
  centerLat: number,
  centerLng: number,
  radiusKm: number
): Promise<RawRoadLink[]> {
  const dLat = (radiusKm * 1.02) / 111.132;
  const cosLat = Math.max(0.2, Math.cos((centerLat * Math.PI) / 180));
  const dLng = (radiusKm * 1.02) / (111.32 * cosLat);

  const bboxStr = [
    (centerLng - dLng).toFixed(5),
    (centerLat - dLat).toFixed(5),
    (centerLng + dLng).toFixed(5),
    (centerLat + dLat).toFixed(5),
  ].join(',');

  // Fetch state road network (tieosoiteverkko) across all radii (2–50 km),
  // plus detailed Digiroad links (dr_tielinkki_toim_lk) when radius <= 22 km for named municipal collectors.
  // NOTE: Never put OR or parentheses in `filter=` on avoinapi.vaylapilvi.fi due to FortiGuard WAF rules.
  const stateRoadsUrl = `${VAYLA_OGC_BASE_URL}/tiestotiedot:tieosoiteverkko/items?f=json&limit=4000&bbox=${bboxStr}`;
  const digiroadUrl =
    radiusKm <= 22
      ? `${VAYLA_OGC_BASE_URL}/digiroad:dr_tielinkki_toim_lk/items?f=json&limit=4000&bbox=${bboxStr}`
      : null;

  const [stateRes, digiRes] = await Promise.all([
    fetch(stateRoadsUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null),
    digiroadUrl
      ? fetch(digiroadUrl, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const rawLinks: RawRoadLink[] = [];
  const maxAllowedRadiusM = Math.max(400, radiusKm * 1000 - 35);

  const extractLines = (geomType: string | undefined, rawCoords: unknown): Array<Array<[number, number]>> => {
    if (!Array.isArray(rawCoords)) return [];
    if (geomType === 'LineString') {
      return [
        rawCoords
          .filter((pt): pt is number[] => Array.isArray(pt) && pt.length >= 2)
          .map((pt) => [Number(pt[0]), Number(pt[1])] as [number, number]),
      ];
    }
    if (geomType === 'MultiLineString') {
      return rawCoords.map((line) =>
        Array.isArray(line)
          ? line
              .filter((pt): pt is number[] => Array.isArray(pt) && pt.length >= 2)
              .map((pt) => [Number(pt[0]), Number(pt[1])] as [number, number])
          : []
      );
    }
    return [];
  };

  const clipLineInsideRadius = (line: Array<[number, number]>): Array<Array<[number, number]>> => {
    const sublines: Array<Array<[number, number]>> = [];
    let current: Array<[number, number]> = [];
    for (const pt of line) {
      const inside = groundDistanceM(centerLat, centerLng, pt[1], pt[0]) <= maxAllowedRadiusM;
      if (inside) {
        current.push(pt);
      } else {
        if (current.length >= 2) sublines.push(current);
        current = [];
      }
    }
    if (current.length >= 2) sublines.push(current);
    return sublines;
  };

  let loadedDigiroadStateRoads = false;

  if (digiRes && digiRes.ok) {
    try {
      const gj = (await digiRes.json()) as GeoJsonFeatureCollection;
      const feats = gj.features ?? [];
      // If Digiroad did not hit the 4000-item ceiling, it contains the full non-bridge road set for the bbox
      if (feats.length > 0 && feats.length < 3950) {
        loadedDigiroadStateRoads = true;
      }
      for (const f of feats) {
        const p = f.properties ?? {};
        const siltaAlik = Number(p.silta_alik ?? 0);
        const linkkiTyyp = Number(p.linkkityyp ?? 3);
        const hallinnLk = Number(p.hallinn_lk ?? 2);
        const toiminnLk = Number(p.toiminn_lk ?? 5);

        // Strictly non-bridge motor vehicle roads
        if (siltaAlik !== 0) continue;
        if (linkkiTyyp < 1 || linkkiTyyp > 4) continue;
        if (hallinnLk !== 1 && toiminnLk > 4) continue;
        // If Digiroad hit the 4000 limit, let tieosoiteverkko supply state roads (hallinn_lk === 1)
        if (!loadedDigiroadStateRoads && hallinnLk === 1) continue;

        const tieNum = Number(p.tienumero ?? 0);
        const streetName = typeof p.tienimi_su === 'string' ? p.tienimi_su.trim() : '';
        let roadLabel = streetName || 'Local collector';
        let hierarchyWeight = toiminnLk <= 3 ? 1.25 : 0.95;

        if (tieNum > 0) {
          const formatted = formatStateRoadLabel(tieNum, streetName);
          roadLabel = streetName ? `${formatted.label} (${streetName})` : formatted.label;
          hierarchyWeight = formatted.weight;
        }

        const lines = extractLines(f.geometry?.type, f.geometry?.coordinates);
        for (const ln of lines) {
          for (const clipped of clipLineInsideRadius(ln)) {
            rawLinks.push({ roadLabel, hierarchyWeight, coords: clipped });
          }
        }
      }
    } catch {
      loadedDigiroadStateRoads = false;
    }
  }

  if (!loadedDigiroadStateRoads && stateRes && stateRes.ok) {
    try {
      const gj = (await stateRes.json()) as GeoJsonFeatureCollection;
      for (const f of gj.features ?? []) {
        const p = f.properties ?? {};
        const ajorata = Number(p.ajorata ?? 0);
        // Main carriageway only (exclude slip ramps >= 3 and duplicate parallel carriageway 2)
        if (ajorata > 1) continue;
        const tie = Number(p.tie ?? 0);
        const nimi = typeof p.nimi === 'string' ? p.nimi.trim() : '';
        const { label, weight } = formatStateRoadLabel(tie, nimi);

        const lines = extractLines(f.geometry?.type, f.geometry?.coordinates);
        for (const ln of lines) {
          for (const clipped of clipLineInsideRadius(ln)) {
            rawLinks.push({ roadLabel: label, hierarchyWeight: weight, coords: clipped });
          }
        }
      }
    } catch {
      // Ignore parse failure if digiroad already succeeded
    }
  }

  return rawLinks;
}

/**
 * Stitches connected road links with matching endpoints (~8 m snap grid) into longer continuous chains
 * so camera sightlines point cleanly down uninterrupted highway corridors.
 */
function stitchRoadChains(links: RawRoadLink[]): RoadSegmentChain[] {
  const endpointKey = (pt: [number, number]): string =>
    `${Math.round(pt[0] * 10000)}:${Math.round(pt[1] * 10000)}`;

  const used = new Uint8Array(links.length);
  const startBuckets = new Map<string, number[]>();
  const endBuckets = new Map<string, number[]>();

  for (let i = 0; i < links.length; i++) {
    const c = links[i].coords;
    if (c.length < 2) {
      used[i] = 1;
      continue;
    }
    const sk = endpointKey(c[0]);
    const ek = endpointKey(c[c.length - 1]);
    const sArr = startBuckets.get(sk);
    if (sArr) sArr.push(i);
    else startBuckets.set(sk, [i]);

    const eArr = endBuckets.get(ek);
    if (eArr) eArr.push(i);
    else endBuckets.set(ek, [i]);
  }

  const chains: RoadSegmentChain[] = [];

  for (let i = 0; i < links.length; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const seed = links[i];
    let pts: Array<[number, number]> = [...seed.coords];

    // Extend forward
    let extended = true;
    let guard = 0;
    while (extended && guard++ < 150) {
      extended = false;
      const tail = pts[pts.length - 1];
      const tk = endpointKey(tail);
      const forwardMatches = startBuckets.get(tk) ?? [];
      for (const idx of forwardMatches) {
        if (used[idx] || links[idx].roadLabel !== seed.roadLabel) continue;
        used[idx] = 1;
        pts = pts.concat(links[idx].coords.slice(1));
        extended = true;
        break;
      }
      if (!extended) {
        const revMatches = endBuckets.get(tk) ?? [];
        for (const idx of revMatches) {
          if (used[idx] || links[idx].roadLabel !== seed.roadLabel) continue;
          used[idx] = 1;
          const reversed = [...links[idx].coords].reverse();
          pts = pts.concat(reversed.slice(1));
          extended = true;
          break;
        }
      }
    }

    // Extend backward
    extended = true;
    guard = 0;
    while (extended && guard++ < 150) {
      extended = false;
      const head = pts[0];
      const hk = endpointKey(head);
      const backMatches = endBuckets.get(hk) ?? [];
      for (const idx of backMatches) {
        if (used[idx] || links[idx].roadLabel !== seed.roadLabel) continue;
        used[idx] = 1;
        pts = links[idx].coords.slice(0, -1).concat(pts);
        extended = true;
        break;
      }
      if (!extended) {
        const revMatches = startBuckets.get(hk) ?? [];
        for (const idx of revMatches) {
          if (used[idx] || links[idx].roadLabel !== seed.roadLabel) continue;
          used[idx] = 1;
          const reversed = [...links[idx].coords].reverse();
          pts = reversed.slice(0, -1).concat(pts);
          extended = true;
          break;
        }
      }
    }

    const cumDistM: number[] = [0];
    for (let k = 1; k < pts.length; k++) {
      const segLen = groundDistanceM(pts[k - 1][1], pts[k - 1][0], pts[k][1], pts[k][0]);
      cumDistM.push(cumDistM[k - 1] + segLen);
    }
    const totalLengthM = cumDistM[cumDistM.length - 1];
    if (totalLengthM >= 65) {
      chains.push({
        roadLabel: seed.roadLabel,
        hierarchyWeight: seed.hierarchyWeight,
        coords: pts,
        cumDistM,
        totalLengthM,
      });
    }
  }

  return chains;
}

function interpolateAlongChain(
  chain: RoadSegmentChain,
  targetDistM: number
): { lat: number; lng: number } {
  const clamped = Math.max(0, Math.min(chain.totalLengthM, targetDistM));
  const { coords, cumDistM } = chain;
  let lo = 0;
  let hi = cumDistM.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >>> 1;
    if (cumDistM[mid] <= clamped) lo = mid;
    else hi = mid;
  }
  const segStart = cumDistM[lo];
  const segLen = Math.max(1e-6, cumDistM[lo + 1] - segStart);
  const t = Math.max(0, Math.min(1, (clamped - segStart) / segLen));
  const lng = coords[lo][0] + (coords[lo + 1][0] - coords[lo][0]) * t;
  const lat = coords[lo][1] + (coords[lo + 1][1] - coords[lo][1]) * t;
  return { lat, lng };
}

function distancePointToChainM(
  lat: number,
  lng: number,
  chain: RoadSegmentChain
): number {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const px = lng * 111_320 * cosLat;
  const py = lat * 111_132;
  let minDistSq = Infinity;

  for (let i = 0; i < chain.coords.length - 1; i++) {
    const ax = chain.coords[i][0] * 111_320 * cosLat;
    const ay = chain.coords[i][1] * 111_132;
    const bx = chain.coords[i + 1][0] * 111_320 * cosLat;
    const by = chain.coords[i + 1][1] * 111_132;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let t = 0;
    if (lenSq > 1e-9) {
      t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    }
    const qx = ax + t * dx;
    const qy = ay + t * dy;
    const dSq = (px - qx) * (px - qx) + (py - qy) * (py - qy);
    if (dSq < minDistSq) minDistSq = dSq;
  }
  return Math.sqrt(minDistSq);
}

function assignAngularSector(
  centerLat: number,
  centerLng: number,
  lat: number,
  lng: number
): SectorId {
  const bearing = compassBearingDeg(centerLat, centerLng, lat, lng);
  const idx = (Math.floor(bearing / 72) % 5) + 1;
  return idx as SectorId;
}

/**
 * Computes a complete 100-camera road-aligned deployment plan inside any Finnish location & radius,
 * weighted by live 2021–2025 cervid collision data from Ramboll Mobility Analytics and snapped
 * onto Väylävirasto's national road network.
 */
export async function buildCustomAreaCameraPlan(
  params: CustomAreaRequestParams
): Promise<CustomAreaPlanResult> {
  const lat = Number(params.lat);
  const lng = Number(params.lng);
  const radiusKm = Math.max(2, Math.min(50, Number(params.radiusKm) || 15));

  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < 59.4 ||
    lat > 70.2 ||
    lng < 19.0 ||
    lng > 31.7
  ) {
    throw new Error('Selected coordinates must lie within Finland (59.5°N–70.1°N, 19.1°E–31.6°E).');
  }

  const label =
    params.label && params.label.trim().length > 0
      ? params.label.trim()
      : `Custom Area (${lat.toFixed(3)}°N, ${lng.toFixed(3)}°E)`;

  const [accidents, rawRoadLinks] = await Promise.all([
    fetchRambollAccidentsInCircle(lat, lng, radiusKm),
    fetchVaylaRoadsInCircle(lat, lng, radiusKm),
  ]);

  const chains = stitchRoadChains(rawRoadLinks);
  if (chains.length === 0) {
    throw new Error(
      `No public motor roads were found within ${radiusKm} km of (${lat.toFixed(3)}°N, ${lng.toFixed(3)}°E). Choose a land location closer to a road or increase the radius.`
    );
  }

  const totalRoadM = chains.reduce((acc, ch) => acc + ch.totalLengthM, 0);
  const roadNetworkKm = Number((totalRoadM / 1000).toFixed(1));

  // Aggregate species & annual counts inside circle
  const speciesTotals: SpeciesCollisionBreakdown = {
    whiteTailedDeer: 0,
    roeDeer: 0,
    moose: 0,
    fallowDeer: 0,
    forestReindeer: 0,
  };
  const byYear: Record<string, number> = {
    '2021': 0,
    '2022': 0,
    '2023': 0,
    '2024': 0,
    '2025': 0,
  };

  // Spatial index for fast 500 m accident lookup around candidate road stations
  const ACC_CELL_DEG = 0.01;
  const accidentBuckets = new Map<string, number[]>();
  const hotspotCells = new Map<string, { sumLng: number; sumLat: number; count: number }>();
  const hotspotGridLat = radiusKm <= 10 ? 0.006 : radiusKm <= 25 ? 0.01 : 0.016;
  const hotspotGridLng = hotspotGridLat * 1.9;

  for (let i = 0; i < accidents.length; i++) {
    const a = accidents[i];
    if (a.speciesClass === 1) speciesTotals.moose++;
    else if (a.speciesClass === 2) speciesTotals.fallowDeer++;
    else if (a.speciesClass === 3) speciesTotals.roeDeer++;
    else if (a.speciesClass === 4) speciesTotals.forestReindeer++;
    else speciesTotals.whiteTailedDeer++;

    const yKey = String(a.year);
    byYear[yKey] = (byYear[yKey] ?? 0) + 1;

    const gx = Math.floor(a.lng / ACC_CELL_DEG);
    const gy = Math.floor(a.lat / ACC_CELL_DEG);
    const bKey = `${gx}:${gy}`;
    const list = accidentBuckets.get(bKey);
    if (list) list.push(i);
    else accidentBuckets.set(bKey, [i]);

    const hx = Math.floor(a.lng / hotspotGridLng);
    const hy = Math.floor(a.lat / hotspotGridLat);
    const hKey = `${hx}:${hy}`;
    const hCell = hotspotCells.get(hKey);
    if (hCell) {
      hCell.sumLng += a.lng;
      hCell.sumLat += a.lat;
      hCell.count++;
    } else {
      hotspotCells.set(hKey, { sumLng: a.lng, sumLat: a.lat, count: 1 });
    }
  }

  const hotspots: Array<[number, number, number]> = Array.from(hotspotCells.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 260)
    .map((c) => [
      Number((c.sumLng / c.count).toFixed(5)),
      Number((c.sumLat / c.count).toFixed(5)),
      c.count,
    ]);

  // Sample candidate road-tangent camera stations finely along stitched chains so hotspots support dense chains
  const sampleStepM = totalRoadM > 350_000 ? 52 : totalRoadM > 120_000 ? 36 : 26;
  const candidates: CandidateRoadStation[] = [];

  for (let chainIdx = 0; chainIdx < chains.length; chainIdx++) {
    const chain = chains[chainIdx];
    const marginM = Math.min(42, chain.totalLengthM * 0.25);
    for (
      let s = marginM;
      s <= chain.totalLengthM - marginM + 0.1;
      s += sampleStepM
    ) {
      const origin = interpolateAlongChain(chain, s);
      const lookAheadM = Math.min(40, chain.totalLengthM - s);
      const lookBehindM = Math.min(40, s);
      if (lookAheadM < 18 && lookBehindM < 18) continue;

      const aheadPt = interpolateAlongChain(chain, s + Math.max(18, lookAheadM));
      const behindPt = interpolateAlongChain(chain, s - Math.max(18, lookBehindM));

      const bearingFwd = compassBearingDeg(origin.lat, origin.lng, aheadPt.lat, aheadPt.lng);
      const bearingRev = compassBearingDeg(origin.lat, origin.lng, behindPt.lat, behindPt.lng);

      // Measure bend angle across +-40 m so we prefer straight highway stretches
      const forwardFromBehind = compassBearingDeg(behindPt.lat, behindPt.lng, origin.lat, origin.lng);
      const turnAngleDeg = shortestAngleDiff(forwardFromBehind, bearingFwd);
      if (turnAngleDeg > 28) continue;

      // Gather nearby Ramboll accidents within 500 m
      const gx = Math.floor(origin.lng / ACC_CELL_DEG);
      const gy = Math.floor(origin.lat / ACC_CELL_DEG);
      let acc500 = 0;
      let wtd = 0;
      let roe = 0;
      let moose = 0;
      let kernelDensity = 0;
      let fwdDirectionalHits = 0;
      let revDirectionalHits = 0;
      const nearbyIndices: number[] = [];

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const bucket = accidentBuckets.get(`${gx + dx}:${gy + dy}`);
          if (!bucket) continue;
          for (const accIdx of bucket) {
            const acc = accidents[accIdx];
            const dist = groundDistanceM(origin.lat, origin.lng, acc.lat, acc.lng);
            if (dist <= 500) {
              acc500++;
              nearbyIndices.push(accIdx);
              if (acc.speciesClass === 1) moose++;
              else if (acc.speciesClass === 3) roe++;
              else wtd++;

              // Sharp kernel strongly rewarding tight (<165m) collision blackspots
              const w =
                dist <= 85
                  ? 5.6
                  : dist <= 165
                    ? 3.4
                    : dist <= 280
                      ? 1.5
                      : 0.5;
              const speciesMultiplier = acc.speciesClass === 1 ? 1.25 : 1.0;
              kernelDensity += w * speciesMultiplier;

              if (dist >= 8 && dist <= 145) {
                const bToAcc = compassBearingDeg(origin.lat, origin.lng, acc.lat, acc.lng);
                if (shortestAngleDiff(bToAcc, bearingFwd) <= 45) fwdDirectionalHits++;
                if (shortestAngleDiff(bToAcc, bearingRev) <= 45) revDirectionalHits++;
              }
            }
          }
        }
      }

      const fwdSight30 = projectPointMeters(origin.lat, origin.lng, 30, bearingFwd);
      const revSight30 = projectPointMeters(origin.lat, origin.lng, 30, bearingRev);
      const fwdErrM = distancePointToChainM(fwdSight30.lat, fwdSight30.lng, chain);
      const revErrM = distancePointToChainM(revSight30.lat, revSight30.lng, chain);
      const fwdOk = fwdErrM <= 3.4;
      const revOk = revErrM <= 3.4;
      if (!fwdOk && !revOk) continue;

      let chosenBearing: number;
      let altBearingDeg: number | null = null;

      if (fwdOk && revOk) {
        chosenBearing = fwdDirectionalHits >= revDirectionalHits ? bearingFwd : bearingRev;
        if (Math.abs(fwdDirectionalHits - revDirectionalHits) <= 3) {
          altBearingDeg = chosenBearing === bearingFwd ? bearingRev : bearingFwd;
        }
      } else {
        chosenBearing = fwdOk ? bearingFwd : bearingRev;
      }

      const straightnessBonus = Math.max(0.7, 1.0 - turnAngleDeg / 55);
      // Nonlinear collision priority exponent concentrates cameras densely on proven hotspots
      const collisionPriority = Math.pow(kernelDensity, 1.38) * 2.2 + acc500 * 0.8;
      const score = (collisionPriority + chain.hierarchyWeight * 0.25) * straightnessBonus;

      candidates.push({
        chainIdx,
        stationDistM: s,
        lat: Number(origin.lat.toFixed(5)),
        lng: Number(origin.lng.toFixed(5)),
        bearingDeg: chosenBearing,
        altBearingDeg,
        roadLabel: chain.roadLabel,
        hierarchyWeight: chain.hierarchyWeight,
        turnAngleDeg,
        score,
        accidents500m: acc500,
        whiteTailedDeer: wtd,
        roeDeer: roe,
        moose,
        nearbyAccidentIndices: nearbyIndices,
      });
    }
  }

  if (candidates.length === 0) {
    throw new Error(
      `Found roads within ${radiusKm} km, but none had straight motor-road segments suitable for camera sightlines. Try increasing the radius slightly.`
    );
  }

  candidates.sort((a, b) => b.score - a.score || b.accidents500m - a.accidents500m);

  // Priority-adaptive spacing: high-priority Ramboll collision stretches receive dense 80–120 m
  // roadside coverage, whereas lower-priority corridors stay widely spaced unless spare units remain.
  const topScore = Math.max(1, candidates[0].score);
  const topAcc = Math.max(1, candidates[0].accidents500m);

  const computeRequiredSpacingM = (cand: CandidateRoadStation, passScale: number): number => {
    const normScore = cand.score / topScore;
    const normAcc = cand.accidents500m / Math.max(8, topAcc * 0.85);
    const priorityRatio = Math.min(1, Math.max(normScore, normAcc));

    let rawSpacingM: number;
    if (priorityRatio >= 0.58 || cand.accidents500m >= 12) {
      // Critical collision blackspot: tight 78–118 m spacing along the hotspot corridor
      rawSpacingM = Math.max(76, Math.min(118, 72 + radiusKm * 1.8));
    } else if (priorityRatio >= 0.30 || cand.accidents500m >= 6) {
      // High-priority corridor: 130–210 m spacing
      rawSpacingM = Math.max(125, Math.min(215, 110 + radiusKm * 3.8));
    } else if (priorityRatio >= 0.14 || cand.accidents500m >= 3) {
      // Moderate corridor: 220–380 m spacing
      rawSpacingM = Math.max(210, Math.min(390, 180 + radiusKm * 7.5));
    } else {
      // Low-priority background roads: wide 400–880 m spacing
      rawSpacingM = Math.max(380, Math.min(880, radiusKm * 34));
    }
    return Math.max(58, Math.round(rawSpacingM * passScale));
  };

  const selected: CandidateRoadStation[] = [];
  const pickedIndices = new Set<number>();

  for (const passScale of [1.0, 0.74, 0.54, 0.4]) {
    if (selected.length >= TARGET_CAMERA_COUNT) break;
    for (let i = 0; i < candidates.length && selected.length < TARGET_CAMERA_COUNT; i++) {
      if (pickedIndices.has(i)) continue;
      const cand = candidates[i];
      const minSpacingM = computeRequiredSpacingM(cand, passScale);
      let tooClose = false;
      for (const existing of selected) {
        if (groundDistanceM(cand.lat, cand.lng, existing.lat, existing.lng) < minSpacingM) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) {
        pickedIndices.add(i);
        selected.push(cand);
      }
    }
  }

  // Alternate bidirectional bearings on adjacent tightly-spaced stations along the same road chain
  const byChain = new Map<number, CandidateRoadStation[]>();
  for (const st of selected) {
    const arr = byChain.get(st.chainIdx);
    if (arr) arr.push(st);
    else byChain.set(st.chainIdx, [st]);
  }
  for (const arr of byChain.values()) {
    if (arr.length < 2) continue;
    arr.sort((a, b) => a.stationDistM - b.stationDistM);
    for (let k = 1; k < arr.length; k++) {
      const prev = arr[k - 1];
      const cur = arr[k];
      if (
        cur.altBearingDeg !== null &&
        cur.stationDistM - prev.stationDistM <= 260 &&
        shortestAngleDiff(prev.bearingDeg, cur.bearingDeg) < 25
      ) {
        cur.bearingDeg = cur.altBearingDeg;
      }
    }
  }

  // Final sort by historical collision count + score so CUS-001 is the #1 hotspot in the radius
  selected.sort((a, b) => b.accidents500m - a.accidents500m || b.score - a.score);

  const coveredAccidentSet = new Set<number>();
  const roadCounter = new Map<string, number>();

  const cameras: PlannedCameraNode[] = selected.map((st, idx) => {
    const unitNumber = idx + 1;
    for (const accIdx of st.nearbyAccidentIndices) {
      coveredAccidentSet.add(accIdx);
    }
    const cleanRoadKey = st.roadLabel.split(' (')[0];
    roadCounter.set(cleanRoadKey, (roadCounter.get(cleanRoadKey) ?? 0) + 1);

    const sectorIndex = assignAngularSector(lat, lng, st.lat, st.lng);
    return {
      id: `CUS-${String(unitNumber).padStart(3, '0')}`,
      cityId: 'custom-area',
      cityName: label,
      sectorIndex,
      sectorName: `${label} (${radiusKm} km Radius)`,
      sectorPeriod: 'Jan 1 – Dec 31',
      unitNumber,
      rankInSector: unitNumber,
      rankInCity: unitNumber,
      clusterIndex: unitNumber,
      clusterSize: 1,
      roadLabel: st.roadLabel,
      clusterLabel: `Hotspot #${unitNumber} · ${st.roadLabel}`,
      lat: st.lat,
      lng: st.lng,
      bearingDeg: st.bearingDeg,
      historicalAccidents: st.accidents500m,
      whiteTailedDeer: st.whiteTailedDeer,
      roeDeer: st.roeDeer,
      moose: st.moose,
    };
  });

  const topRoads = Array.from(roadCounter.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([r]) => r);

  return {
    id: 'custom-area',
    label,
    center: { lat: Number(lat.toFixed(5)), lng: Number(lng.toFixed(5)) },
    radiusKm,
    areaKm2: Number((Math.PI * radiusKm * radiusKm).toFixed(1)),
    roadNetworkKm,
    targetCameraCount: TARGET_CAMERA_COUNT,
    dataSourceUrl: RAMBOLL_SOURCE_URL,
    dataPeriod: '2021–2025',
    totalAccidentsInRadius: accidents.length,
    corridorAccidentsNearCameras: coveredAccidentSet.size,
    speciesTotals,
    byYear,
    primaryRoads: topRoads.length > 0 ? topRoads.join(' · ') : 'Local roads',
    hotspots,
    cameras,
  };
}
