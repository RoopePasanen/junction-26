import * as XLSX from 'xlsx';
import {
  ALL_PLANNED_CAMERAS,
  SECTOR_IDS,
  SECTOR_ROTATION_SCHEDULE,
  TOP_5_WILDLIFE_ACCIDENT_CITIES,
  type CityCameraPlan,
  type PlannedCameraNode,
  type SectorFilter,
  type SectorId,
} from '../data/finlandWildlifePlan';
import {
  DEMO_SYNTHETIC_CROSSING_TUPLES,
  SECTOR_MICRO_CLUSTERS_BY_CITY,
  STATIC_HOTSPOT_SCATTER_BY_CITY,
  type SectorClusterTuple,
  type StaticCameraTuple,
} from '../data/simulationPresets';
import type { CameraCoverageConfig } from './cameraPlanGeometry';
import { destinationPoint } from './cameraPlanGeometry';
import { FINLAND_GEOGRAPHIC_BOUNDS } from './mapMath';
import type { CustomAreaPlanResult } from '../types/customAreaPlan';

export interface CustomAreaSimulationScope {
  center: { lat: number; lng: number };
  radiusKm: number;
  label: string;
}

export type AnimalSizeCategory = 'small' | 'large';

export type CameraArrangementId =
  | 'sector-maximal'
  | 'sector-clusters'
  | 'static-year-round';

export interface CameraArrangementSpec {
  id: CameraArrangementId;
  label: string;
  shortLabel: string;
  spacingSummary: string;
  description: string;
  isRotational: boolean;
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
  activeSector: SectorId;
}

export interface EvaluatedCrossingEvent extends CrossingEvent {
  year: number | null;
  dayOfYear: number;
  cityId: string;
  cityName: string;
  /** Which sector (1–5) physically held the city's 100 cameras on this event's date */
  activeRotationSector: SectorId;
  /** Which geographic sector (1–5) of the municipality this crossing occurred in */
  eventSpatialSector: SectorId;
  /** True if cameras were deployed in this event's sector on that date (or static year-round) */
  camerasPresentInEventSector: boolean;
  detected: boolean;
  detectedByCameraId: string | null;
  detectedCameraCity: string | null;
  nearestCameraId: string;
  nearestDistanceM: number;
}

export interface SectorSimulationStat {
  sectorIndex: SectorId;
  shortPeriod: string;
  totalInSector: number;
  inActiveWindowCount: number;
  detectedCount: number;
  ratePct: number;
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
  inActiveSectorEventsCount: number;
  outOfWindowEventsCount: number;
  largeTotal: number;
  largeDetected: number;
  largeRatePct: number;
  smallTotal: number;
  smallDetected: number;
  smallRatePct: number;
  bySector: SectorSimulationStat[];
}

export interface SpreadsheetParseResult {
  valid: boolean;
  events: CrossingEvent[];
  skippedRows: number;
  error?: string;
}

export const SMALL_ANIMAL_RANGE_FACTOR = 0.7;

export const DEFAULT_SIMULATOR_CONFIG: SimulatorConfig = {
  arrangementId: 'sector-maximal',
  selectedYear: 'all',
  scaleRangeByAnimalSize: true,
  sizeFilter: 'all',
  showDetectedHeatmap: true,
  showMissedHeatmap: true,
  showEventPoints: true,
};

export const CAMERA_ARRANGEMENTS: CameraArrangementSpec[] = [
  {
    id: 'sector-maximal',
    label: '5-Zone Priority-Dense Coverage (100 cam/zone · 73 d)',
    shortLabel: '5-Zone Priority',
    spacingSummary: '5 compact zones · 73 d',
    description:
      'Concentrates 100 cameras/city densely along high-priority collision stretches across 5 compact zones rotated every 1/5th year.',
    isRotational: true,
  },
  {
    id: 'sector-clusters',
    label: '5-Zone Hotspot Micro-Clusters (75–95 m · 73 d)',
    shortLabel: '5-Zone Clusters',
    spacingSummary: '5 zones · 10 clusters',
    description:
      'Rotates 100 cameras/city across 5 compact zones (73 d each) grouped into 10 tight corridor pinch-point clusters per zone.',
    isRotational: true,
  },
  {
    id: 'static-year-round',
    label: 'Static Year-Round Baseline (Dense Top Hotspots · 365 d)',
    shortLabel: 'Static Year-Round',
    spacingSummary: '1 fixed · 365 d',
    description:
      'Keeps 100 cameras/city packed densely on the highest-priority collision blackspots all year without rotating.',
    isRotational: false,
  },
];

function buildSectorClusterCameras(
  byCity: Record<string, SectorClusterTuple[]>
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
      const [lat, lng, bearingDeg, sectorIndex, clusterIndex, roadLabel] = tuple;
      const secMeta = city.sectors.find((s) => s.sectorIndex === sectorIndex) ?? city.sectors[0];
      list.push({
        ...baseCam,
        lat,
        lng,
        bearingDeg,
        sectorIndex,
        sectorName: secMeta.name,
        sectorPeriod: secMeta.shortPeriod,
        clusterIndex,
        clusterSize: 10,
        roadLabel,
        clusterLabel: `S${sectorIndex} C#${clusterIndex} · ${roadLabel}`,
      });
    }
  }
  return list;
}

function buildStaticYearRoundCameras(
  byCity: Record<string, StaticCameraTuple[]>
): PlannedCameraNode[] {
  const list: PlannedCameraNode[] = [];
  for (const city of TOP_5_WILDLIFE_ACCIDENT_CITIES) {
    const tuples = byCity[city.id] ?? [];
    for (let i = 0; i < tuples.length; i++) {
      const [lat, lng, bearingDeg, rankInCity, historicalAccidents, roadLabel] = tuples[i];
      const spatialSec = findCitySectorForPoint(lat, lng, city);
      const secMeta = city.sectors.find((s) => s.sectorIndex === spatialSec) ?? city.sectors[0];
      const templateCam = city.cameras[i] ?? city.cameras[0];
      list.push({
        ...templateCam,
        id: `${city.prefix}-${String(rankInCity).padStart(3, '0')}`,
        cityId: city.id,
        cityName: city.name,
        sectorIndex: spatialSec,
        sectorName: `${secMeta.name} (Year-Round)`,
        sectorPeriod: 'Jan 1 – Dec 31',
        unitNumber: rankInCity,
        rankInSector: rankInCity,
        rankInCity,
        clusterIndex: rankInCity,
        clusterSize: 1,
        roadLabel,
        clusterLabel: `Year-Round #${rankInCity} · ${roadLabel}`,
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
      'sector-maximal': ALL_PLANNED_CAMERAS,
      'sector-clusters': buildSectorClusterCameras(SECTOR_MICRO_CLUSTERS_BY_CITY),
      'static-year-round': buildStaticYearRoundCameras(STATIC_HOTSPOT_SCATTER_BY_CITY),
    };
  }
  return cachedArrangements[arrangementId] ?? ALL_PLANNED_CAMERAS;
}

export function isArrangementRotational(arrangementId?: CameraArrangementId): boolean {
  if (!arrangementId) return true;
  const spec = CAMERA_ARRANGEMENTS.find((a) => a.id === arrangementId);
  return spec ? spec.isRotational : true;
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
 * Returns which of the 5 municipal deployment sectors (1..5) contains (lat, lng).
 * Checks exact Voronoi sector polygons first, falling back to nearest sector center.
 */
export function findCitySectorForPoint(
  lat: number,
  lng: number,
  city: Pick<CityCameraPlan, 'sectors'>
): SectorId {
  for (const sec of city.sectors) {
    if (sec.voronoiRing.length >= 3 && isPointInPolygonRing(lng, lat, sec.voronoiRing)) {
      return sec.sectorIndex;
    }
  }
  let bestSector: SectorId = 1;
  let bestDist = Infinity;
  for (const sec of city.sectors) {
    const d = groundDistanceAndBearing(lat, lng, sec.center.lat, sec.center.lng).distanceM;
    if (d < bestDist) {
      bestDist = d;
      bestSector = sec.sectorIndex;
    }
  }
  return bestSector;
}

/**
 * Parses an event date string (YYYY-MM-DD, DD.MM.YYYY, YYYY/MM/DD, etc.) into calendar year,
 * day-of-year (1..365/366), and active 1/5th-year camera rotation sector (1..5).
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
      activeSector: 1,
    };
  }

  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInYear = isLeap ? 366 : 365;
  const startOfYearUtc = Date.UTC(year, 0, 0);
  const dateUtc = Date.UTC(year, month - 1, day);
  const rawDayOfYear = Math.round((dateUtc - startOfYearUtc) / 86_400_000);
  const dayOfYear = Math.max(1, Math.min(daysInYear, rawDayOfYear));
  const activeSector = Math.min(
    5,
    Math.floor(((dayOfYear - 1) / daysInYear) * 5) + 1
  ) as SectorId;

  return {
    year,
    dayOfYear,
    daysInYear,
    activeSector,
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
  const { distanceM } = groundDistanceAndBearing(scope.center.lat, scope.center.lng, lat, lng);
  return distanceM <= scope.radiusKm * 1000;
}

export function filterEventsInCoveredCities(
  events: CrossingEvent[],
  cameras: PlannedCameraNode[] = ALL_PLANNED_CAMERAS,
  customScope: CustomAreaSimulationScope | null = null
): CrossingEvent[] {
  if (customScope) {
    return events.filter((ev) => isPointInCustomAreaScope(ev.lat, ev.lng, customScope));
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
 * - 1,320 inside the 5 camera-covered cities (440/year across all 5 rotation windows)
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
 * Generates deterministic multi-year (2024–2026) synthetic crossing events along the roads
 * and collision hotspots of an active Custom Location & Radius plan so users can immediately
 * simulate detection performance in any custom area.
 */
export function generateCustomAreaDemoCrossings(plan: CustomAreaPlanResult): CrossingEvent[] {
  const events: CrossingEvent[] = [];
  const demoYears = [2024, 2025, 2026];
  const cams = plan.cameras;
  const hotspots = plan.hotspots;
  if (cams.length === 0) return events;

  for (let yIdx = 0; yIdx < demoYears.length; yIdx++) {
    const yr = demoYears[yIdx];
    // 130 events/yr along camera road sightlines (varying distances 8m..110m so range slider 5..100m responds smoothly)
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

    // 90 events/yr across broader Ramboll collision hotspots inside the radius (mostly unmonitored gaps)
    const sourceHotspots =
      hotspots.length > 0
        ? hotspots
        : cams.map((c) => [c.lng, c.lat, Math.max(1, c.historicalAccidents)] as [number, number, number]);
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

    // 25 events/yr outside the custom circle to verify radius boundary clipping
    for (let k = 0; k < 25; k++) {
      const outsideDistM = (plan.radiusKm + 3 + (k % 9)) * 1000;
      const pt = destinationPoint(plan.center, outsideDistM, (k * 47 + yIdx * 31) % 360);
      if (
        pt.lat < FINLAND_GEOGRAPHIC_BOUNDS.south ||
        pt.lat > FINLAND_GEOGRAPHIC_BOUNDS.north ||
        pt.lng < FINLAND_GEOGRAPHIC_BOUNDS.west ||
        pt.lng > FINLAND_GEOGRAPHIC_BOUNDS.east
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

export function groundDistanceAndBearing(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): { distanceM: number; bearingDeg: number } {
  const meanLatRad = (((lat1 + lat2) / 2) * Math.PI) / 180;
  const dx = (lng2 - lng1) * 111_320 * Math.cos(meanLatRad);
  const dy = (lat2 - lat1) * 111_132;
  const distanceM = Math.hypot(dx, dy);
  const bearingDeg = (((Math.atan2(dx, dy) * 180) / Math.PI) % 360 + 360) % 360;
  return { distanceM, bearingDeg };
}

export function shortestAngularDiffDeg(aDeg: number, bDeg: number): number {
  const diff = Math.abs((((aDeg - bDeg) % 360) + 540) % 360 - 180);
  return diff;
}

/**
 * Determines whether a single camera detects a crossing event given rangeMeters, fovDeg,
 * and optional small-animal range scaling. Includes a 4m near-pole road-verge capture radius
 * so an animal crossing immediately past the sensor mount triggers the PIR/camera.
 */
export function doesCameraDetectEvent(
  camera: Pick<PlannedCameraNode, 'lat' | 'lng' | 'bearingDeg'>,
  event: Pick<CrossingEvent, 'lat' | 'lng' | 'animalSize'>,
  rangeMeters: number,
  fovDeg: number,
  scaleRangeByAnimalSize: boolean
): { detected: boolean; distanceM: number } {
  const effectiveMaxRange =
    scaleRangeByAnimalSize && event.animalSize === 'small'
      ? rangeMeters * SMALL_ANIMAL_RANGE_FACTOR
      : rangeMeters;

  const { distanceM, bearingDeg } = groundDistanceAndBearing(
    camera.lat,
    camera.lng,
    event.lat,
    event.lng
  );

  if (distanceM > effectiveMaxRange) {
    return { detected: false, distanceM };
  }
  if (fovDeg >= 359.5 || distanceM <= Math.min(4, effectiveMaxRange)) {
    return { detected: true, distanceM };
  }
  const halfFov = fovDeg / 2;
  const angleDiff = shortestAngularDiffDeg(bearingDeg, camera.bearingDeg);
  return {
    detected: angleDiff <= halfFov,
    distanceM,
  };
}

/**
 * Evaluates crossing events located inside camera-covered municipalities, taking into account:
 * 1. Covered-city boundary clipping (events outside camera cities are excluded).
 * 2. Year selector (`simConfig.selectedYear`, e.g. 2024, 2025, 2026, or 'all').
 * 3. Spatio-temporal 1/5th-year sector rotation: during each 73-day fifth of the year,
 *    only the 100 cameras/city assigned to `Sector [activeRotationSector]` are physically
 *    deployed on the ground (unless using the `'static-year-round'` baseline).
 * 4. Optional `sectorFilter` ('all' or 1..5) to inspect a single sector's events & rate.
 */
export function evaluateCrossingEvents(
  events: CrossingEvent[],
  cameras: PlannedCameraNode[],
  coverageConfig: Pick<CameraCoverageConfig, 'rangeMeters' | 'fovDeg'>,
  simConfig: Pick<SimulatorConfig, 'scaleRangeByAnimalSize' | 'sizeFilter'> &
    Partial<Pick<SimulatorConfig, 'arrangementId' | 'selectedYear'>>,
  sectorFilter: SectorFilter = 'all',
  customScope: CustomAreaSimulationScope | null = null
): {
  evaluated: EvaluatedCrossingEvent[];
  summary: SimulationSummary;
} {
  const coveredCityIds = new Set(cameras.map((c) => c.cityId));
  const selectedYear = simConfig.selectedYear ?? 'all';
  const rotational = customScope ? false : isArrangementRotational(simConfig.arrangementId);

  interface CoveredEventRecord {
    event: CrossingEvent;
    areaId: string;
    areaName: string;
    parsedDate: ParsedEventDateDetails;
    spatialSector: SectorId;
  }

  const inCoveredCityRecords: CoveredEventRecord[] = [];
  const yearSet = new Set<number>();
  let excludedOutsideCitiesCount = 0;

  for (const ev of events) {
    if (customScope) {
      const { distanceM, bearingDeg } = groundDistanceAndBearing(
        customScope.center.lat,
        customScope.center.lng,
        ev.lat,
        ev.lng
      );
      if (distanceM > customScope.radiusKm * 1000) {
        excludedOutsideCitiesCount++;
        continue;
      }
      const parsedDate = parseEventDateDetails(ev.date);
      if (parsedDate.year !== null) {
        yearSet.add(parsedDate.year);
      }
      const angularSector = ((Math.floor(bearingDeg / 72) % 5) + 1) as SectorId;
      inCoveredCityRecords.push({
        event: ev,
        areaId: 'custom-area',
        areaName: customScope.label,
        parsedDate,
        spatialSector: angularSector,
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
      const spatialSector = findCitySectorForPoint(ev.lat, ev.lng, city);
      inCoveredCityRecords.push({
        event: ev,
        areaId: city.id,
        areaName: city.name,
        parsedDate,
        spatialSector,
      });
    }
  }

  const availableYears = Array.from(yearSet).sort((a, b) => a - b);

  // Apply Year Selector filter
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

  // Build spatial bucket index (~4 km grid cells), keyed by active rotation sector when rotational
  const CELL_DEG = 0.04;
  const buckets = new Map<string, PlannedCameraNode[]>();
  const camsBySector: Record<SectorId, PlannedCameraNode[]> = {
    1: [],
    2: [],
    3: [],
    4: [],
    5: [],
  };

  for (const cam of cameras) {
    camsBySector[cam.sectorIndex].push(cam);
    const gx = Math.floor(cam.lng / CELL_DEG);
    const gy = Math.floor(cam.lat / CELL_DEG);
    const key = rotational ? `${cam.sectorIndex}:${gx}:${gy}` : `all:${gx}:${gy}`;
    const list = buckets.get(key);
    if (list) list.push(cam);
    else buckets.set(key, [cam]);
  }

  const sectorStatsMap: Record<
    SectorId,
    { totalInSector: number; inActiveWindowCount: number; detectedCount: number }
  > = {
    1: { totalInSector: 0, inActiveWindowCount: 0, detectedCount: 0 },
    2: { totalInSector: 0, inActiveWindowCount: 0, detectedCount: 0 },
    3: { totalInSector: 0, inActiveWindowCount: 0, detectedCount: 0 },
    4: { totalInSector: 0, inActiveWindowCount: 0, detectedCount: 0 },
    5: { totalInSector: 0, inActiveWindowCount: 0, detectedCount: 0 },
  };

  const allEvaluatedForYear: EvaluatedCrossingEvent[] = sizeScopedRecords.map(
    ({ event: ev, areaId, areaName, parsedDate, spatialSector }) => {
      const activeSector = parsedDate.activeSector;
      const camerasPresentInEventSector = !rotational || activeSector === spatialSector;

      const gx = Math.floor(ev.lng / CELL_DEG);
      const gy = Math.floor(ev.lat / CELL_DEG);
      const prefix = rotational ? `${activeSector}` : 'all';

      let nearbyCams: PlannedCameraNode[] = [];
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const cell = buckets.get(`${prefix}:${gx + dx}:${gy + dy}`);
          if (cell) nearbyCams.push(...cell);
        }
      }
      if (nearbyCams.length === 0) {
        nearbyCams = rotational
          ? camsBySector[activeSector].filter((c) => c.cityId === areaId)
          : cameras.filter((c) => c.cityId === areaId);
        if (nearbyCams.length === 0) {
          nearbyCams = rotational ? camsBySector[activeSector] : cameras;
        }
      }

      let nearestCam = nearbyCams[0] ?? cameras[0];
      let nearestDistanceM = Infinity;
      let detectingCam: PlannedCameraNode | null = null;
      let detectingDistM = Infinity;

      for (const cam of nearbyCams) {
        const check = doesCameraDetectEvent(
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

      const secStat = sectorStatsMap[spatialSector];
      secStat.totalInSector++;
      if (camerasPresentInEventSector) secStat.inActiveWindowCount++;
      if (detected) secStat.detectedCount++;

      return {
        ...ev,
        year: parsedDate.year,
        dayOfYear: parsedDate.dayOfYear,
        cityId: areaId,
        cityName: areaName,
        activeRotationSector: activeSector,
        eventSpatialSector: spatialSector,
        camerasPresentInEventSector,
        detected,
        detectedByCameraId: detectingCam ? detectingCam.id : null,
        detectedCameraCity: detectingCam ? detectingCam.cityName : null,
        nearestCameraId: nearestCam ? nearestCam.id : 'N/A',
        nearestDistanceM: Number.isFinite(nearestDistanceM) ? Math.round(nearestDistanceM) : 0,
      };
    }
  );

  // Optionally isolate to a single inspected sector (S1..S5) when in 5-city rotational mode
  const evaluated =
    customScope || sectorFilter === 'all'
      ? allEvaluatedForYear
      : allEvaluatedForYear.filter((ev) => ev.eventSpatialSector === sectorFilter);

  let detectedCount = 0;
  let inActiveSectorEventsCount = 0;
  let outOfWindowEventsCount = 0;
  let largeTotal = 0;
  let largeDetected = 0;
  let smallTotal = 0;
  let smallDetected = 0;

  for (const ev of evaluated) {
    if (ev.detected) detectedCount++;
    if (ev.camerasPresentInEventSector) inActiveSectorEventsCount++;
    else outOfWindowEventsCount++;

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

  const bySector: SectorSimulationStat[] = SECTOR_IDS.map((sId) => {
    const st = sectorStatsMap[sId];
    return {
      sectorIndex: sId,
      shortPeriod: SECTOR_ROTATION_SCHEDULE[sId].shortPeriod,
      totalInSector: st.totalInSector,
      inActiveWindowCount: st.inActiveWindowCount,
      detectedCount: st.detectedCount,
      ratePct: st.totalInSector > 0 ? (st.detectedCount / st.totalInSector) * 100 : 0,
    };
  });

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
      inActiveSectorEventsCount,
      outOfWindowEventsCount,
      largeTotal,
      largeDetected,
      largeRatePct: largeTotal > 0 ? (largeDetected / largeTotal) * 100 : 0,
      smallTotal,
      smallDetected,
      smallRatePct: smallTotal > 0 ? (smallDetected / smallTotal) * 100 : 0,
      bySector,
    },
  };
}

/**
 * Generates a downloadable sample Excel (.xlsx) template spanning 2024–2026 across all 5 rotation windows.
 */
export function buildSampleTemplateWorkbook(): ArrayBuffer {
  const step = Math.max(1, Math.floor(DEMO_SYNTHETIC_CROSSING_TUPLES.length / 30));
  const sampleRows = [];
  for (let i = 0; i < DEMO_SYNTHETIC_CROSSING_TUPLES.length && sampleRows.length < 30; i += step) {
    const [event_id, date, latitude, longitude, animal_size] = DEMO_SYNTHETIC_CROSSING_TUPLES[i];
    sampleRows.push({
      event_id,
      date,
      latitude,
      longitude,
      animal_size,
    });
  }
  const ws = XLSX.utils.json_to_sheet(sampleRows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'animal_crossings');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

/**
 * Generates an Excel (.xlsx) report of evaluated crossing events including year & 1/5th-year sector status.
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
    city: ev.cityName,
    event_sector: `S${ev.eventSpatialSector}`,
    active_camera_sector_on_date: `S${ev.activeRotationSector} (${SECTOR_ROTATION_SCHEDULE[ev.activeRotationSector].shortPeriod})`,
    cameras_in_sector_on_date: ev.camerasPresentInEventSector ? 'YES' : 'NO',
    latitude: ev.lat,
    longitude: ev.lng,
    animal_size: ev.animalSize,
    status: ev.detected ? 'DETECTED' : 'MISSED',
    detected_by_camera: ev.detectedByCameraId ?? '',
    nearest_active_camera_id: ev.nearestCameraId,
    nearest_active_camera_distance_m: ev.nearestDistanceM,
    arrangement: arrangementLabel,
    range_m: rangeMeters,
    fov_deg: fovDeg,
  }));
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'simulation_results');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}
