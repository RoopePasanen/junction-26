import * as XLSX from 'xlsx';
import {
  ALL_PLANNED_CAMERAS,
  TOP_5_WILDLIFE_ACCIDENT_CITIES,
  type CityCameraPlan,
  type PlannedCameraNode,
} from '../data/finlandWildlifePlan';
import {
  DEMO_SYNTHETIC_CROSSING_TUPLES,
  HOTSPOT_MICRO_CLUSTERS_BY_CITY,
  WIDE_CORRIDOR_SPREAD_BY_CITY,
  type HotspotClusterTuple,
  type WideCorridorCameraTuple,
} from '../data/simulationPresets';
import type { CameraCoverageConfig } from './cameraPlanGeometry';
import { destinationPoint, EARTH_RADIUS_METERS, getCameraBearings } from './cameraPlanGeometry';
import { FINLAND_GEOGRAPHIC_BOUNDS } from './mapMath';
import type { CustomAreaPlanResult } from '../types/customAreaPlan';

import { isPointInLatLngPolygon } from './polygonGeometry';

export interface CustomAreaSimulationScope {
  id?: string;
  center: { lat: number; lng: number };
  radiusKm: number;
  label: string;
  polygon?: ReadonlyArray<{ lat: number; lng: number }>;
  roadPolylines?: ReadonlyArray<ReadonlyArray<readonly [number, number]>>;
}

export type AnimalSizeCategory = 'small' | 'large';

export type CameraArrangementId =
  | 'prominent-scatter'
  | 'hotspot-clusters'
  | 'corridor-spread';

export interface CameraArrangementSpec {
  id: CameraArrangementId;
  label: string;
  shortLabel: string;
  spacingSummary: string;
  description: string;
}

export interface CrossingEvent {
  eventId: string;
  date: string;
  lat: number;
  lng: number;
  animalSize: AnimalSizeCategory;
}

export interface ParsedEventDateDetails {
  year: number | null;
  dayOfYear: number;
  daysInYear: number;
}

export interface EvaluatedCrossingEvent extends CrossingEvent {
  year: number | null;
  dayOfYear: number;
  cityId: string;
  cityName: string;
  crossingStartLat: number;
  crossingStartLng: number;
  roadLat: number;
  roadLng: number;
  crossingEndLat: number;
  crossingEndLng: number;
  distanceToRoadM: number;
  hasRoadCrossingLine: boolean;
  detected: boolean;
  detectedByCameraId: string | null;
  detectedCameraCity: string | null;
  detectedDistanceM: number | null;
  nearestCameraId: string;
  nearestDistanceM: number;
}

export interface SimulatorConfig {
  arrangementId: CameraArrangementId;
  selectedYear: number | 'all';
  scaleRangeByAnimalSize: boolean;
  sizeFilter: 'all' | AnimalSizeCategory;
  showDetectedHeatmap: boolean;
  showMissedHeatmap: boolean;
  showEventPoints: boolean;
}

export interface SimulationSummary {
  uploadedEventsCount: number;
  excludedOutsideCitiesCount: number;
  availableYears: number[];
  selectedYear: number | 'all';
  yearFilteredOutCount: number;
  coveredEventsInSelectedYear: number;
  totalEvents: number;
  detectedCount: number;
  missedCount: number;
  detectionRatePct: number;
  largeTotal: number;
  largeDetected: number;
  largeRatePct: number;
  smallTotal: number;
  smallDetected: number;
  smallRatePct: number;
}

export interface SpreadsheetParseResult {
  valid: boolean;
  events: CrossingEvent[];
  skippedRows: number;
  error?: string;
}

export const SMALL_ANIMAL_RANGE_FACTOR = 0.7;

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  arrangementId: 'prominent-scatter',
  selectedYear: 'all',
  scaleRangeByAnimalSize: false,
  sizeFilter: 'all',
  showDetectedHeatmap: true,
  showMissedHeatmap: true,
  showEventPoints: true,
};

export const CAMERA_ARRANGEMENTS: CameraArrangementSpec[] = [
  {
    id: 'prominent-scatter',
    label: 'Prominent Hotspot Scatter (100 cam/city · 365 d)',
    shortLabel: 'Prominent Scatter',
    spacingSummary: '100/city · prominent sites',
    description:
      'Deploys 100 year-round cameras per city across historically prominent 2021–2025 collision locations along motor roads.',
  },
  {
    id: 'hotspot-clusters',
    label: 'Hotspot Micro-Clusters (10×10 cam/city · 80 m)',
    shortLabel: 'Hotspot Clusters',
    spacingSummary: '10×10 clusters · ~80 m',
    description:
      'Concentrates each city’s 100 cameras into 10 dense 10-camera corridor clusters at the top collision pinch points.',
  },
  {
    id: 'corridor-spread',
    label: 'Wide Highway Spread (100 cam/city · ≥950 m)',
    shortLabel: 'Wide Spread',
    spacingSummary: '100/city · ≥950 m',
    description:
      'Spreads 100 cameras per city broadly across major state and regional highways to benchmark wide spacing.',
  },
];

function buildHotspotClusterCameras(
  byCity: Record<string, HotspotClusterTuple[]>
): PlannedCameraNode[] {
  const list: PlannedCameraNode[] = [];
  for (const city of TOP_5_WILDLIFE_ACCIDENT_CITIES) {
    const tuples = byCity[city.id] ?? [];
    for (let i = 0; i < city.cameras.length; i++) {
      const baseCam = city.cameras[i];
      const tuple = tuples[i];
      if (!tuple) {
        list.push(baseCam);
        continue;
      }
      const [lat, lng, bearingDeg, clusterIndex, roadLabel] = tuple;
      list.push({
        ...baseCam,
        lat,
        lng,
        bearingDeg,
        clusterIndex,
        clusterSize: 10,
        roadLabel,
        clusterLabel: `Cluster #${clusterIndex} · ${roadLabel}`,
      });
    }
  }
  return list;
}

function buildWideCorridorSpreadCameras(
  byCity: Record<string, WideCorridorCameraTuple[]>
): PlannedCameraNode[] {
  const list: PlannedCameraNode[] = [];
  for (const city of TOP_5_WILDLIFE_ACCIDENT_CITIES) {
    const tuples = byCity[city.id] ?? [];
    for (let i = 0; i < tuples.length; i++) {
      const [lat, lng, bearingDeg, rankInCity, historicalAccidents, roadLabel] = tuples[i];
      const templateCam = city.cameras[i] ?? city.cameras[0];
      list.push({
        ...templateCam,
        id: `${city.prefix}-${String(rankInCity).padStart(3, '0')}`,
        cityId: city.id,
        cityName: city.name,
        unitNumber: rankInCity,
        rankInCity,
        clusterIndex: rankInCity,
        clusterSize: 1,
        roadLabel,
        clusterLabel: `Corridor #${rankInCity} · ${roadLabel}`,
        lat,
        lng,
        bearingDeg,
        historicalAccidents,
      });
    }
  }
  return list;
}

let cachedArrangements: Record<CameraArrangementId, PlannedCameraNode[]> | null = null;

export function getCamerasForArrangement(arrangementId: CameraArrangementId): PlannedCameraNode[] {
  if (!cachedArrangements) {
    cachedArrangements = {
      'prominent-scatter': ALL_PLANNED_CAMERAS,
      'hotspot-clusters': buildHotspotClusterCameras(HOTSPOT_MICRO_CLUSTERS_BY_CITY),
      'corridor-spread': buildWideCorridorSpreadCameras(WIDE_CORRIDOR_SPREAD_BY_CITY),
    };
  }
  return cachedArrangements[arrangementId] ?? ALL_PLANNED_CAMERAS;
}

interface CityBoundaryBBox {
  city: CityCameraPlan;
  minLng: number;
  maxLng: number;
  minLat: number;
  maxLat: number;
}

const CITY_BOUNDARY_INDEX: CityBoundaryBBox[] = TOP_5_WILDLIFE_ACCIDENT_CITIES.map((city) => {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const ring of city.borderLines) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { city, minLng, maxLng, minLat, maxLat };
});

export function isPointInPolygonRing(
  lng: number,
  lat: number,
  ring: ReadonlyArray<readonly [number, number]>
): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

export function isPointInCityBoundary(
  lat: number,
  lng: number,
  city: Pick<CityCameraPlan, 'borderLines'>
): boolean {
  let inside = false;
  for (const ring of city.borderLines) {
    if (ring.length < 3) continue;
    if (isPointInPolygonRing(lng, lat, ring)) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Parses an event date string (YYYY-MM-DD, DD.MM.YYYY, YYYY/MM/DD, etc.) into calendar year
 * and day-of-year (1..365/366).
 */
export function parseEventDateDetails(dateStr: string): ParsedEventDateDetails {
  const s = (dateStr ?? '').trim();
  let year: number | null = null;
  let month = 1;
  let day = 1;

  const isoMatch = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (isoMatch) {
    year = Number(isoMatch[1]);
    month = Number(isoMatch[2]);
    day = Number(isoMatch[3]);
  } else {
    const euroMatch = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
    if (euroMatch) {
      day = Number(euroMatch[1]);
      month = Number(euroMatch[2]);
      year = Number(euroMatch[3]);
    } else {
      const parsedMs = Date.parse(s);
      if (!Number.isNaN(parsedMs)) {
        const dt = new Date(parsedMs);
        year = dt.getUTCFullYear();
        month = dt.getUTCMonth() + 1;
        day = dt.getUTCDate();
      }
    }
  }

  if (
    year === null ||
    !Number.isFinite(year) ||
    year < 1970 ||
    year > 2150 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31
  ) {
    return {
      year: null,
      dayOfYear: 1,
      daysInYear: 365,
    };
  }

  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInYear = isLeap ? 366 : 365;
  const startOfYearUtc = Date.UTC(year, 0, 0);
  const dateUtc = Date.UTC(year, month - 1, day);
  const rawDayOfYear = Math.round((dateUtc - startOfYearUtc) / 86_400_000);
  const dayOfYear = Math.max(1, Math.min(daysInYear, rawDayOfYear));

  return {
    year,
    dayOfYear,
    daysInYear,
  };
}

/**
 * Extracts sorted unique calendar years present in a list of crossing events.
 */
export function extractAvailableYears(events: CrossingEvent[]): number[] {
  const yearSet = new Set<number>();
  for (const ev of events) {
    const { year } = parseEventDateDetails(ev.date);
    if (year !== null) {
      yearSet.add(year);
    }
  }
  return Array.from(yearSet).sort((a, b) => a - b);
}

/**
 * Returns the camera-covered municipality containing (lat, lng), or null if the point lies
 * outside all municipalities covered by the active camera set.
 */
export function findCameraCoveredCity(
  lat: number,
  lng: number,
  coveredCityIds?: ReadonlySet<string>
): CityCameraPlan | null {
  for (const entry of CITY_BOUNDARY_INDEX) {
    if (coveredCityIds && !coveredCityIds.has(entry.city.id)) {
      continue;
    }
    if (
      lng < entry.minLng ||
      lng > entry.maxLng ||
      lat < entry.minLat ||
      lat > entry.maxLat
    ) {
      continue;
    }
    if (isPointInCityBoundary(lat, lng, entry.city)) {
      return entry.city;
    }
  }
  return null;
}

export function isPointInCustomAreaScope(
  lat: number,
  lng: number,
  scope: CustomAreaSimulationScope
): boolean {
  if (scope.polygon && scope.polygon.length >= 3) {
    return isPointInLatLngPolygon(lat, lng, scope.polygon);
  }
  const { distanceM } = groundDistanceAndBearing(scope.center.lat, scope.center.lng, lat, lng);
  return distanceM <= scope.radiusKm * 1000;
}

export function findMatchingCustomAreaScope(
  lat: number,
  lng: number,
  scopes: ReadonlyArray<CustomAreaSimulationScope>
): CustomAreaSimulationScope | null {
  for (const scope of scopes) {
    if (isPointInCustomAreaScope(lat, lng, scope)) {
      return scope;
    }
  }
  return null;
}

export function filterEventsInCoveredCities(
  events: CrossingEvent[],
  cameras: PlannedCameraNode[] = ALL_PLANNED_CAMERAS,
  customScope: CustomAreaSimulationScope | ReadonlyArray<CustomAreaSimulationScope> | null = null
): CrossingEvent[] {
  if (Array.isArray(customScope)) {
    if (customScope.length === 0) return [];
    return events.filter((ev) => findMatchingCustomAreaScope(ev.lat, ev.lng, customScope) !== null);
  }
  if (customScope !== null) {
    const singleScope = customScope as CustomAreaSimulationScope;
    return events.filter((ev) => isPointInCustomAreaScope(ev.lat, ev.lng, singleScope));
  }
  const coveredIds = new Set(cameras.map((c) => c.cityId));
  return events.filter((ev) => findCameraCoveredCity(ev.lat, ev.lng, coveredIds) !== null);
}

const UNCOVERED_FINLAND_SYNTHETIC_ANCHORS: ReadonlyArray<[number, number]> = [
  [60.1699, 24.9384], // Helsinki
  [60.4518, 22.2666], // Turku
  [61.4978, 23.761], // Tampere
  [60.9827, 25.6612], // Lahti
  [60.8679, 26.7042], // Kouvola
  [62.2426, 25.7473], // Jyväskylä
  [62.7903, 22.8403], // Seinäjoki
  [65.0121, 25.4651], // Oulu
];

/**
 * Returns 1,500 deterministic multi-year (2024–2026) synthetic crossing events:
 * - 1,320 inside the 5 camera-covered cities (440/year)
 * - 180 outside covered cities (60/year) to verify covered-city filtering.
 */
export function getDemoSyntheticEvents(): CrossingEvent[] {
  const inCovered: CrossingEvent[] = DEMO_SYNTHETIC_CROSSING_TUPLES.map(
    ([eventId, date, lat, lng, animalSize]) => ({
      eventId,
      date,
      lat,
      lng,
      animalSize,
    })
  );

  const outsideCovered: CrossingEvent[] = [];
  const demoYears = [2024, 2025, 2026];
  for (let yIdx = 0; yIdx < demoYears.length; yIdx++) {
    const yr = demoYears[yIdx];
    for (let i = 0; i < 60; i++) {
      const [baseLat, baseLng] =
        UNCOVERED_FINLAND_SYNTHETIC_ANCHORS[
          (i + yIdx) % UNCOVERED_FINLAND_SYNTHETIC_ANCHORS.length
        ];
      const dLat = (((i * 37 + yIdx * 11) % 29) - 14) * 0.008;
      const dLng = (((i * 53 + yIdx * 17) % 31) - 15) * 0.014;
      const month = ((i * 2 + yIdx) % 12) + 1;
      const day = ((i * 5 + yIdx * 3) % 27) + 1;
      outsideCovered.push({
        eventId: `EVT-${yr}-OUT-${String(i + 1).padStart(3, '0')}`,
        date: `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        lat: Number((baseLat + dLat).toFixed(6)),
        lng: Number((baseLng + dLng).toFixed(6)),
        animalSize: (i + yIdx) % 5 < 3 ? 'large' : 'small',
      });
    }
  }

  return [...inCovered, ...outsideCovered];
}

/**
 * Generates deterministic multi-year (2024–2026) synthetic animal positions next to roads
 * inside an Area of Interest so the simulator can model each animal crossing the closest road
 * at normal incidence and test camera line-of-sight detection.
 */
export function generateCustomAreaDemoCrossings(plan: CustomAreaPlanResult): CrossingEvent[] {
  const events: CrossingEvent[] = [];
  const demoYears = [2024, 2025, 2026];
  const cams = plan.cameras;
  const hotspots = plan.hotspots;
  if (cams.length === 0) return events;

  // Collect usable road segments ([lat1, lng1, lat2, lng2, bearingDeg]) from plan.roadPolylines when available
  const roadSegs: Array<{
    midLat: number;
    midLng: number;
    bearingDeg: number;
    nearHotspot: boolean;
  }> = [];

  if (plan.roadPolylines && plan.roadPolylines.length > 0) {
    for (const poly of plan.roadPolylines) {
      for (let i = 0; i < poly.length - 1; i++) {
        const [lng1, lat1] = poly[i];
        const [lng2, lat2] = poly[i + 1];
        const { distanceM, bearingDeg } = groundDistanceAndBearing(lat1, lng1, lat2, lng2);
        if (distanceM < 12) continue;
        const midLat = (lat1 + lat2) / 2;
        const midLng = (lng1 + lng2) / 2;
        if (!isPointInCustomAreaScope(midLat, midLng, plan)) continue;

        let nearHotspot = false;
        for (let h = 0; h < Math.min(60, hotspots.length); h++) {
          const [hLng, hLat] = hotspots[h];
          if (Math.abs(midLat - hLat) < 0.0024 && Math.abs(midLng - hLng) < 0.0048) {
            nearHotspot = true;
            break;
          }
        }
        roadSegs.push({ midLat, midLng, bearingDeg, nearHotspot });
      }
    }
  }

  const hotspotRoadSegs = roadSegs.filter((s) => s.nearHotspot);

  for (let yIdx = 0; yIdx < demoYears.length; yIdx++) {
    const yr = demoYears[yIdx];

    if (roadSegs.length > 0) {
      // Place 220 animals per year at spots next to actual roads (10–52 m off-road in roadside woods/verges)
      for (let i = 0; i < 220; i++) {
        const useHotspotPool = hotspotRoadSegs.length > 0 && (i * 5 + yIdx) % 10 < 6;
        const pool = useHotspotPool ? hotspotRoadSegs : roadSegs;
        const seg = pool[(i * 13 + yIdx * 29) % pool.length];
        const primarySide = (i + yIdx) % 2 === 0 ? 90 : 270;
        const oppSide = primarySide === 90 ? 270 : 90;
        const lateralDistM = 10 + ((i * 17 + yIdx * 11) % 43); // 10 m .. 52 m next to road
        const alongShiftM = (((i * 7 + yIdx * 3) % 11) - 5) * 3.5;
        const roadBase = destinationPoint(
          { lat: seg.midLat, lng: seg.midLng },
          Math.abs(alongShiftM),
          alongShiftM >= 0 ? seg.bearingDeg : (seg.bearingDeg + 180) % 360
        );

        let animalSpot = destinationPoint(
          roadBase,
          lateralDistM,
          (seg.bearingDeg + primarySide) % 360
        );
        if (!isPointInCustomAreaScope(animalSpot.lat, animalSpot.lng, plan)) {
          const altSpot = destinationPoint(
            roadBase,
            lateralDistM,
            (seg.bearingDeg + oppSide) % 360
          );
          if (isPointInCustomAreaScope(altSpot.lat, altSpot.lng, plan)) {
            animalSpot = altSpot;
          } else {
            const closeSpot = destinationPoint(
              roadBase,
              8,
              (seg.bearingDeg + primarySide) % 360
            );
            if (!isPointInCustomAreaScope(closeSpot.lat, closeSpot.lng, plan)) continue;
            animalSpot = closeSpot;
          }
        }

        const month = ((i * 3 + yIdx * 2) % 12) + 1;
        const day = ((i * 7 + yIdx * 5) % 27) + 1;
        events.push({
          eventId: `CUS-${yr}-${String(events.length + 1).padStart(4, '0')}`,
          date: `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          lat: Number(animalSpot.lat.toFixed(6)),
          lng: Number(animalSpot.lng.toFixed(6)),
          animalSize: (i + yIdx) % 3 === 0 ? 'small' : 'large',
        });
      }
    } else {
      // Fallback when mock plans do not supply roadPolylines
      for (let i = 0; i < 130; i++) {
        const cam = cams[(i * 7 + yIdx * 13) % cams.length];
        const distM = 8 + ((i * 19 + yIdx * 23) % 98);
        const jitterDeg = (((i * 11 + yIdx * 5) % 19) - 9) * 1.4;
        const pt = destinationPoint(
          { lat: cam.lat, lng: cam.lng },
          distM,
          (cam.bearingDeg + jitterDeg + 360) % 360
        );
        if (!isPointInCustomAreaScope(pt.lat, pt.lng, plan)) continue;
        const month = ((i * 3 + yIdx * 2) % 12) + 1;
        const day = ((i * 7 + yIdx * 5) % 27) + 1;
        events.push({
          eventId: `CUS-${yr}-${String(events.length + 1).padStart(4, '0')}`,
          date: `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          lat: Number(pt.lat.toFixed(6)),
          lng: Number(pt.lng.toFixed(6)),
          animalSize: (i + yIdx) % 3 === 0 ? 'small' : 'large',
        });
      }

      const sourceHotspots =
        hotspots.length > 0
          ? hotspots
          : cams.map(
              (c) =>
                [c.lng, c.lat, Math.max(1, c.historicalAccidents)] as [number, number, number]
            );
      for (let j = 0; j < 90; j++) {
        const [hLng, hLat] = sourceHotspots[(j * 5 + yIdx * 7) % sourceHotspots.length];
        const offsetM = 95 + ((j * 43 + yIdx * 29) % 420);
        const bearing = (j * 67 + yIdx * 41) % 360;
        const pt = destinationPoint({ lat: hLat, lng: hLng }, offsetM, bearing);
        if (!isPointInCustomAreaScope(pt.lat, pt.lng, plan)) continue;
        const month = ((j * 5 + yIdx) % 12) + 1;
        const day = ((j * 9 + yIdx * 4) % 27) + 1;
        events.push({
          eventId: `CUS-${yr}-GAP-${String(j + 1).padStart(3, '0')}`,
          date: `${yr}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
          lat: Number(pt.lat.toFixed(6)),
          lng: Number(pt.lng.toFixed(6)),
          animalSize: (j + yIdx) % 5 < 3 ? 'large' : 'small',
        });
      }
    }

    for (let k = 0; k < 25; k++) {
      const outsideDistM = (Math.max(4, plan.radiusKm) * 2.4 + 4 + (k % 9)) * 1000;
      const pt = destinationPoint(plan.center, outsideDistM, (k * 47 + yIdx * 31) % 360);
      if (
        pt.lat < FINLAND_GEOGRAPHIC_BOUNDS.south ||
        pt.lat > FINLAND_GEOGRAPHIC_BOUNDS.north ||
        pt.lng < FINLAND_GEOGRAPHIC_BOUNDS.west ||
        pt.lng > FINLAND_GEOGRAPHIC_BOUNDS.east ||
        isPointInCustomAreaScope(pt.lat, pt.lng, plan)
      ) {
        continue;
      }
      events.push({
        eventId: `CUS-${yr}-OUT-${String(k + 1).padStart(2, '0')}`,
        date: `${yr}-09-${String((k % 27) + 1).padStart(2, '0')}`,
        lat: Number(pt.lat.toFixed(6)),
        lng: Number(pt.lng.toFixed(6)),
        animalSize: k % 2 === 0 ? 'large' : 'small',
      });
    }
  }

  return events;
}

/**
 * Generates deterministic multi-year (2024–2026) synthetic crossing events across all active
 * user-added Areas of Interest on the map, ensuring unique event IDs across areas.
 */
export function generateAreasDemoCrossings(
  areas: ReadonlyArray<CustomAreaPlanResult>
): CrossingEvent[] {
  const combined: CrossingEvent[] = [];
  areas.forEach((area, areaIdx) => {
    const areaTag = `A${String(areaIdx + 1).padStart(2, '0')}`;
    const rawEvents = generateCustomAreaDemoCrossings(area);
    for (const ev of rawEvents) {
      combined.push({
        ...ev,
        eventId: ev.eventId.replace(/^CUS-/, `${areaTag}-`),
      });
    }
  });
  return combined;
}

function normalizeHeaderKey(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '');
}

function parseFlexibleNumber(val: unknown): number {
  if (typeof val === 'number') {
    return val;
  }
  if (typeof val === 'string') {
    const cleaned = val.trim().replace(',', '.');
    if (!cleaned) return Number.NaN;
    return Number(cleaned);
  }
  return Number.NaN;
}

function formatCellDate(val: unknown): string {
  if (val instanceof Date && !Number.isNaN(val.getTime())) {
    return val.toISOString().slice(0, 10);
  }
  if (typeof val === 'number' && Number.isFinite(val) && val > 20000 && val < 80000) {
    const utcMs = Math.round((val - 25569) * 86_400_000);
    const dt = new Date(utcMs);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toISOString().slice(0, 10);
    }
  }
  const str = String(val ?? '').trim();
  return str || 'Unknown';
}

function normalizeAnimalSize(val: unknown): AnimalSizeCategory | null {
  const s = String(val ?? '')
    .trim()
    .toLowerCase();
  if (!s) return null;
  if (
    s === 'small' ||
    s === 's' ||
    s.includes('small') ||
    s.includes('pieni') ||
    s.includes('roe') ||
    s.includes('fox') ||
    s.includes('hare')
  ) {
    return 'small';
  }
  if (
    s === 'large' ||
    s === 'l' ||
    s.includes('large') ||
    s.includes('big') ||
    s.includes('suuri') ||
    s.includes('iso') ||
    s.includes('moose') ||
    s.includes('deer') ||
    s.includes('hirvi')
  ) {
    return 'large';
  }
  return null;
}

/**
 * Parses an Excel (.xlsx/.xls) or CSV/TSV ArrayBuffer into validated CrossingEvent records.
 * Expected columns (case-insensitive): event_id, date, latitude, longitude, animal_size (small | large).
 */
export function parseCrossingSpreadsheetBuffer(
  buffer: ArrayBuffer | Uint8Array
): SpreadsheetParseResult {
  if (!buffer || buffer.byteLength === 0) {
    return {
      valid: false,
      events: [],
      skippedRows: 0,
      error: 'The uploaded file is empty.',
    };
  }

  let workbook: XLSX.WorkBook;
  try {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    workbook = XLSX.read(bytes, { type: 'array', cellDates: true });
  } catch {
    return {
      valid: false,
      events: [],
      skippedRows: 0,
      error: 'Could not read spreadsheet file. Please upload a valid .xlsx, .xls, or .csv file.',
    };
  }

  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return {
      valid: false,
      events: [],
      skippedRows: 0,
      error: 'No worksheet found in the uploaded spreadsheet.',
    };
  }

  const sheet = workbook.Sheets[firstSheetName];
  const rawRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  if (rawRows.length === 0) {
    return {
      valid: false,
      events: [],
      skippedRows: 0,
      error: 'The worksheet contains no data rows.',
    };
  }

  const headerKeys = Object.keys(rawRows[0]);
  const findCol = (aliases: string[]): string | null => {
    for (const key of headerKeys) {
      const norm = normalizeHeaderKey(key);
      if (aliases.some((a) => norm === a || norm.includes(a))) {
        return key;
      }
    }
    return null;
  };

  const idCol = findCol(['eventid', 'id', 'tapahtumaid', 'event', 'tunnus']);
  const dateCol = findCol(['date', 'datetime', 'timestamp', 'pvm', 'paivamaara', 'päivämäärä', 'time']);
  const latCol = findCol(['latitude', 'lat', 'leveysaste', 'wgs84lat']);
  const lngCol = findCol(['longitude', 'lng', 'lon', 'long', 'pituusaste', 'wgs84lon', 'wgs84lng']);
  const sizeCol = findCol(['animalsize', 'categoryofanimalsize', 'sizecategory', 'size', 'category', 'koko', 'luokka']);

  const missing: string[] = [];
  if (!latCol) missing.push('latitude');
  if (!lngCol) missing.push('longitude');
  if (!sizeCol) missing.push('animal_size');

  if (missing.length > 0) {
    return {
      valid: false,
      events: [],
      skippedRows: 0,
      error: `Missing required column(s): ${missing.join(', ')}. Expected columns: event_id, date, latitude, longitude, animal_size (small or large).`,
    };
  }

  const events: CrossingEvent[] = [];
  let skippedRows = 0;

  for (let i = 0; i < rawRows.length; i++) {
    const row = rawRows[i];
    const lat = parseFlexibleNumber(row[latCol!]);
    const lng = parseFlexibleNumber(row[lngCol!]);
    const size = normalizeAnimalSize(row[sizeCol!]);

    const withinFinland =
      Number.isFinite(lat) &&
      Number.isFinite(lng) &&
      lat >= FINLAND_GEOGRAPHIC_BOUNDS.south - 0.3 &&
      lat <= FINLAND_GEOGRAPHIC_BOUNDS.north + 0.3 &&
      lng >= FINLAND_GEOGRAPHIC_BOUNDS.west - 0.3 &&
      lng <= FINLAND_GEOGRAPHIC_BOUNDS.east + 0.3;

    if (!withinFinland || !size) {
      skippedRows++;
      continue;
    }

    const rawId = idCol ? String(row[idCol] ?? '').trim() : '';
    const eventId = rawId || `EVT-${String(i + 1).padStart(4, '0')}`;
    const date = dateCol ? formatCellDate(row[dateCol]) : 'Unspecified';

    events.push({
      eventId,
      date,
      lat: Number(lat.toFixed(6)),
      lng: Number(lng.toFixed(6)),
      animalSize: size,
    });
  }

  if (events.length === 0) {
    return {
      valid: false,
      events: [],
      skippedRows,
      error:
        'No valid Finland wildlife crossing rows found. Check that latitude (59.4–70.1°N), longitude (19.0–31.6°E), and animal_size ("small" or "large") are populated.',
    };
  }

  return {
    valid: true,
    events,
    skippedRows,
  };
}

const METERS_PER_DEG = (Math.PI / 180) * EARTH_RADIUS_METERS;

export function groundDistanceAndBearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): { distanceM: number; bearingDeg: number } {
  const meanLatRad = (((lat1 + lat2) / 2) * Math.PI) / 180;
  const dx = (lng2 - lng1) * METERS_PER_DEG * Math.cos(meanLatRad);
  const dy = (lat2 - lat1) * METERS_PER_DEG;
  const distanceM = Math.hypot(dx, dy);
  const bearingDeg = (((Math.atan2(dx, dy) * 180) / Math.PI) % 360 + 360) % 360;
  return { distanceM, bearingDeg };
}

export function shortestAngularDiffDeg(aDeg: number, bDeg: number): number {
  const diff = Math.abs((((aDeg - bDeg) % 360) + 540) % 360 - 180);
  return diff;
}

interface IndexedRoadSegment {
  lat1: number;
  lng1: number;
  lat2: number;
  lng2: number;
}

export interface RoadSegmentSpatialIndex {
  cellDeg: number;
  buckets: Map<string, IndexedRoadSegment[]>;
  allSegments: IndexedRoadSegment[];
}

export interface NormalRoadCrossingSegment {
  startLat: number;
  startLng: number;
  roadLat: number;
  roadLng: number;
  endLat: number;
  endLng: number;
  distanceToRoadM: number;
  hasRoadCrossingLine: boolean;
}

const ROAD_INDEX_CELL_DEG = 0.012; // ~1.3 km grid cells
export const ROAD_CROSSING_OVERSHOOT_M = 16;

/**
 * Builds a fast 2D spatial grid index over `[lng, lat][]` road polylines so each animal
 * position in the test data can find its closest road segment in O(1) expected time.
 */
export function buildRoadSegmentIndex(
  roadPolylines: ReadonlyArray<ReadonlyArray<readonly [number, number]>>
): RoadSegmentSpatialIndex {
  const buckets = new Map<string, IndexedRoadSegment[]>();
  const allSegments: IndexedRoadSegment[] = [];

  for (const poly of roadPolylines) {
    for (let i = 0; i < poly.length - 1; i++) {
      const [lng1, lat1] = poly[i];
      const [lng2, lat2] = poly[i + 1];
      if (
        !Number.isFinite(lat1) ||
        !Number.isFinite(lng1) ||
        !Number.isFinite(lat2) ||
        !Number.isFinite(lng2)
      ) {
        continue;
      }
      if (Math.abs(lat2 - lat1) < 1e-8 && Math.abs(lng2 - lng1) < 1e-8) continue;

      const seg: IndexedRoadSegment = { lat1, lng1, lat2, lng2 };
      allSegments.push(seg);

      const minGx = Math.floor(Math.min(lng1, lng2) / ROAD_INDEX_CELL_DEG);
      const maxGx = Math.floor(Math.max(lng1, lng2) / ROAD_INDEX_CELL_DEG);
      const minGy = Math.floor(Math.min(lat1, lat2) / ROAD_INDEX_CELL_DEG);
      const maxGy = Math.floor(Math.max(lat1, lat2) / ROAD_INDEX_CELL_DEG);

      for (let gx = minGx; gx <= maxGx; gx++) {
        for (let gy = minGy; gy <= maxGy; gy++) {
          const key = `${gx}:${gy}`;
          const arr = buckets.get(key);
          if (arr) arr.push(seg);
          else buckets.set(key, [seg]);
        }
      }
    }
  }

  return {
    cellDeg: ROAD_INDEX_CELL_DEG,
    buckets,
    allSegments,
  };
}

/**
 * Models an animal at `(animalLat, animalLng)` next to a road by drawing a line from the animal's
 * position straight through the closest road at normal incidence (90° perpendicular to the road),
 * extending `overshootM` meters across the opposite side of the road carriageway.
 */
export function computeNormalRoadCrossingSegment(
  animalLat: number,
  animalLng: number,
  roadIndex: RoadSegmentSpatialIndex | null,
  overshootM: number = ROAD_CROSSING_OVERSHOOT_M
): NormalRoadCrossingSegment {
  if (!roadIndex || roadIndex.allSegments.length === 0) {
    return {
      startLat: animalLat,
      startLng: animalLng,
      roadLat: animalLat,
      roadLng: animalLng,
      endLat: animalLat,
      endLng: animalLng,
      distanceToRoadM: 0,
      hasRoadCrossingLine: false,
    };
  }

  const gx = Math.floor(animalLng / roadIndex.cellDeg);
  const gy = Math.floor(animalLat / roadIndex.cellDeg);

  let candidates: IndexedRoadSegment[] = [];
  for (const ringRadius of [1, 3]) {
    const seen = new Set<IndexedRoadSegment>();
    for (let dx = -ringRadius; dx <= ringRadius; dx++) {
      for (let dy = -ringRadius; dy <= ringRadius; dy++) {
        const list = roadIndex.buckets.get(`${gx + dx}:${gy + dy}`);
        if (!list) continue;
        for (const seg of list) {
          if (!seen.has(seg)) {
            seen.add(seg);
            candidates.push(seg);
          }
        }
      }
    }
    if (candidates.length > 0) break;
  }
  if (candidates.length === 0) {
    candidates = roadIndex.allSegments;
  }

  const cosLat = Math.cos((animalLat * Math.PI) / 180);
  const mPerDegLng = METERS_PER_DEG * cosLat;
  const mPerDegLat = METERS_PER_DEG;

  let bestDistSq = Infinity;
  let bestFootX = 0;
  let bestFootY = 0;
  let bestSegVx = 1;
  let bestSegVy = 0;

  for (const seg of candidates) {
    const x0 = (seg.lng1 - animalLng) * mPerDegLng;
    const y0 = (seg.lat1 - animalLat) * mPerDegLat;
    const x1 = (seg.lng2 - animalLng) * mPerDegLng;
    const y1 = (seg.lat2 - animalLat) * mPerDegLat;

    const vx = x1 - x0;
    const vy = y1 - y0;
    const lenSq = vx * vx + vy * vy;
    if (lenSq < 1e-9) continue;

    // Closest point on segment P0->P1 to animal origin (0, 0)
    const t = Math.max(0, Math.min(1, (-x0 * vx - y0 * vy) / lenSq));
    const px = x0 + t * vx;
    const py = y0 + t * vy;
    const distSq = px * px + py * py;

    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      bestFootX = px;
      bestFootY = py;
      bestSegVx = vx;
      bestSegVy = vy;
    }
  }

  if (!Number.isFinite(bestDistSq)) {
    return {
      startLat: animalLat,
      startLng: animalLng,
      roadLat: animalLat,
      roadLng: animalLng,
      endLat: animalLat,
      endLng: animalLng,
      distanceToRoadM: 0,
      hasRoadCrossingLine: false,
    };
  }

  const distToRoadM = Math.sqrt(bestDistSq);
  const roadLat = animalLat + bestFootY / mPerDegLat;
  const roadLng = animalLng + bestFootX / mPerDegLng;

  if (distToRoadM >= 3.5) {
    // Animal is off-road beside the road: draw straight from animal (0,0) through closest road point at 90° normal incidence
    const ux = bestFootX / distToRoadM;
    const uy = bestFootY / distToRoadM;
    const endX = bestFootX + ux * overshootM;
    const endY = bestFootY + uy * overshootM;

    return {
      startLat: Number(animalLat.toFixed(6)),
      startLng: Number(animalLng.toFixed(6)),
      roadLat: Number(roadLat.toFixed(6)),
      roadLng: Number(roadLng.toFixed(6)),
      endLat: Number((animalLat + endY / mPerDegLat).toFixed(6)),
      endLng: Number((animalLng + endX / mPerDegLng).toFixed(6)),
      distanceToRoadM: Number(distToRoadM.toFixed(1)),
      hasRoadCrossingLine: true,
    };
  }

  // Event coordinate is logged directly on the road carriageway/shoulder (< 3.5 m from centerline):
  // extend symmetrically across both lanes & shoulders along the road's 90° normal
  let nx: number;
  let ny: number;
  if (distToRoadM > 0.25) {
    nx = bestFootX / distToRoadM;
    ny = bestFootY / distToRoadM;
  } else {
    const segLen = Math.hypot(bestSegVx, bestSegVy) || 1;
    nx = -bestSegVy / segLen;
    ny = bestSegVx / segLen;
  }

  return {
    startLat: Number((roadLat - (ny * overshootM) / mPerDegLat).toFixed(6)),
    startLng: Number((roadLng - (nx * overshootM) / mPerDegLng).toFixed(6)),
    roadLat: Number(roadLat.toFixed(6)),
    roadLng: Number(roadLng.toFixed(6)),
    endLat: Number((roadLat + (ny * overshootM) / mPerDegLat).toFixed(6)),
    endLng: Number((roadLng + (nx * overshootM) / mPerDegLng).toFixed(6)),
    distanceToRoadM: Number(distToRoadM.toFixed(1)),
    hasRoadCrossingLine: true,
  };
}

function minDistanceOriginToSegment2D(
  ax: number,
  ay: number,
  bx: number,
  by: number
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    return Math.hypot(ax, ay);
  }
  const t = Math.max(0, Math.min(1, (-ax * dx - ay * dy) / lenSq));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function checkClippedSegmentAgainstWedge(
  cAx: number,
  cAy: number,
  cBx: number,
  cBy: number,
  lobeBearingDeg: number,
  fovDeg: number
): { detected: boolean; bestHitDistM: number } {
  const bearingRad = (lobeBearingDeg * Math.PI) / 180;
  const halfFovRad = ((fovDeg / 2 + 0.02) * Math.PI) / 180;
  const ux = Math.sin(bearingRad);
  const uy = Math.cos(bearingRad);
  const cosHalf = Math.cos(halfFovRad);

  const inAngularWedge = (px: number, py: number): boolean => {
    const r = Math.hypot(px, py);
    if (r <= 1e-3) return true;
    return px * ux + py * uy >= r * cosHalf - 1e-7;
  };

  const ex = cBx - cAx;
  const ey = cBy - cAy;
  if (ex * ex + ey * ey < 1e-9) {
    const r = Math.hypot(cAx, cAy);
    const hit = inAngularWedge(cAx, cAy);
    return { detected: hit, bestHitDistM: hit ? r : Infinity };
  }

  // Collect boundary parameters u in [0, 1] along clipped segment cA -> cB
  const breakParams: number[] = [0, 1];
  for (const rayRad of [bearingRad - halfFovRad, bearingRad + halfFovRad]) {
    const rx = Math.sin(rayRad);
    const ry = Math.cos(rayRad);
    const denom = ex * ry - ey * rx;
    if (Math.abs(denom) > 1e-10) {
      const u = (rx * cAy - ry * cAx) / denom;
      const s = (ex * cAy - ey * cAx) / denom;
      if (s >= -1e-7 && u >= -1e-7 && u <= 1 + 1e-7) {
        breakParams.push(Math.max(0, Math.min(1, u)));
      }
    }
  }

  // Also check closest approach to camera origin (0, 0)
  const uOrigin = Math.max(0, Math.min(1, (-cAx * ex - cAy * ey) / (ex * ex + ey * ey)));
  if (Math.hypot(cAx + uOrigin * ex, cAy + uOrigin * ey) <= 0.05) {
    breakParams.push(uOrigin);
  }

  breakParams.sort((a, b) => a - b);

  let detected = false;
  let bestHitDistM = Infinity;

  for (let i = 0; i < breakParams.length; i++) {
    const u = breakParams[i];
    const px = cAx + u * ex;
    const py = cAy + u * ey;
    if (inAngularWedge(px, py)) {
      detected = true;
      const d = Math.hypot(px, py);
      if (d < bestHitDistM) bestHitDistM = d;
    }
    if (i < breakParams.length - 1) {
      const uNext = breakParams[i + 1];
      if (uNext - u > 1e-7) {
        const uMid = (u + uNext) / 2;
        const mx = cAx + uMid * ex;
        const my = cAy + uMid * ey;
        if (inAngularWedge(mx, my)) {
          detected = true;
          const subDist = minDistanceOriginToSegment2D(
            cAx + u * ex,
            cAy + u * ey,
            cAx + uNext * ex,
            cAy + uNext * ey
          );
          if (subDist < bestHitDistM) bestHitDistM = subDist;
        }
      }
    }
  }

  return { detected, bestHitDistM };
}

/**
 * Exact 2D line-segment vs. bidirectional circular-sector (dual camera line of sight) intersection test.
 * Registers a detection if and only if any point along the animal's road-crossing segment
 * `[startLat, startLng] -> [endLat, endLng]` falls within either of the camera's two opposing road cones and capture range.
 */
export function doesCameraDetectCrossingLine(
  camera: Pick<PlannedCameraNode, 'lat' | 'lng' | 'bearingDeg'> & { reverseBearingDeg?: number },
  startLat: number,
  startLng: number,
  endLat: number,
  endLng: number,
  animalSize: AnimalSizeCategory,
  rangeMeters: number,
  fovDeg: number,
  scaleRangeByAnimalSize: boolean
): { detected: boolean; distanceM: number } {
  const baseRange =
    scaleRangeByAnimalSize && animalSize === 'small'
      ? rangeMeters * SMALL_ANIMAL_RANGE_FACTOR
      : rangeMeters;
  // 5 cm numerical tolerance prevents coordinate rounding from rejecting lines touching the rendered cone arc
  const effectiveMaxRange = baseRange + 0.05;

  const cosLat = Math.cos((camera.lat * Math.PI) / 180);
  const mPerDegLng = METERS_PER_DEG * cosLat;
  const mPerDegLat = METERS_PER_DEG;

  const ax = (startLng - camera.lng) * mPerDegLng;
  const ay = (startLat - camera.lat) * mPerDegLat;
  const bx = (endLng - camera.lng) * mPerDegLng;
  const by = (endLat - camera.lat) * mPerDegLat;

  const closestSegDistM = minDistanceOriginToSegment2D(ax, ay, bx, by);
  if (closestSegDistM > effectiveMaxRange) {
    return { detected: false, distanceM: closestSegDistM };
  }

  const dx = bx - ax;
  const dy = by - ay;
  const segLenSq = dx * dx + dy * dy;

  // Clip segment A->B to disk of radius `effectiveMaxRange`
  let cAx = ax;
  let cAy = ay;
  let cBx = bx;
  let cBy = by;

  if (segLenSq >= 1e-9) {
    const aQuad = segLenSq;
    const bQuad = 2 * (ax * dx + ay * dy);
    const cQuad = ax * ax + ay * ay - effectiveMaxRange * effectiveMaxRange;
    const disc = Math.max(0, bQuad * bQuad - 4 * aQuad * cQuad);
    const sqrtDisc = Math.sqrt(disc);
    const t0 = Math.max(0, (-bQuad - sqrtDisc) / (2 * aQuad));
    const t1 = Math.min(1, (-bQuad + sqrtDisc) / (2 * aQuad));
    if (t0 > t1 + 1e-9) {
      return { detected: false, distanceM: closestSegDistM };
    }
    const clampedT0 = Math.min(t0, t1);
    cAx = ax + clampedT0 * dx;
    cAy = ay + clampedT0 * dy;
    cBx = ax + t1 * dx;
    cBy = ay + t1 * dy;
  }

  const [b1, b2] = getCameraBearings(camera);
  const gap1 = (((b2 - b1) % 360) + 360) % 360;
  const gap2 = 360 - gap1;

  if (fovDeg >= 359.5 || (fovDeg >= gap1 - 0.05 && fovDeg >= gap2 - 0.05)) {
    return {
      detected: true,
      distanceM: minDistanceOriginToSegment2D(cAx, cAy, cBx, cBy),
    };
  }

  const hit1 = checkClippedSegmentAgainstWedge(cAx, cAy, cBx, cBy, b1, fovDeg);
  const hit2 = checkClippedSegmentAgainstWedge(cAx, cAy, cBx, cBy, b2, fovDeg);
  const detected = hit1.detected || hit2.detected;
  const bestHitDistM = Math.min(hit1.bestHitDistM, hit2.bestHitDistM);

  return {
    detected,
    distanceM: detected ? bestHitDistM : closestSegDistM,
  };
}

/**
 * Determines whether a bidirectional camera detects a point crossing event in either road direction
 * given rangeMeters, fovDeg, and optional small-animal range scaling.
 */
export function doesCameraDetectEvent(
  camera: Pick<PlannedCameraNode, 'lat' | 'lng' | 'bearingDeg'> & { reverseBearingDeg?: number },
  event: Pick<CrossingEvent, 'lat' | 'lng' | 'animalSize'>,
  rangeMeters: number,
  fovDeg: number,
  scaleRangeByAnimalSize: boolean
): { detected: boolean; distanceM: number } {
  const effectiveMaxRange =
    (scaleRangeByAnimalSize && event.animalSize === 'small'
      ? rangeMeters * SMALL_ANIMAL_RANGE_FACTOR
      : rangeMeters) + 0.05;

  const { distanceM, bearingDeg } = groundDistanceAndBearing(
    camera.lat,
    camera.lng,
    event.lat,
    event.lng
  );

  if (distanceM > effectiveMaxRange) {
    return { detected: false, distanceM };
  }
  const [b1, b2] = getCameraBearings(camera);
  const gap1 = (((b2 - b1) % 360) + 360) % 360;
  const gap2 = 360 - gap1;
  if (
    fovDeg >= 359.5 ||
    (fovDeg >= gap1 - 0.05 && fovDeg >= gap2 - 0.05) ||
    distanceM <= Math.min(2, effectiveMaxRange)
  ) {
    return { detected: true, distanceM };
  }
  const halfFov = fovDeg / 2 + 0.02;
  const detected =
    shortestAngularDiffDeg(bearingDeg, b1) <= halfFov ||
    shortestAngularDiffDeg(bearingDeg, b2) <= halfFov;
  return {
    detected,
    distanceM,
  };
}

/**
 * Evaluates crossing events located inside camera-covered areas:
 * 1. Boundary clipping to active Areas of Interest (or municipalities when no custom scope is passed).
 * 2. Year selector (`simConfig.selectedYear`, e.g. 2024, 2025, 2026, or 'all').
 * 3. Normal-incidence road crossing model: when road geometry is present on an Area of Interest,
 *    draws a line from the animal's position through the closest road at normal incidence (90°)
 *    and checks whether that crossing line intersects the line of sight of any camera.
 */
export function evaluateCrossingEvents(
  events: CrossingEvent[],
  cameras: PlannedCameraNode[],
  coverageConfig: Pick<CameraCoverageConfig, 'rangeMeters' | 'fovDeg'>,
  simConfig: Pick<SimulatorConfig, 'scaleRangeByAnimalSize' | 'sizeFilter'> &
    Partial<Pick<SimulatorConfig, 'arrangementId' | 'selectedYear'>>,
  customScope: CustomAreaSimulationScope | ReadonlyArray<CustomAreaSimulationScope> | null = null
): {
  evaluated: EvaluatedCrossingEvent[];
  summary: SimulationSummary;
} {
  const coveredCityIds = new Set(cameras.map((c) => c.cityId));
  const selectedYear = simConfig.selectedYear ?? 'all';

  interface CoveredEventRecord {
    event: CrossingEvent;
    areaId: string;
    areaName: string;
    parsedDate: ParsedEventDateDetails;
  }

  const inCoveredCityRecords: CoveredEventRecord[] = [];
  const yearSet = new Set<number>();
  let excludedOutsideCitiesCount = 0;

  const scopeList: ReadonlyArray<CustomAreaSimulationScope> | null = Array.isArray(customScope)
    ? customScope
    : customScope !== null
      ? [customScope as CustomAreaSimulationScope]
      : null;

  // Build spatial road segment index across active Areas of Interest when roadPolylines are provided
  const roadIndexByAreaId = new Map<string, RoadSegmentSpatialIndex>();
  let globalRoadIndex: RoadSegmentSpatialIndex | null = null;
  if (scopeList !== null) {
    const combinedPolylines: Array<ReadonlyArray<readonly [number, number]>> = [];
    for (const scope of scopeList) {
      if (scope.roadPolylines && scope.roadPolylines.length > 0) {
        const key = scope.id ?? 'custom-area';
        roadIndexByAreaId.set(key, buildRoadSegmentIndex(scope.roadPolylines));
        for (const poly of scope.roadPolylines) {
          combinedPolylines.push(poly);
        }
      }
    }
    if (combinedPolylines.length > 0) {
      globalRoadIndex = buildRoadSegmentIndex(combinedPolylines);
    }
  }

  for (const ev of events) {
    if (scopeList !== null) {
      const matchedScope = findMatchingCustomAreaScope(ev.lat, ev.lng, scopeList);
      if (!matchedScope) {
        excludedOutsideCitiesCount++;
        continue;
      }
      const parsedDate = parseEventDateDetails(ev.date);
      if (parsedDate.year !== null) {
        yearSet.add(parsedDate.year);
      }
      inCoveredCityRecords.push({
        event: ev,
        areaId: matchedScope.id ?? 'custom-area',
        areaName: matchedScope.label,
        parsedDate,
      });
    } else {
      const city = findCameraCoveredCity(ev.lat, ev.lng, coveredCityIds);
      if (!city) {
        excludedOutsideCitiesCount++;
        continue;
      }
      const parsedDate = parseEventDateDetails(ev.date);
      if (parsedDate.year !== null) {
        yearSet.add(parsedDate.year);
      }
      inCoveredCityRecords.push({
        event: ev,
        areaId: city.id,
        areaName: city.name,
        parsedDate,
      });
    }
  }

  const availableYears = Array.from(yearSet).sort((a, b) => a - b);

  let yearFilteredOutCount = 0;
  const yearScopedRecords: CoveredEventRecord[] = [];
  for (const rec of inCoveredCityRecords) {
    if (selectedYear !== 'all' && rec.parsedDate.year !== selectedYear) {
      yearFilteredOutCount++;
      continue;
    }
    yearScopedRecords.push(rec);
  }

  const sizeScopedRecords =
    simConfig.sizeFilter === 'all'
      ? yearScopedRecords
      : yearScopedRecords.filter((rec) => rec.event.animalSize === simConfig.sizeFilter);

  // Spatial bucket index (~4 km grid cells) across all active year-round cameras
  const CELL_DEG = 0.04;
  const buckets = new Map<string, PlannedCameraNode[]>();

  for (const cam of cameras) {
    const gx = Math.floor(cam.lng / CELL_DEG);
    const gy = Math.floor(cam.lat / CELL_DEG);
    const key = `${gx}:${gy}`;
    const list = buckets.get(key);
    if (list) list.push(cam);
    else buckets.set(key, [cam]);
  }

  const evaluated: EvaluatedCrossingEvent[] = sizeScopedRecords.map(
    ({ event: ev, areaId, areaName, parsedDate }) => {
      const areaRoadIndex = globalRoadIndex ?? roadIndexByAreaId.get(areaId) ?? null;
      const crossingSeg = computeNormalRoadCrossingSegment(ev.lat, ev.lng, areaRoadIndex);

      // Query camera grid across the full bounding box of the crossing segment (±1 cell margin)
      const minLng = crossingSeg.hasRoadCrossingLine
        ? Math.min(crossingSeg.startLng, crossingSeg.endLng)
        : ev.lng;
      const maxLng = crossingSeg.hasRoadCrossingLine
        ? Math.max(crossingSeg.startLng, crossingSeg.endLng)
        : ev.lng;
      const minLat = crossingSeg.hasRoadCrossingLine
        ? Math.min(crossingSeg.startLat, crossingSeg.endLat)
        : ev.lat;
      const maxLat = crossingSeg.hasRoadCrossingLine
        ? Math.max(crossingSeg.startLat, crossingSeg.endLat)
        : ev.lat;

      const minGx = Math.floor(minLng / CELL_DEG) - 1;
      const maxGx = Math.floor(maxLng / CELL_DEG) + 1;
      const minGy = Math.floor(minLat / CELL_DEG) - 1;
      const maxGy = Math.floor(maxLat / CELL_DEG) + 1;

      let nearbyCams: PlannedCameraNode[] = [];
      for (let gx = minGx; gx <= maxGx; gx++) {
        for (let gy = minGy; gy <= maxGy; gy++) {
          const cell = buckets.get(`${gx}:${gy}`);
          if (cell) nearbyCams.push(...cell);
        }
      }
      if (nearbyCams.length === 0) {
        nearbyCams = cameras.filter((c) => c.cityId === areaId);
        if (nearbyCams.length === 0) {
          nearbyCams = cameras;
        }
      }

      let nearestCam = nearbyCams[0] ?? cameras[0];
      let nearestDistanceM = Infinity;
      let detectingCam: PlannedCameraNode | null = null;
      let detectingDistM = Infinity;

      for (const cam of nearbyCams) {
        const check = crossingSeg.hasRoadCrossingLine
          ? doesCameraDetectCrossingLine(
              cam,
              crossingSeg.startLat,
              crossingSeg.startLng,
              crossingSeg.endLat,
              crossingSeg.endLng,
              ev.animalSize,
              coverageConfig.rangeMeters,
              coverageConfig.fovDeg,
              simConfig.scaleRangeByAnimalSize
            )
          : doesCameraDetectEvent(
              cam,
              ev,
              coverageConfig.rangeMeters,
              coverageConfig.fovDeg,
              simConfig.scaleRangeByAnimalSize
            );

        if (check.distanceM < nearestDistanceM) {
          nearestDistanceM = check.distanceM;
          nearestCam = cam;
        }
        if (check.detected && check.distanceM < detectingDistM) {
          detectingDistM = check.distanceM;
          detectingCam = cam;
        }
      }

      const detected = detectingCam !== null;

      return {
        ...ev,
        year: parsedDate.year,
        dayOfYear: parsedDate.dayOfYear,
        cityId: areaId,
        cityName: areaName,
        crossingStartLat: crossingSeg.startLat,
        crossingStartLng: crossingSeg.startLng,
        roadLat: crossingSeg.roadLat,
        roadLng: crossingSeg.roadLng,
        crossingEndLat: crossingSeg.endLat,
        crossingEndLng: crossingSeg.endLng,
        distanceToRoadM: crossingSeg.distanceToRoadM,
        hasRoadCrossingLine: crossingSeg.hasRoadCrossingLine,
        detected,
        detectedByCameraId: detectingCam ? detectingCam.id : null,
        detectedCameraCity: detectingCam ? detectingCam.cityName : null,
        detectedDistanceM:
          detectingCam && Number.isFinite(detectingDistM) ? Math.round(detectingDistM) : null,
        nearestCameraId: nearestCam ? nearestCam.id : 'N/A',
        nearestDistanceM: Number.isFinite(nearestDistanceM) ? Math.round(nearestDistanceM) : 0,
      };
    }
  );

  let detectedCount = 0;
  let largeTotal = 0;
  let largeDetected = 0;
  let smallTotal = 0;
  let smallDetected = 0;

  for (const ev of evaluated) {
    if (ev.detected) detectedCount++;
    if (ev.animalSize === 'large') {
      largeTotal++;
      if (ev.detected) largeDetected++;
    } else {
      smallTotal++;
      if (ev.detected) smallDetected++;
    }
  }

  const totalEvents = evaluated.length;
  const missedCount = totalEvents - detectedCount;

  return {
    evaluated,
    summary: {
      uploadedEventsCount: events.length,
      excludedOutsideCitiesCount,
      availableYears,
      selectedYear,
      yearFilteredOutCount,
      coveredEventsInSelectedYear: yearScopedRecords.length,
      totalEvents,
      detectedCount,
      missedCount,
      detectionRatePct: totalEvents > 0 ? (detectedCount / totalEvents) * 100 : 0,
      largeTotal,
      largeDetected,
      largeRatePct: largeTotal > 0 ? (largeDetected / largeTotal) * 100 : 0,
      smallTotal,
      smallDetected,
      smallRatePct: smallTotal > 0 ? (smallDetected / smallTotal) * 100 : 0,
    },
  };
}

/**
 * Generates a downloadable sample Excel (.xlsx) template spanning 2024–2026.
 * When active Areas of Interest are provided, generates 30 roadside animal positions inside them.
 */
export function buildSampleTemplateWorkbook(
  areas?: ReadonlyArray<CustomAreaPlanResult>
): ArrayBuffer {
  const sampleRows = [];
  if (areas && areas.length > 0) {
    const areaDemo = generateAreasDemoCrossings(areas).filter(
      (e) => !e.eventId.includes('-OUT-')
    );
    const step = Math.max(1, Math.floor(areaDemo.length / 30));
    for (let i = 0; i < areaDemo.length && sampleRows.length < 30; i += step) {
      const ev = areaDemo[i];
      sampleRows.push({
        event_id: ev.eventId,
        date: ev.date,
        latitude: ev.lat,
        longitude: ev.lng,
        animal_size: ev.animalSize,
      });
    }
  }

  if (sampleRows.length === 0) {
    const step = Math.max(1, Math.floor(DEMO_SYNTHETIC_CROSSING_TUPLES.length / 30));
    for (
      let i = 0;
      i < DEMO_SYNTHETIC_CROSSING_TUPLES.length && sampleRows.length < 30;
      i += step
    ) {
      const [event_id, date, latitude, longitude, animal_size] = DEMO_SYNTHETIC_CROSSING_TUPLES[i];
      sampleRows.push({
        event_id,
        date,
        latitude,
        longitude,
        animal_size,
      });
    }
  }

  const ws = XLSX.utils.json_to_sheet(sampleRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'animal_crossings');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

/**
 * Generates an Excel (.xlsx) report of evaluated crossing events including normal-incidence road crossing coordinates.
 */
export function buildEvaluatedResultsWorkbook(
  evaluated: EvaluatedCrossingEvent[],
  arrangementLabel: string,
  rangeMeters: number,
  fovDeg: number
): ArrayBuffer {
  const rows = evaluated.map((ev) => ({
    event_id: ev.eventId,
    date: ev.date,
    year: ev.year ?? '',
    area: ev.cityName,
    animal_latitude: ev.lat,
    animal_longitude: ev.lng,
    road_crossing_latitude: ev.roadLat,
    road_crossing_longitude: ev.roadLng,
    distance_to_road_m: ev.distanceToRoadM,
    animal_size: ev.animalSize,
    status: ev.detected ? 'DETECTED' : 'MISSED',
    detected_by_camera: ev.detectedByCameraId ?? '',
    nearest_camera_id: ev.nearestCameraId,
    nearest_camera_distance_m: ev.nearestDistanceM,
    arrangement: arrangementLabel,
    range_m: rangeMeters,
    fov_deg: fovDeg,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'simulation_results');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
