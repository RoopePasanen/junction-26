import type {
  PlannedCameraNode,
  SpeciesCollisionBreakdown,
} from '../data/finlandWildlifePlan.ts';
import {
  MAX_PLOTTED_CAMERAS,
  MIN_PLOTTED_CAMERAS,
  type CustomAreaPlanResult,
  type CustomAreaRequestParams,
  type DrawnAreaPlotRequestParams,
} from '../types/customAreaPlan.ts';
import {
  computePolygonAreaKm2,
  computePolygonBBox,
  isPointInLatLngPolygon,
  type SimpleLatLng,
} from '../utils/polygonGeometry.ts';
import {
  queryLocalAccidentsForPolygon,
  queryLocalWarningCorridorsInBbox,
} from './rambollLocalStore.ts';

const RAMBOLL_SOURCE_URL = 'https://mobilityanalytics.ramboll.com/onn/hirvielain/';
const VAYLA_OGC_BASE_URL =
  'https://avoinapi.vaylapilvi.fi/vaylatiedot/ogc/features/v1/collections';

const EARTH_RADIUS_M = 6_371_008.8;
const ROADSIDE_SHOULDER_OFFSET_M = 2.5;

export interface DecodedRambollAccident {
  lat: number;
  lng: number;
  speciesClass: number; // 1=moose, 2=fallowDeer, 3=roeDeer, 4=forestReindeer, 5=whiteTailedDeer
  year: number;
  month: number;
}

/**
 * Road size hierarchy matching the base map's visual road classification:
 * 1 = Large (orange-hued) roads: all state-numbered highways/regional/connecting roads (Vt, Kt, St, Yt 1–19999)
 *     plus municipal main arterials & Class I–II cartographic collectors (`toiminn_lk <= 3` or `mtk_tie_lk <= 12122`).
 * 2 = Small (non-orange / white-grey) roads: minor local & residential streets (`toiminn_lk >= 5` or `mtk_tie_lk >= 12131`),
 *     used only when an area has no orange roads or after all orange roads in the area are properly covered.
 */
export type RoadHierarchyTier = 1 | 2;

interface RawRoadLink {
  roadLabel: string;
  roadTier: RoadHierarchyTier;
  hierarchyWeight: number;
  coords: Array<[number, number]>; // [lng, lat][]
}

interface RoadSegmentChain {
  roadLabel: string;
  roadTier: RoadHierarchyTier;
  hierarchyWeight: number;
  coords: Array<[number, number]>; // [lng, lat][]
  cumDistM: number[];
  totalLengthM: number;
}

export interface HierarchicalStationCandidate {
  chainIdx: number;
  stationDistM: number;
  lat: number;
  lng: number;
  roadTier: RoadHierarchyTier;
  hierarchyWeight: number;
  score: number;
  accidents500m: number;
}

interface CandidateRoadStation extends HierarchicalStationCandidate {
  bearingDeg: number;
  reverseBearingDeg: number;
  roadLabel: string;
  turnAngleDeg: number;
  whiteTailedDeer: number;
  roeDeer: number;
  moose: number;
  nearbyInsideIndices: number[];
}

export interface UrbanStreetSample {
  lat: number;
  lng: number;
  lengthM: number;
  hasAddress: boolean;
}

export interface RawUrbanCentreData {
  crosswalks: Array<[number, number]>; // [lng, lat][]
  trafficLights: Array<[number, number]>; // [lng, lat][]
  municipalStreets: UrbanStreetSample[];
}

export interface UrbanCentreSpatialIndex {
  crosswalkBuckets: Map<string, Array<[number, number]>>;
  trafficLightBuckets: Map<string, Array<[number, number]>>;
  streetBuckets: Map<string, UrbanStreetSample[]>;
}

interface CachedRoadBboxData {
  links: RawRoadLink[];
  urbanCentreIndex: UrbanCentreSpatialIndex;
}

const URBAN_CELL_LAT_DEG = 0.006; // ~667 m
const URBAN_CELL_LNG_DEG = 0.018; // >= 682 m across all latitudes in Finland (59.5°N–70.1°N)

function urbanCellKey(lat: number, lng: number): string {
  return `${Math.floor(lng / URBAN_CELL_LNG_DEG)}:${Math.floor(lat / URBAN_CELL_LAT_DEG)}`;
}

export function buildUrbanCentreIndex(raw: RawUrbanCentreData): UrbanCentreSpatialIndex {
  const crosswalkBuckets = new Map<string, Array<[number, number]>>();
  const trafficLightBuckets = new Map<string, Array<[number, number]>>();
  const streetBuckets = new Map<string, UrbanStreetSample[]>();

  for (const pt of raw.crosswalks) {
    const key = urbanCellKey(pt[1], pt[0]);
    const list = crosswalkBuckets.get(key);
    if (list) list.push(pt);
    else crosswalkBuckets.set(key, [pt]);
  }

  for (const pt of raw.trafficLights) {
    const key = urbanCellKey(pt[1], pt[0]);
    const list = trafficLightBuckets.get(key);
    if (list) list.push(pt);
    else trafficLightBuckets.set(key, [pt]);
  }

  for (const st of raw.municipalStreets) {
    const key = urbanCellKey(st.lat, st.lng);
    const list = streetBuckets.get(key);
    if (list) list.push(st);
    else streetBuckets.set(key, [st]);
  }

  return { crosswalkBuckets, trafficLightBuckets, streetBuckets };
}

/**
 * Determines whether `(lat, lng)` lies inside a built-up city/town centre area (`keskusta`),
 * combining pedestrian crosswalk density (`>= 28` within 600 m), signalized downtown intersection
 * density (`>= 10` within 550 m inside an addressed street grid, or `>= 12` when street data is omitted),
 * and addressed municipal street-grid density (`>= 10.8 km` and `>= 80` addressed street blocks within 600 m).
 */
export function isPointInCityCentreArea(
  lat: number,
  lng: number,
  index: UrbanCentreSpatialIndex
): boolean {
  const gx = Math.floor(lng / URBAN_CELL_LNG_DEG);
  const gy = Math.floor(lat / URBAN_CELL_LAT_DEG);
  const hasStreetData = index.streetBuckets.size > 0;

  let crosswalks600 = 0;
  let trafficLights550 = 0;
  let muniStreetMeters600 = 0;
  let addressedLinks600 = 0;

  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const key = `${gx + dx}:${gy + dy}`;

      const cwList = index.crosswalkBuckets.get(key);
      if (cwList) {
        for (const [cLng, cLat] of cwList) {
          if (groundDistanceM(lat, lng, cLat, cLng) <= 600) {
            crosswalks600++;
            if (crosswalks600 >= 28) return true;
          }
        }
      }

      const tlList = index.trafficLightBuckets.get(key);
      if (tlList) {
        for (const [tLng, tLat] of tlList) {
          if (groundDistanceM(lat, lng, tLat, tLng) <= 550) {
            trafficLights550++;
            if (!hasStreetData && trafficLights550 >= 12) return true;
          }
        }
      }

      const stList = index.streetBuckets.get(key);
      if (stList) {
        for (const st of stList) {
          if (groundDistanceM(lat, lng, st.lat, st.lng) <= 600) {
            muniStreetMeters600 += st.lengthM;
            if (st.hasAddress) addressedLinks600++;
          }
        }
      }
    }
  }

  if (hasStreetData && trafficLights550 >= 10 && addressedLinks600 >= 45) {
    return true;
  }

  return muniStreetMeters600 >= 10_800 && addressedLinks600 >= 80;
}

// Bounded LRU cache of unclipped Väylävirasto road links + urban centre spatial index by quantized bbox
const roadBboxCache = new Map<string, CachedRoadBboxData>();
const MAX_ROAD_BBOX_CACHE = 36;

function getCachedRoads(key: string): CachedRoadBboxData | undefined {
  const hit = roadBboxCache.get(key);
  if (!hit) return undefined;
  roadBboxCache.delete(key);
  roadBboxCache.set(key, hit);
  return hit;
}

function setCachedRoads(key: string, data: CachedRoadBboxData): void {
  if (roadBboxCache.has(key)) {
    roadBboxCache.delete(key);
  } else if (roadBboxCache.size >= MAX_ROAD_BBOX_CACHE) {
    const oldest = roadBboxCache.keys().next().value;
    if (oldest !== undefined) roadBboxCache.delete(oldest);
  }
  roadBboxCache.set(key, data);
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

/**
 * Classifies an official Finnish state road number (`tie` in Väylävirasto tieosoiteverkko / Digiroad).
 * All state-numbered motor corridors (`tie 1..19999`: Vt, Kt, St, and Yt) are rendered with an orange hue on the base map
 * and therefore belong to `roadTier = 1` ("large" orange roads), with gently graduated prominence weights.
 * Returns `null` for non-corridor links (`tie >= 20000`: interchange slip ramps, service links, and `70000+` cycle/pedestrian paths).
 */
export function classifyStateRoad(
  tie: number,
  _fallbackName?: string
): {
  label: string;
  roadTier: RoadHierarchyTier;
  weight: number;
} | null {
  if (!Number.isFinite(tie) || tie < 1 || tie > 19999) {
    return null;
  }
  if (tie >= 1 && tie <= 39) {
    return { label: `Vt ${tie}`, roadTier: 1, weight: 1.55 };
  }
  if (tie >= 40 && tie <= 99) {
    return { label: `Kt ${tie}`, roadTier: 1, weight: 1.42 };
  }
  if (tie >= 100 && tie <= 999) {
    return { label: `St ${tie}`, roadTier: 1, weight: 1.3 };
  }
  if (tie >= 1000 && tie <= 9999) {
    return { label: `Yt ${tie}`, roadTier: 1, weight: 1.18 };
  }
  return { label: `Yt ${tie}`, roadTier: 1, weight: 1.0 };
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

/**
 * Densifies long straight segments (step <= 20 m) before polygon clipping so that even a narrow
 * user-drawn box across a highway between two distant vertices captures the road cleanly.
 */
function clipPolylineInsidePolygon(
  line: Array<[number, number]>,
  polygon: ReadonlyArray<SimpleLatLng>,
  bbox: { minLat: number; maxLat: number; minLng: number; maxLng: number }
): Array<Array<[number, number]>> {
  if (line.length < 2) return [];

  const densified: Array<[number, number]> = [line[0]];
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const segLenM = groundDistanceM(a[1], a[0], b[1], b[0]);
    if (segLenM > 20) {
      const steps = Math.min(200, Math.ceil(segLenM / 20));
      for (let s = 1; s < steps; s++) {
        const t = s / steps;
        densified.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    densified.push(b);
  }

  const sublines: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];

  for (const pt of densified) {
    const [lng, lat] = pt;
    const inside =
      lat >= bbox.minLat &&
      lat <= bbox.maxLat &&
      lng >= bbox.minLng &&
      lng <= bbox.maxLng &&
      isPointInLatLngPolygon(lat, lng, polygon);

    if (inside) {
      current.push(pt);
    } else {
      if (current.length >= 2) sublines.push(current);
      current = [];
    }
  }
  if (current.length >= 2) sublines.push(current);
  return sublines;
}

async function fetchUnclippedRoadsInBbox(
  minLat: number,
  maxLat: number,
  minLng: number,
  maxLng: number,
  maxSpanKm: number
): Promise<CachedRoadBboxData> {
  // Quantize bbox slightly (~300m) so small redraws or repeat camera-count updates hit cache immediately
  const qMinLng = (Math.floor(minLng * 250) / 250).toFixed(4);
  const qMinLat = (Math.floor(minLat * 250) / 250).toFixed(4);
  const qMaxLng = (Math.ceil(maxLng * 250) / 250).toFixed(4);
  const qMaxLat = (Math.ceil(maxLat * 250) / 250).toFixed(4);
  const includeDigiroad = maxSpanKm <= 38;
  const includeUrbanSignals = maxSpanKm <= 90;
  const cacheKey = `v5:${qMinLng},${qMinLat},${qMaxLng},${qMaxLat}:dr=${includeDigiroad ? 1 : 0}`;

  const cached = getCachedRoads(cacheKey);
  if (cached) return cached;

  const bboxStr = `${qMinLng},${qMinLat},${qMaxLng},${qMaxLat}`;
  // Pad urban-centre query bbox by ~750 m so roads near the polygon boundary still detect adjacent city centres
  const uMinLng = (Number(qMinLng) - 0.014).toFixed(4);
  const uMinLat = (Number(qMinLat) - 0.007).toFixed(4);
  const uMaxLng = (Number(qMaxLng) + 0.014).toFixed(4);
  const uMaxLat = (Number(qMaxLat) + 0.007).toFixed(4);
  const urbanBboxStr = `${uMinLng},${uMinLat},${uMaxLng},${uMaxLat}`;
  const digiroadFilter = encodeURIComponent('hallinn_lk IN (1,2) AND linkkityyp<=5');

  const stateRoadsUrl = `${VAYLA_OGC_BASE_URL}/tiestotiedot:tieosoiteverkko/items?f=json&limit=10000&bbox=${bboxStr}`;
  const digiroadUrl = includeDigiroad
    ? `${VAYLA_OGC_BASE_URL}/digiroad:dr_tielinkki_toim_lk/items?f=json&limit=10000&filter=${digiroadFilter}&bbox=${urbanBboxStr}`
    : null;
  const crosswalksUrl = includeUrbanSignals
    ? `${VAYLA_OGC_BASE_URL}/digiroad:dr_suojatie/items?f=json&limit=10000&bbox=${urbanBboxStr}`
    : null;
  const trafficLightsUrl = includeUrbanSignals
    ? `${VAYLA_OGC_BASE_URL}/digiroad:dr_liikennevalo/items?f=json&limit=3000&bbox=${urbanBboxStr}`
    : null;

  const fetchJson = (url: string | null) =>
    url
      ? fetch(url, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(10_000),
        }).catch(() => null)
      : Promise.resolve(null);

  const [stateRes, digiRes, crosswalkRes, trafficLightRes] = await Promise.all([
    fetchJson(stateRoadsUrl),
    fetchJson(digiroadUrl),
    fetchJson(crosswalksUrl),
    fetchJson(trafficLightsUrl),
  ]);

  const extractLines = (
    geomType: string | undefined,
    rawCoords: unknown
  ): Array<Array<[number, number]>> => {
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

  const rawLinks: RawRoadLink[] = [];
  let loadedStateRoads = false;

  // 1. Authoritative Finnish state highway network (Vt, Kt, St, Yt: tie 1..19999, single-centerline ajorata <= 1)
  if (stateRes && stateRes.ok) {
    try {
      const gj = (await stateRes.json()) as GeoJsonFeatureCollection;
      for (const f of gj.features ?? []) {
        const p = f.properties ?? {};
        const ajorata = Number(p.ajorata ?? 0);
        if (ajorata > 1) continue;
        const tie = Number(p.tie ?? 0);
        const nimi = typeof p.nimi === 'string' ? p.nimi.trim() : '';
        const classified = classifyStateRoad(tie, nimi);
        if (!classified) continue;

        for (const ln of extractLines(f.geometry?.type, f.geometry?.coordinates)) {
          if (ln.length >= 2) {
            rawLinks.push({
              roadLabel: classified.label,
              roadTier: classified.roadTier,
              hierarchyWeight: classified.weight,
              coords: ln,
            });
            loadedStateRoads = true;
          }
        }
      }
    } catch {
      loadedStateRoads = false;
    }
  }

  // 2. Municipal arterials, collectors, and local streets from Digiroad (plus municipal street-grid samples for city-centre exclusion)
  const municipalStreets: UrbanStreetSample[] = [];
  if (digiRes && digiRes.ok) {
    try {
      const gj = (await digiRes.json()) as GeoJsonFeatureCollection;
      const feats = gj.features ?? [];
      for (const f of feats) {
        const p = f.properties ?? {};
        const linkkiTyyp = Number(p.linkkityyp ?? 3);
        const hallinnLk = Number(p.hallinn_lk ?? 2);
        const toiminnLk = Number(p.toiminn_lk ?? 5);

        // Record municipal motor street segments (hallinn_lk === 2, linkkityyp 1..5) for city-centre density detection
        if (hallinnLk === 2 && linkkiTyyp >= 1 && linkkiTyyp <= 5) {
          const hasAddress = p.ens_talo_v != null || p.ens_talo_o != null;
          for (const ln of extractLines(f.geometry?.type, f.geometry?.coordinates)) {
            if (ln.length >= 2) {
              const mid = ln[Math.floor(ln.length / 2)];
              let lengthM = 0;
              for (let k = 0; k < ln.length - 1; k++) {
                lengthM += groundDistanceM(ln[k][1], ln[k][0], ln[k + 1][1], ln[k + 1][0]);
              }
              municipalStreets.push({
                lat: mid[1],
                lng: mid[0],
                lengthM,
                hasAddress,
              });
            }
          }
        }

        // Restrict candidate roads strictly to motor carriageways (1..4); excludes roundabouts (5), slip ramps (6), and cycle/footpaths (8,9,12)
        if (linkkiTyyp < 1 || linkkiTyyp > 4) continue;
        if (hallinnLk !== 1 && toiminnLk > 5) continue;
        if (loadedStateRoads && hallinnLk === 1) continue;

        const tieNum = Number(p.tienumero ?? 0);
        const mtkTieLk = Number(p.mtk_tie_lk ?? 0);
        const streetName = typeof p.tienimi_su === 'string' ? p.tienimi_su.trim() : '';
        if (/kevyen liikenteen|\bramp(pi|it)\b/i.test(streetName)) continue;

        const isOrangeMunicipalArterial =
          toiminnLk <= 3 || (toiminnLk === 4 && mtkTieLk > 0 && mtkTieLk <= 12122);

        let roadLabel = streetName || (isOrangeMunicipalArterial ? 'Main arterial' : 'Local street');
        let roadTier: RoadHierarchyTier = isOrangeMunicipalArterial ? 1 : 2;
        let hierarchyWeight =
          toiminnLk <= 2
            ? 1.3
            : toiminnLk === 3
              ? 1.15
              : isOrangeMunicipalArterial
                ? 1.0
                : 0.5;

        if (hallinnLk === 1 || tieNum > 0) {
          const classified = classifyStateRoad(tieNum, streetName);
          if (!classified) continue;
          roadLabel = classified.label;
          roadTier = classified.roadTier;
          hierarchyWeight = classified.weight;
        }

        for (const ln of extractLines(f.geometry?.type, f.geometry?.coordinates)) {
          if (ln.length >= 2) {
            rawLinks.push({ roadLabel, roadTier, hierarchyWeight, coords: ln });
          }
        }
      }
    } catch {
      // Keep state roads already loaded
    }
  }

  // 3. Extract pedestrian crosswalks & traffic signals for city-centre exclusion
  const extractPoints = async (res: Response | null): Promise<Array<[number, number]>> => {
    if (!res || !res.ok) return [];
    try {
      const gj = (await res.json()) as GeoJsonFeatureCollection;
      const pts: Array<[number, number]> = [];
      for (const f of gj.features ?? []) {
        const c = f.geometry?.coordinates;
        if (f.geometry?.type === 'Point' && Array.isArray(c) && c.length >= 2) {
          const lng = Number(c[0]);
          const lat = Number(c[1]);
          if (Number.isFinite(lat) && Number.isFinite(lng)) {
            pts.push([lng, lat]);
          }
        }
      }
      return pts;
    } catch {
      return [];
    }
  };

  const [crosswalks, trafficLights] = await Promise.all([
    extractPoints(crosswalkRes),
    extractPoints(trafficLightRes),
  ]);

  const urbanCentreIndex = buildUrbanCentreIndex({
    crosswalks,
    trafficLights,
    municipalStreets,
  });

  // Offline fallback: if Väylävirasto is unreachable, use downloaded local Ramboll wildlife warning road segments
  if (rawLinks.length === 0) {
    const localCorridors = queryLocalWarningCorridorsInBbox(minLat, maxLat, minLng, maxLng);
    for (const wc of localCorridors) {
      rawLinks.push({
        roadLabel: 'Wildlife corridor road',
        roadTier: 1,
        hierarchyWeight: 1.4,
        coords: wc.coords,
      });
    }
    return { links: rawLinks, urbanCentreIndex };
  }

  const payload: CachedRoadBboxData = { links: rawLinks, urbanCentreIndex };
  setCachedRoads(cacheKey, payload);
  return payload;
}

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
    if (totalLengthM >= 45) {
      chains.push({
        roadLabel: seed.roadLabel,
        roadTier: seed.roadTier,
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

/**
 * Simplifies a road coordinate chain ([lng, lat][]) via iterative Ramer–Douglas–Peucker (RDP)
 * within `toleranceM` meters so every road bend and corner near cameras is preserved accurately.
 */
export function simplifyRoadCoordsMeters(
  coords: ReadonlyArray<[number, number]>,
  toleranceM = 1.8
): Array<[number, number]> {
  if (coords.length <= 2) {
    return coords.map(([lng, lat]) => [Number(lng.toFixed(6)), Number(lat.toFixed(6))]);
  }

  const meanLat = (coords[0][1] + coords[coords.length - 1][1]) / 2;
  const mPerDegLat = (Math.PI / 180) * EARTH_RADIUS_M;
  const mPerDegLng = mPerDegLat * Math.cos((meanLat * Math.PI) / 180);

  const keep = new Uint8Array(coords.length);
  keep[0] = 1;
  keep[coords.length - 1] = 1;

  const stack: Array<[number, number]> = [[0, coords.length - 1]];
  while (stack.length > 0) {
    const [startIdx, endIdx] = stack.pop()!;
    if (endIdx - startIdx <= 1) continue;

    const ax = coords[startIdx][0] * mPerDegLng;
    const ay = coords[startIdx][1] * mPerDegLat;
    const bx = coords[endIdx][0] * mPerDegLng;
    const by = coords[endIdx][1] * mPerDegLat;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;

    let maxDist = -1;
    let splitIdx = -1;

    for (let i = startIdx + 1; i < endIdx; i++) {
      const px = coords[i][0] * mPerDegLng;
      const py = coords[i][1] * mPerDegLat;
      let d: number;
      if (lenSq > 1e-9) {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      } else {
        d = Math.hypot(px - ax, py - ay);
      }
      if (d > maxDist) {
        maxDist = d;
        splitIdx = i;
      }
    }

    if (splitIdx !== -1 && maxDist > toleranceM) {
      keep[splitIdx] = 1;
      stack.push([startIdx, splitIdx]);
      stack.push([splitIdx, endIdx]);
    } else if (endIdx - startIdx >= 2 && Math.sqrt(lenSq) > 320) {
      const midIdx = Math.floor((startIdx + endIdx) / 2);
      keep[midIdx] = 1;
      stack.push([startIdx, midIdx]);
      stack.push([midIdx, endIdx]);
    }
  }

  const result: Array<[number, number]> = [];
  for (let i = 0; i < coords.length; i++) {
    if (keep[i]) {
      result.push([Number(coords[i][0].toFixed(6)), Number(coords[i][1].toFixed(6))]);
    }
  }
  return result;
}

function extractSimulationRoadPolylines(
  chains: ReadonlyArray<RoadSegmentChain>,
  cameraChainIndices: ReadonlySet<number>,
  maxTotalVertices = 20_000
): Array<Array<[number, number]>> {
  const indexed = chains.map((chain, idx) => ({
    chain,
    hasCamera: cameraChainIndices.has(idx),
  }));
  indexed.sort((a, b) => {
    if (a.hasCamera !== b.hasCamera) return a.hasCamera ? -1 : 1;
    return (
      b.chain.hierarchyWeight - a.chain.hierarchyWeight ||
      b.chain.totalLengthM - a.chain.totalLengthM
    );
  });

  const polylines: Array<Array<[number, number]>> = [];
  let vertexBudgetUsed = 0;

  for (const { chain, hasCamera } of indexed) {
    const simplified = simplifyRoadCoordsMeters(chain.coords, 1.8);
    if (simplified.length < 2) continue;
    if (
      !hasCamera &&
      vertexBudgetUsed + simplified.length > maxTotalVertices &&
      polylines.length >= 40
    ) {
      continue;
    }
    polylines.push(simplified);
    vertexBudgetUsed += simplified.length;
  }

  return polylines;
}

/**
 * Places a camera on the roadside shoulder (~2.5 m perpendicular to the road centerline)
 * and aims its dual lenses directly along the road in both directions (`aheadTarget` and `behindTarget`).
 */
function computeRoadsideMount(
  centerlineOrigin: { lat: number; lng: number },
  roadTangentBearing: number,
  aheadTarget: { lat: number; lng: number } | null,
  behindTarget: { lat: number; lng: number } | null,
  polygon: ReadonlyArray<SimpleLatLng>
): { lat: number; lng: number; bearingDeg: number; reverseBearingDeg: number } {
  let mountLat = centerlineOrigin.lat;
  let mountLng = centerlineOrigin.lng;

  const rightShoulder = projectPointMeters(
    centerlineOrigin.lat,
    centerlineOrigin.lng,
    ROADSIDE_SHOULDER_OFFSET_M,
    (roadTangentBearing + 90) % 360
  );
  if (isPointInLatLngPolygon(rightShoulder.lat, rightShoulder.lng, polygon)) {
    mountLat = rightShoulder.lat;
    mountLng = rightShoulder.lng;
  } else {
    const leftShoulder = projectPointMeters(
      centerlineOrigin.lat,
      centerlineOrigin.lng,
      ROADSIDE_SHOULDER_OFFSET_M,
      (roadTangentBearing + 270) % 360
    );
    if (isPointInLatLngPolygon(leftShoulder.lat, leftShoulder.lng, polygon)) {
      mountLat = leftShoulder.lat;
      mountLng = leftShoulder.lng;
    }
  }

  let bearingDeg: number;
  let reverseBearingDeg: number;

  if (aheadTarget && behindTarget) {
    bearingDeg = compassBearingDeg(mountLat, mountLng, aheadTarget.lat, aheadTarget.lng);
    reverseBearingDeg = compassBearingDeg(mountLat, mountLng, behindTarget.lat, behindTarget.lng);
  } else if (aheadTarget) {
    bearingDeg = compassBearingDeg(mountLat, mountLng, aheadTarget.lat, aheadTarget.lng);
    reverseBearingDeg = (bearingDeg + 180) % 360;
  } else if (behindTarget) {
    bearingDeg = compassBearingDeg(mountLat, mountLng, behindTarget.lat, behindTarget.lng);
    reverseBearingDeg = (bearingDeg + 180) % 360;
  } else {
    bearingDeg = ((Math.round(roadTangentBearing) % 360) + 360) % 360;
    reverseBearingDeg = (bearingDeg + 180) % 360;
  }

  return {
    lat: Number(mountLat.toFixed(6)),
    lng: Number(mountLng.toFixed(6)),
    bearingDeg,
    reverseBearingDeg,
  };
}

/**
 * Selects roadside camera stations using a strict road-size hierarchy waterfall (Tier 1 largest -> Tier 5 smallest):
 * - Cameras are placed exclusively on the largest road tier present until either `targetCameraCount` is reached
 *   OR every road in that tier is properly covered end-to-end (no candidate station >= `1.25 * sightRangeM`
 *   away from a placed camera, guaranteeing ~`2 * sightRangeM` tip-to-tip bidirectional coverage without redundant cone stacking).
 * - Only once all larger roads are properly covered do remaining cameras spill onto smaller road tiers.
 * - Within each tier, stations spread evenly along that tier's corridors weighted by wildlife activity and `hierarchyWeight`.
 */
export function selectRoadStationsByHierarchy<T extends HierarchicalStationCandidate>(
  rawCandidates: readonly T[],
  chainLengthByIdx: ReadonlyMap<number, number>,
  targetCameraCount: number,
  sightRangeM: number
): T[] {
  if (rawCandidates.length === 0 || targetCameraCount <= 0) {
    return [];
  }

  const candidates = [...rawCandidates].sort(
    (a, b) => a.roadTier - b.roadTier || b.score - a.score || b.accidents500m - a.accidents500m
  );

  const properCoverageMinSpacingM = Math.max(20, sightRangeM * 1.25);
  const selected: T[] = [];
  const pickedMask = new Uint8Array(candidates.length);
  const minGroundDistM = new Float64Array(candidates.length).fill(Infinity);
  const minSameChainDistM = new Float64Array(candidates.length).fill(Infinity);

  const selectCandidateAt = (pickIdx: number) => {
    pickedMask[pickIdx] = 1;
    const chosen = candidates[pickIdx];
    selected.push(chosen);
    for (let j = 0; j < candidates.length; j++) {
      if (pickedMask[j]) continue;
      const other = candidates[j];
      const gd = groundDistanceM(chosen.lat, chosen.lng, other.lat, other.lng);
      if (gd < minGroundDistM[j]) {
        minGroundDistM[j] = gd;
      }
      if (chosen.chainIdx === other.chainIdx) {
        const cd = Math.abs(chosen.stationDistM - other.stationDistM);
        if (cd < minSameChainDistM[j]) {
          minSameChainDistM[j] = cd;
        }
      }
    }
  };

  const tiers: RoadHierarchyTier[] = [1, 2];

  for (const tier of tiers) {
    if (selected.length >= targetCameraCount) break;

    const tierIndices: number[] = [];
    const tierChains = new Set<number>();
    for (let i = 0; i < candidates.length; i++) {
      if (candidates[i].roadTier === tier) {
        tierIndices.push(i);
        tierChains.add(candidates[i].chainIdx);
      }
    }
    if (tierIndices.length === 0) continue;

    let tierRoadM = 0;
    for (const cIdx of tierChains) {
      tierRoadM += chainLengthByIdx.get(cIdx) ?? 200;
    }

    const remainingNeeded = targetCameraCount - selected.length;
    const avgTierRoadPerCamM = tierRoadM / Math.max(1, remainingNeeded);
    const tierIdealSpacingM = Math.max(sightRangeM * 2.05, avgTierRoadPerCamM * 0.75);

    // Seed first camera overall at the highest-scoring station of the largest road tier in the area
    if (selected.length === 0) {
      selectCandidateAt(tierIndices[0]);
    }

    while (selected.length < targetCameraCount) {
      let bestIdx = -1;
      let bestUtility = -1;

      for (let k = 0; k < tierIndices.length; k++) {
        const idx = tierIndices[k];
        if (pickedMask[idx]) continue;

        const gd = minGroundDistM[idx];
        const cd = minSameChainDistM[idx];
        if (gd < properCoverageMinSpacingM || cd < properCoverageMinSpacingM) {
          continue;
        }

        const effectiveSepM = Math.min(gd, cd * 0.92);
        const normDist = effectiveSepM / tierIdealSpacingM;
        const evennessFactor =
          normDist < 1.0
            ? Math.pow(normDist, 3.0)
            : 1.0 + 0.55 * Math.min(1.6, normDist - 1.0);

        const utility = candidates[idx].score * evennessFactor;
        if (utility > bestUtility) {
          bestUtility = utility;
          bestIdx = idx;
        }
      }

      if (bestIdx === -1) {
        // Every road in this tier is now properly covered; advance to the next road tier
        break;
      }
      selectCandidateAt(bestIdx);
    }
  }

  // Dense-infill fallback ONLY if every road tier (1..5) in the polygon is already properly covered
  // and the user requested even more cameras than fit at 1.75x sightRangeM spacing
  for (const tier of tiers) {
    while (selected.length < targetCameraCount) {
      let fallbackIdx = -1;
      let fallbackDist = -1;
      for (let i = 0; i < candidates.length; i++) {
        if (pickedMask[i] || candidates[i].roadTier !== tier) continue;
        if (minGroundDistM[i] >= 18 && minGroundDistM[i] > fallbackDist) {
          fallbackDist = minGroundDistM[i];
          fallbackIdx = i;
        }
      }
      if (fallbackIdx === -1) break;
      selectCandidateAt(fallbackIdx);
    }
  }

  return selected;
}

/**
 * Deterministic roadside camera plotter inside any user-drawn polygon on the Finland map.
 * Uses the locally downloaded 2021–2025 Ramboll wildlife collision dataset (67,081 nationwide points +
 * 27,599 official warning road segments) without accessing external Ramboll endpoints at runtime.
 */
export async function buildPolygonAreaCameraPlan(
  params: DrawnAreaPlotRequestParams
): Promise<CustomAreaPlanResult> {
  const rawPolygon = Array.isArray(params.polygon) ? params.polygon : [];
  const polygon: SimpleLatLng[] = rawPolygon
    .filter(
      (pt) =>
        pt &&
        Number.isFinite(Number(pt.lat)) &&
        Number.isFinite(Number(pt.lng)) &&
        Number(pt.lat) >= 59.3 &&
        Number(pt.lat) <= 70.3 &&
        Number(pt.lng) >= 18.8 &&
        Number(pt.lng) <= 31.8
    )
    .map((pt) => ({ lat: Number(pt.lat), lng: Number(pt.lng) }));

  if (polygon.length < 3) {
    throw new Error('Draw a valid closed area with at least 3 points inside Finland.');
  }

  const targetCameraCount = Math.max(
    MIN_PLOTTED_CAMERAS,
    Math.min(MAX_PLOTTED_CAMERAS, Math.round(Number(params.cameraCount) || 50))
  );
  const sightRangeM = Math.max(15, Math.min(120, Math.round(Number(params.rangeMeters) || 60)));
  const fovDeg = Math.max(10, Math.min(360, Math.round(Number(params.fovDeg) || 30)));

  const bbox = computePolygonBBox(polygon);
  const areaKm2Raw = computePolygonAreaKm2(polygon);
  if (areaKm2Raw < 0.01) {
    throw new Error('The drawn area is too small. Draw a slightly larger area covering a road.');
  }
  if (areaKm2Raw > 35_000) {
    throw new Error('The drawn area is too large (> 35,000 km²). Zoom in and outline a more focused region.');
  }

  const label =
    params.label && params.label.trim().length > 0
      ? params.label.trim()
      : `Drawn Area (${bbox.centerLat.toFixed(2)}°N, ${bbox.centerLng.toFixed(2)}°E)`;

  // 1. Query locally downloaded Ramboll dataset (instant < 2 ms, zero requests to ramboll.com)
  const { insideAccidents, bufferedAccidents, nationwideTotal } =
    queryLocalAccidentsForPolygon(polygon, 500);
  const localWarnings = queryLocalWarningCorridorsInBbox(
    bbox.minLat - 0.005,
    bbox.maxLat + 0.005,
    bbox.minLng - 0.008,
    bbox.maxLng + 0.008
  );

  // 2. Load & clip motor roads strictly inside the user's drawn polygon + build city-centre spatial index
  const maxSpanKm = Math.max(bbox.spanLatKm, bbox.spanLngKm);
  const { links: unclippedLinks, urbanCentreIndex } = await fetchUnclippedRoadsInBbox(
    bbox.minLat,
    bbox.maxLat,
    bbox.minLng,
    bbox.maxLng,
    maxSpanKm
  );

  const clippedLinks: RawRoadLink[] = [];
  for (const link of unclippedLinks) {
    for (const sub of clipPolylineInsidePolygon(link.coords, polygon, bbox)) {
      clippedLinks.push({
        roadLabel: link.roadLabel,
        roadTier: link.roadTier,
        hierarchyWeight: link.hierarchyWeight,
        coords: sub,
      });
    }
  }

  const chains = stitchRoadChains(clippedLinks);
  if (chains.length === 0) {
    throw new Error(
      'No public motor roads were found inside the drawn area. Draw an area that crosses at least one public road or highway.'
    );
  }

  const totalRoadM = chains.reduce((acc, ch) => acc + ch.totalLengthM, 0);
  const roadNetworkKm = Number((totalRoadM / 1000).toFixed(1));

  // 3. Aggregate historical collision statistics strictly inside the drawn polygon
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

  const hotspotGridLat = bbox.equivRadiusKm <= 10 ? 0.0055 : bbox.equivRadiusKm <= 25 ? 0.01 : 0.016;
  const hotspotGridLng = hotspotGridLat * 1.9;
  const hotspotCells = new Map<string, { sumLng: number; sumLat: number; count: number }>();

  const ACC_CELL_DEG = 0.01;
  const insideBuckets = new Map<string, number[]>();
  const bufferedBuckets = new Map<string, number[]>();

  for (let i = 0; i < insideAccidents.length; i++) {
    const a = insideAccidents[i];
    if (a.speciesClass === 1) speciesTotals.moose++;
    else if (a.speciesClass === 2) speciesTotals.fallowDeer++;
    else if (a.speciesClass === 3) speciesTotals.roeDeer++;
    else if (a.speciesClass === 4) speciesTotals.forestReindeer++;
    else speciesTotals.whiteTailedDeer++;

    const yKey = String(a.year);
    byYear[yKey] = (byYear[yKey] ?? 0) + 1;

    const gx = Math.floor(a.lng / ACC_CELL_DEG);
    const gy = Math.floor(a.lat / ACC_CELL_DEG);
    const iKey = `${gx}:${gy}`;
    const iList = insideBuckets.get(iKey);
    if (iList) iList.push(i);
    else insideBuckets.set(iKey, [i]);

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

  for (let i = 0; i < bufferedAccidents.length; i++) {
    const a = bufferedAccidents[i];
    const gx = Math.floor(a.lng / ACC_CELL_DEG);
    const gy = Math.floor(a.lat / ACC_CELL_DEG);
    const bKey = `${gx}:${gy}`;
    const bList = bufferedBuckets.get(bKey);
    if (bList) bList.push(i);
    else bufferedBuckets.set(bKey, [i]);
  }

  // Index official wildlife warning road vertices (~150 m proximity bonus)
  const WARN_CELL_DEG = 0.01;
  const warnPointBuckets = new Set<string>();
  for (const w of localWarnings) {
    for (const [wLng, wLat] of w.coords) {
      warnPointBuckets.add(
        `${Math.floor(wLng / WARN_CELL_DEG)}:${Math.floor(wLat / WARN_CELL_DEG)}`
      );
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

  // 4. Sample candidate roadside stations along stitched chains, using finer spacing on larger highways
  // so major roads can always achieve seamless tip-to-tip coverage regardless of total small-road mileage
  const desiredCandidateBudget = Math.min(4500, Math.max(900, targetCameraCount * 18));
  const rawStep = Math.floor(totalRoadM / desiredCandidateBudget);
  const baseSampleStepM = Math.max(18, Math.min(110, rawStep || 24));
  const maxSightDeviationM = Math.max(3.5, sightRangeM * Math.tan(((fovDeg / 2) * Math.PI) / 180) * 0.45);

  let skippedCityCentreStations = 0;
  const excludedCentreMetersByChain = new Map<number, number>();

  const buildCandidates = (maxBendDeg: number, sightMultiplier: number): CandidateRoadStation[] => {
    const list: CandidateRoadStation[] = [];
    skippedCityCentreStations = 0;
    excludedCentreMetersByChain.clear();

    for (let chainIdx = 0; chainIdx < chains.length; chainIdx++) {
      const chain = chains[chainIdx];
      const chainStepM =
        chain.roadTier === 1
          ? Math.max(18, Math.min(40, baseSampleStepM))
          : baseSampleStepM;
      const marginM = Math.min(25, chain.totalLengthM * 0.18);
      for (let s = marginM; s <= chain.totalLengthM - marginM + 0.1; s += chainStepM) {
        const origin = interpolateAlongChain(chain, s);

        // Exclude built-up city centre areas completely from wildlife camera placement
        if (isPointInCityCentreArea(origin.lat, origin.lng, urbanCentreIndex)) {
          skippedCityCentreStations++;
          excludedCentreMetersByChain.set(
            chainIdx,
            (excludedCentreMetersByChain.get(chainIdx) ?? 0) + chainStepM
          );
          continue;
        }

        const lookAheadM = Math.min(sightRangeM, chain.totalLengthM - s);
        const lookBehindM = Math.min(sightRangeM, s);
        if (lookAheadM < 16 && lookBehindM < 16) continue;

        const aheadTarget = interpolateAlongChain(chain, s + Math.max(16, lookAheadM));
        const behindTarget = interpolateAlongChain(chain, s - Math.max(16, lookBehindM));

        const bearingFwd = compassBearingDeg(origin.lat, origin.lng, aheadTarget.lat, aheadTarget.lng);
        const bearingRev = compassBearingDeg(origin.lat, origin.lng, behindTarget.lat, behindTarget.lng);

        const forwardFromBehind = compassBearingDeg(
          behindTarget.lat,
          behindTarget.lng,
          origin.lat,
          origin.lng
        );
        const turnAngleDeg = shortestAngleDiff(forwardFromBehind, bearingFwd);
        if (turnAngleDeg > maxBendDeg) continue;

        const checkDistM = Math.min(sightRangeM, 50);
        const fwdCheck = projectPointMeters(origin.lat, origin.lng, checkDistM, bearingFwd);
        const revCheck = projectPointMeters(origin.lat, origin.lng, checkDistM, bearingRev);
        const fwdErrM = distancePointToChainM(fwdCheck.lat, fwdCheck.lng, chain);
        const revErrM = distancePointToChainM(revCheck.lat, revCheck.lng, chain);
        const fwdOk = lookAheadM >= 18 && fwdErrM <= maxSightDeviationM * sightMultiplier;
        const revOk = lookBehindM >= 18 && revErrM <= maxSightDeviationM * sightMultiplier;
        if (!fwdOk && !revOk) continue;

        const gx = Math.floor(origin.lng / ACC_CELL_DEG);
        const gy = Math.floor(origin.lat / ACC_CELL_DEG);
        let acc500 = 0;
        let wtd = 0;
        let roe = 0;
        let moose = 0;
        let kernelDensity = 0;
        let fwdDirectionalHits = 0;
        let revDirectionalHits = 0;

        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const bucket = bufferedBuckets.get(`${gx + dx}:${gy + dy}`);
            if (!bucket) continue;
            for (const accIdx of bucket) {
              const acc = bufferedAccidents[accIdx];
              const dist = groundDistanceM(origin.lat, origin.lng, acc.lat, acc.lng);
              if (dist <= 500) {
                acc500++;
                if (acc.speciesClass === 1) moose++;
                else if (acc.speciesClass === 3) roe++;
                else wtd++;

                const w =
                  dist <= 75
                    ? 6.0
                    : dist <= 160
                      ? 3.6
                      : dist <= 280
                        ? 1.55
                        : 0.5;
                const speciesMult = acc.speciesClass === 1 ? 1.25 : 1.0;
                kernelDensity += w * speciesMult;

                if (dist >= 6 && dist <= Math.max(90, sightRangeM * 1.8)) {
                  const bToAcc = compassBearingDeg(origin.lat, origin.lng, acc.lat, acc.lng);
                  if (shortestAngleDiff(bToAcc, bearingFwd) <= Math.max(25, fovDeg)) {
                    fwdDirectionalHits++;
                  }
                  if (shortestAngleDiff(bToAcc, bearingRev) <= Math.max(25, fovDeg)) {
                    revDirectionalHits++;
                  }
                }
              }
            }
          }
        }

        // Track strictly inside-polygon accidents within 500 m for summary metrics
        const nearbyInsideIndices: number[] = [];
        for (let dx = -1; dx <= 1; dx++) {
          for (let dy = -1; dy <= 1; dy++) {
            const iBucket = insideBuckets.get(`${gx + dx}:${gy + dy}`);
            if (!iBucket) continue;
            for (const inIdx of iBucket) {
              const acc = insideAccidents[inIdx];
              if (groundDistanceM(origin.lat, origin.lng, acc.lat, acc.lng) <= 500) {
                nearbyInsideIndices.push(inIdx);
              }
            }
          }
        }

        const bidirectionalMount = computeRoadsideMount(
          origin,
          fwdOk ? bearingFwd : bearingRev,
          fwdOk ? aheadTarget : null,
          revOk ? behindTarget : null,
          polygon
        );

        const onWarningCorridor = warnPointBuckets.has(
          `${Math.floor(origin.lng / WARN_CELL_DEG)}:${Math.floor(origin.lat / WARN_CELL_DEG)}`
        );
        const warningMultiplier = onWarningCorridor ? 1.12 : 1.0;
        const bothSightlinesFactor = fwdOk && revOk ? 1.06 : 0.94;
        const straightnessBonus = Math.max(0.72, 1.0 - turnAngleDeg / 55) * bothSightlinesFactor;
        const directionalCaptureBonus = Math.min(1.2, (fwdDirectionalHits + revDirectionalHits) * 0.08);
        // Gentle corridor prominence baseline across orange roads so cameras spread across all orange corridors
        // while preferring higher-activity stretches and major trunk routes when risk is equal
        const baselineCorridorScore = 1.8 + chain.hierarchyWeight * 1.8;
        const temperedWildlifeScore =
          Math.pow(kernelDensity, 0.58) * 1.45 + Math.sqrt(acc500) * 0.9 + directionalCaptureBonus;
        const score =
          (baselineCorridorScore + temperedWildlifeScore * warningMultiplier) *
          straightnessBonus;

        list.push({
          chainIdx,
          stationDistM: s,
          lat: bidirectionalMount.lat,
          lng: bidirectionalMount.lng,
          bearingDeg: bidirectionalMount.bearingDeg,
          reverseBearingDeg: bidirectionalMount.reverseBearingDeg,
          roadLabel: chain.roadLabel,
          roadTier: chain.roadTier,
          hierarchyWeight: chain.hierarchyWeight,
          turnAngleDeg,
          score,
          accidents500m: acc500,
          whiteTailedDeer: wtd,
          roeDeer: roe,
          moose,
          nearbyInsideIndices,
        });
      }
    }
    return list;
  };

  let candidates = buildCandidates(30, 1.2);
  if (candidates.length < Math.min(targetCameraCount, 12)) {
    candidates = buildCandidates(42, 1.75);
  }

  if (candidates.length === 0) {
    if (skippedCityCentreStations > 0) {
      throw new Error(
        'The selected area lies within a city centre area where wildlife cameras are not placed. Draw a larger area that extends onto roads outside the city centre.'
      );
    }
    throw new Error(
      'Roads were found in the drawn area, but none had segments long enough for 60 m roadside sightlines. Draw a slightly larger area.'
    );
  }

  // 5. Hierarchical Road Prioritization & Proper-Coverage Saturation (outside city centre areas):
  // Allocates cameras strictly to large (orange) roads first and only places cameras on smaller roads
  // once all non-centre orange roads in the Area of Interest are properly covered.
  const chainLengthByIdx = new Map<number, number>();
  for (let i = 0; i < chains.length; i++) {
    const activeLenM = Math.max(
      60,
      chains[i].totalLengthM - (excludedCentreMetersByChain.get(i) ?? 0)
    );
    chainLengthByIdx.set(i, activeLenM);
  }

  const selected = selectRoadStationsByHierarchy(
    candidates,
    chainLengthByIdx,
    targetCameraCount,
    sightRangeM
  );

  selected.sort(
    (a, b) => a.roadTier - b.roadTier || b.accidents500m - a.accidents500m || b.score - a.score
  );

  const resolvedAreaId =
    params.areaId && /^[a-zA-Z0-9_-]{1,36}$/.test(params.areaId.trim())
      ? params.areaId.trim()
      : 'area-1';
  const resolvedPrefix =
    params.cameraPrefix && /^[a-zA-Z0-9]{1,10}$/.test(params.cameraPrefix.trim())
      ? params.cameraPrefix.trim().toUpperCase()
      : 'AOI';

  const coveredInsideAccidentSet = new Set<number>();
  const roadCounter = new Map<string, number>();
  const padDigits = Math.max(3, String(selected.length).length);

  const cameras: PlannedCameraNode[] = selected.map((st, idx) => {
    const unitNumber = idx + 1;
    for (const inIdx of st.nearbyInsideIndices) {
      coveredInsideAccidentSet.add(inIdx);
    }
    const cleanRoadKey = st.roadLabel.split(' (')[0];
    roadCounter.set(cleanRoadKey, (roadCounter.get(cleanRoadKey) ?? 0) + 1);

    return {
      id: `${resolvedPrefix}-${String(unitNumber).padStart(padDigits, '0')}`,
      cityId: resolvedAreaId,
      cityName: label,
      unitNumber,
      rankInCity: unitNumber,
      clusterIndex: unitNumber,
      clusterSize: 1,
      roadLabel: st.roadLabel,
      clusterLabel: `Roadside #${unitNumber} · ${st.roadLabel}`,
      lat: st.lat,
      lng: st.lng,
      bearingDeg: st.bearingDeg,
      reverseBearingDeg: st.reverseBearingDeg,
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
    id: resolvedAreaId,
    label,
    center: {
      lat: Number(bbox.centerLat.toFixed(5)),
      lng: Number(bbox.centerLng.toFixed(5)),
    },
    radiusKm: Number(bbox.equivRadiusKm.toFixed(1)),
    polygon: polygon.map((p) => ({
      lat: Number(p.lat.toFixed(5)),
      lng: Number(p.lng.toFixed(5)),
    })),
    areaKm2: Number(areaKm2Raw.toFixed(1)),
    roadNetworkKm,
    targetCameraCount,
    dataSourceUrl: RAMBOLL_SOURCE_URL,
    dataPeriod: '2021–2025',
    offlineDatasetRecords: nationwideTotal,
    totalAccidentsInRadius: insideAccidents.length,
    corridorAccidentsNearCameras: coveredInsideAccidentSet.size,
    speciesTotals,
    byYear,
    primaryRoads: topRoads.length > 0 ? topRoads.join(' · ') : 'Local roads',
    hotspots,
    roadPolylines: extractSimulationRoadPolylines(
      chains,
      new Set(selected.map((st) => st.chainIdx))
    ),
    cameras,
  };
}

/**
 * Circular convenience wrapper delegating into the offline-backed polygon camera planner.
 */
export async function buildCustomAreaCameraPlan(
  params: CustomAreaRequestParams
): Promise<CustomAreaPlanResult> {
  const lat = Number(params.lat);
  const lng = Number(params.lng);
  const radiusKm = Math.max(2, Math.min(50, Number(params.radiusKm) || 12));

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

  const steps = 64;
  const circlePolygon: Array<{ lat: number; lng: number }> = [];
  for (let i = 0; i < steps; i++) {
    circlePolygon.push(projectPointMeters(lat, lng, radiusKm * 1000, (360 * i) / steps));
  }

  return buildPolygonAreaCameraPlan({
    polygon: circlePolygon,
    cameraCount: params.cameraCount ?? 100,
    rangeMeters: params.rangeMeters ?? 60,
    fovDeg: params.fovDeg ?? 30,
    label: params.label,
    areaId: params.areaId,
    cameraPrefix: params.cameraPrefix,
  });
}
