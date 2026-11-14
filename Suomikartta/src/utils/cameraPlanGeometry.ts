import {
  ALL_PLANNED_CAMERAS,
  TOP_5_WILDLIFE_ACCIDENT_CITIES,
  type CameraPriorityTier,
  type CityWildlifeCameraPlan,
  type PlannedCameraNode,
} from '../data/finlandWildlifePlan';
import type { LatLngPoint } from './mapMath';

export interface CameraCoverageConfig {
  rangeMeters: number;
  fovDeg: number;
  showCoverageAreas: boolean;
  showAccidentHotspots: boolean;
  showCityBoundaries: boolean;
}

export interface EnrichedPlannedCamera extends PlannedCameraNode {
  municipalityCode: number;
  primaryCorridors: string;
  historicalAccidents500m: number;
  dominantSpecies: string;
  priority: CameraPriorityTier;
}

export interface PlanSummaryMetrics {
  cityCount: number;
  cameraCount: number;
  singleCameraAreaSqM: number;
  singleCameraAreaHectares: number;
  totalCoveredAreaSqKm: number;
  totalCoveredAreaHectares: number;
  totalHistoricalAccidents: number;
  corridorAccidentsCaptured: number;
  corridorCapturePercent: number;
  tierCounts: Record<CameraPriorityTier, number>;
}

export const MIN_CAMERA_RANGE_M = 5;
export const MAX_CAMERA_RANGE_M = 100;
export const MIN_CAMERA_FOV_DEG = 10;
export const MAX_CAMERA_FOV_DEG = 360;

export const DEFAULT_COVERAGE_CONFIG: CameraCoverageConfig = {
  rangeMeters: 60,
  fovDeg: 30,
  showCoverageAreas: true,
  showAccidentHotspots: true,
  showCityBoundaries: true,
};

export const DEFAULT_CAMERA_COVERAGE_CONFIG = DEFAULT_COVERAGE_CONFIG;

export const EARTH_RADIUS_METERS = 6_371_008.8;

export function clampCoverageConfig(
  config: Partial<CameraCoverageConfig> & Pick<CameraCoverageConfig, 'rangeMeters' | 'fovDeg'>
): CameraCoverageConfig {
  const rawRange = Number.isFinite(config.rangeMeters)
    ? config.rangeMeters
    : DEFAULT_COVERAGE_CONFIG.rangeMeters;
  const rawFov = Number.isFinite(config.fovDeg)
    ? config.fovDeg
    : DEFAULT_COVERAGE_CONFIG.fovDeg;

  return {
    rangeMeters: Math.max(MIN_CAMERA_RANGE_M, Math.min(MAX_CAMERA_RANGE_M, Math.round(rawRange))),
    fovDeg: Math.max(MIN_CAMERA_FOV_DEG, Math.min(MAX_CAMERA_FOV_DEG, Math.round(rawFov))),
    showCoverageAreas: Boolean(config.showCoverageAreas ?? true),
    showAccidentHotspots: Boolean(config.showAccidentHotspots ?? true),
    showCityBoundaries: Boolean(config.showCityBoundaries ?? true),
  };
}

export function getCameraPriorityTier(rankInCity: number): CameraPriorityTier {
  if (rankInCity <= 20) return 'critical';
  if (rankInCity <= 55) return 'high';
  return 'elevated';
}

export function getDominantSpeciesLabel(cam: PlannedCameraNode): string {
  if (cam.moose >= cam.whiteTailedDeer && cam.moose >= cam.roeDeer && cam.moose > 0) {
    return 'Moose';
  }
  if (cam.roeDeer > cam.whiteTailedDeer && cam.roeDeer >= cam.moose) {
    return 'Roe deer';
  }
  return 'White-tailed deer';
}

/**
 * Returns both primary and reverse road-corridor bearings [primaryDeg, reverseDeg] for a bidirectional camera.
 * Defaults reverseDeg to `(bearingDeg + 180) % 360` when `reverseBearingDeg` is not explicitly specified.
 */
export function getCameraBearings(camera: {
  bearingDeg: number;
  reverseBearingDeg?: number;
}): [number, number] {
  const primary = ((Math.round(camera.bearingDeg) % 360) + 360) % 360;
  const rawReverse =
    typeof camera.reverseBearingDeg === 'number' && Number.isFinite(camera.reverseBearingDeg)
      ? camera.reverseBearingDeg
      : primary + 180;
  const reverse = ((Math.round(rawReverse) % 360) + 360) % 360;
  return [primary, reverse];
}

/**
 * Bidirectional camera ground area A = (min(360, 2 * fovDeg) / 360) * pi * r^2 in square meters.
 */
export function computeSingleCameraAreaM2(rangeMeters: number, fovDeg: number): number {
  const r = Math.max(0, rangeMeters);
  const singleLobeFov = Math.max(0, Math.min(360, fovDeg));
  const effectiveBidirectionalFov = Math.min(360, singleLobeFov * 2);
  return (effectiveBidirectionalFov / 360) * Math.PI * r * r;
}

export const calculateSingleCameraAreaSqMeters = computeSingleCameraAreaM2;

/**
 * Single camera covered area in hectares (1 ha = 10,000 m²).
 */
export function computeSingleCameraAreaHa(rangeMeters: number, fovDeg: number): number {
  return computeSingleCameraAreaM2(rangeMeters, fovDeg) / 10_000;
}

/**
 * Total nominal area covered across N cameras in square kilometers (1 km² = 1,000,000 m²).
 */
export function computeTotalPlanAreaKm2(
  cameraCount: number,
  rangeMeters: number,
  fovDeg: number
): number {
  const count = Math.max(0, cameraCount);
  return (count * computeSingleCameraAreaM2(rangeMeters, fovDeg)) / 1_000_000;
}

/**
 * Formats an area in square meters using readable units (m², ha, or km²) so small
 * short-range camera sectors (5–100 m) never collapse to "0.0".
 */
export function formatAreaCompact(areaSqMeters: number): string {
  const m2 = Math.max(0, areaSqMeters);
  if (m2 < 100) {
    return `${m2.toFixed(1)} m²`;
  }
  if (m2 < 10_000) {
    return `${Math.round(m2).toLocaleString('en-US')} m²`;
  }
  if (m2 < 1_000_000) {
    return `${(m2 / 10_000).toFixed(2)} ha`;
  }
  return `${(m2 / 1_000_000).toFixed(2)} km²`;
}

/**
 * Computes destination WGS84 coordinate from an origin point, ground distance (meters),
 * and compass bearing (degrees clockwise from true north).
 */
export function projectMetersOffset(
  origin: LatLngPoint,
  distanceMeters: number,
  bearingDeg: number
): LatLngPoint {
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const bearingRad = (bearingDeg * Math.PI) / 180;
  const lat1 = (origin.lat * Math.PI) / 180;
  const lng1 = (origin.lng * Math.PI) / 180;

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

export const destinationPoint = projectMetersOffset;

/**
 * Generates a closed WGS84 polygon ring representing a true ground-distance circle
 * of `radiusMeters` around `origin` (accounting for high-latitude longitude convergence in Finland).
 */
export function buildGeographicCircleRing(
  origin: LatLngPoint,
  radiusMeters: number,
  steps = 96
): LatLngPoint[] {
  const clampedRadius = Math.max(10, radiusMeters);
  const count = Math.max(24, steps);
  const ring: LatLngPoint[] = [];
  for (let i = 0; i <= count; i++) {
    const bearing = (360 * i) / count;
    ring.push(projectMetersOffset(origin, clampedRadius, bearing));
  }
  return ring;
}

/**
 * Generates a closed geographic polygon representing the ground area covered by a camera.
 * Supports directional cones (< 360°) anchored at the camera origin as well as full 360° zones.
 */
export function buildCameraCoveragePolygon(
  origin: LatLngPoint,
  bearingDeg: number,
  rangeMeters: number,
  fovDeg: number,
  arcSteps = 14
): LatLngPoint[] {
  const clampedRange = Math.max(1, rangeMeters);
  const clampedFov = Math.max(10, Math.min(360, fovDeg));
  const steps = Math.max(6, arcSteps, Math.ceil(clampedFov / 5));

  if (clampedFov >= 359.5) {
    const circleSteps = Math.max(64, steps);
    const ring: LatLngPoint[] = [];
    for (let i = 0; i <= circleSteps; i++) {
      const bearing = (360 * i) / circleSteps;
      ring.push(projectMetersOffset(origin, clampedRange, bearing));
    }
    return ring;
  }

  const halfFov = clampedFov / 2;
  const startBearing = bearingDeg - halfFov;
  const ring: LatLngPoint[] = [origin];
  for (let i = 0; i <= steps; i++) {
    const bearing = startBearing + (clampedFov * i) / steps;
    ring.push(projectMetersOffset(origin, clampedRange, bearing));
  }
  ring.push(origin);
  return ring;
}

export function computeCameraSectorPolygon(
  camera: { lat: number; lng: number; bearingDeg: number },
  rangeMeters: number,
  fovDeg: number,
  arcSteps = 14
): LatLngPoint[] {
  return buildCameraCoveragePolygon(
    { lat: camera.lat, lng: camera.lng },
    camera.bearingDeg,
    rangeMeters,
    fovDeg,
    arcSteps
  );
}

/**
 * Computes the non-overlapping ground coverage polygon(s) for a bidirectional roadside camera
 * looking along both `bearingDeg` and `reverseBearingDeg` (or `bearingDeg + 180°`).
 * Cleanly merges into a single wider sector or full 360° circle if `fovDeg` is wide enough for the lobes to overlap.
 */
export function computeCameraCoveragePolygons(
  camera: { lat: number; lng: number; bearingDeg: number; reverseBearingDeg?: number },
  rangeMeters: number,
  fovDeg: number,
  arcSteps = 14
): LatLngPoint[][] {
  const origin = { lat: camera.lat, lng: camera.lng };
  const clampedFov = Math.max(10, Math.min(360, fovDeg));
  const [b1, b2] = getCameraBearings(camera);

  const gap1 = (((b2 - b1) % 360) + 360) % 360;
  const gap2 = 360 - gap1;

  if (clampedFov >= gap1 - 0.25 && clampedFov >= gap2 - 0.25) {
    return [buildCameraCoveragePolygon(origin, b1, rangeMeters, 360, Math.max(36, arcSteps * 2))];
  }

  if (clampedFov >= gap1 - 0.25) {
    const mergedCenter = (b1 + gap1 / 2) % 360;
    const mergedSweep = Math.min(360, gap1 + clampedFov);
    return [
      buildCameraCoveragePolygon(
        origin,
        mergedCenter,
        rangeMeters,
        mergedSweep,
        Math.max(24, arcSteps * 2)
      ),
    ];
  }

  if (clampedFov >= gap2 - 0.25) {
    const mergedCenter = (b2 + gap2 / 2) % 360;
    const mergedSweep = Math.min(360, gap2 + clampedFov);
    return [
      buildCameraCoveragePolygon(
        origin,
        mergedCenter,
        rangeMeters,
        mergedSweep,
        Math.max(24, arcSteps * 2)
      ),
    ];
  }

  return [
    buildCameraCoveragePolygon(origin, b1, rangeMeters, clampedFov, arcSteps),
    buildCameraCoveragePolygon(origin, b2, rangeMeters, clampedFov, arcSteps),
  ];
}

export function getAllEnrichedCameras(
  cities: CityWildlifeCameraPlan[] = TOP_5_WILDLIFE_ACCIDENT_CITIES
): EnrichedPlannedCamera[] {
  const list: EnrichedPlannedCamera[] = [];
  for (const city of cities) {
    for (const cam of city.cameras) {
      list.push({
        ...cam,
        municipalityCode: city.code,
        primaryCorridors: city.primaryRoads,
        historicalAccidents500m: cam.historicalAccidents,
        dominantSpecies: getDominantSpeciesLabel(cam),
        priority: getCameraPriorityTier(cam.rankInCity),
      });
    }
  }
  return list;
}

export function calculatePlanSummaryMetrics(
  cities: CityWildlifeCameraPlan[],
  config: Pick<CameraCoverageConfig, 'rangeMeters' | 'fovDeg'>,
  selectedCityId: string | null
): PlanSummaryMetrics {
  const scopedCities =
    selectedCityId && selectedCityId !== 'all'
      ? cities.filter((c) => c.id === selectedCityId)
      : cities;

  let cameraCount = 0;
  let totalHistoricalAccidents = 0;
  let corridorAccidentsCaptured = 0;
  const tierCounts: Record<CameraPriorityTier, number> = {
    critical: 0,
    high: 0,
    elevated: 0,
  };

  for (const city of scopedCities) {
    cameraCount += city.cameras.length;
    totalHistoricalAccidents += city.totalAccidents;
    corridorAccidentsCaptured += city.coveredAccidents;
    for (const cam of city.cameras) {
      tierCounts[getCameraPriorityTier(cam.rankInCity)]++;
    }
  }

  const singleCameraAreaSqM = computeSingleCameraAreaM2(config.rangeMeters, config.fovDeg);
  const singleCameraAreaHectares = singleCameraAreaSqM / 10_000;
  const totalCoveredAreaSqM = singleCameraAreaSqM * cameraCount;
  const totalCoveredAreaHectares = totalCoveredAreaSqM / 10_000;
  const totalCoveredAreaSqKm = totalCoveredAreaSqM / 1_000_000;
  const corridorCapturePercent =
    totalHistoricalAccidents > 0
      ? (corridorAccidentsCaptured / totalHistoricalAccidents) * 100
      : 0;

  return {
    cityCount: scopedCities.length,
    cameraCount,
    singleCameraAreaSqM,
    singleCameraAreaHectares,
    totalCoveredAreaSqKm,
    totalCoveredAreaHectares,
    totalHistoricalAccidents,
    corridorAccidentsCaptured,
    corridorCapturePercent,
    tierCounts,
  };
}

export function filterPlannedCameras(
  allCameras: EnrichedPlannedCamera[],
  options: {
    selectedCityId: string | null;
    priorityFilter: 'all' | CameraPriorityTier;
    searchQuery: string;
  }
): EnrichedPlannedCamera[] {
  const q = options.searchQuery.trim().toLowerCase();
  return allCameras.filter((cam) => {
    if (
      options.selectedCityId &&
      options.selectedCityId !== 'all' &&
      cam.cityId !== options.selectedCityId
    ) {
      return false;
    }
    if (options.priorityFilter !== 'all' && cam.priority !== options.priorityFilter) {
      return false;
    }
    if (q) {
      const matchId = cam.id.toLowerCase().includes(q);
      const matchCity = cam.cityName.toLowerCase().includes(q);
      const matchSpecies = cam.dominantSpecies.toLowerCase().includes(q);
      const matchCorridor = cam.primaryCorridors.toLowerCase().includes(q);
      const matchRoad = cam.roadLabel.toLowerCase().includes(q);
      if (!matchId && !matchCity && !matchSpecies && !matchCorridor && !matchRoad) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Filters planned camera nodes by selected city ID ('all' or city slug) and search query.
 */
export function filterCamerasByCityAndSearch(
  allCameras: PlannedCameraNode[],
  selectedCityId: string,
  searchQuery: string
): PlannedCameraNode[] {
  const query = searchQuery.trim().toLowerCase();
  const exactUnitMatch = query.match(/^(?:#|u|unit\s*#?|h|hotspot\s*#?|c|cluster\s*#?)(\d{1,3})$/i);
  const targetIndex = exactUnitMatch ? Number(exactUnitMatch[1]) : null;

  return allCameras.filter((cam) => {
    if (selectedCityId !== 'all' && cam.cityId !== selectedCityId) {
      return false;
    }
    if (!query) {
      return true;
    }
    if (targetIndex !== null) {
      return cam.clusterSize > 1
        ? cam.clusterIndex === targetIndex
        : cam.unitNumber === targetIndex;
    }
    const species = getDominantSpeciesLabel(cam).toLowerCase();
    return (
      cam.id.toLowerCase().includes(query) ||
      cam.cityName.toLowerCase().includes(query) ||
      cam.roadLabel.toLowerCase().includes(query) ||
      cam.clusterLabel.toLowerCase().includes(query) ||
      species.includes(query)
    );
  });
}

/**
 * Formats a CSV export of planned year-round wildlife cameras (100/city, 500 total)
 * and their covered area parameters.
 */
export function buildCameraPlanCsv(
  cameras: PlannedCameraNode[],
  rangeOrConfig: number | Pick<CameraCoverageConfig, 'rangeMeters' | 'fovDeg'>,
  maybeFovDeg?: number
): string {
  const rangeMeters =
    typeof rangeOrConfig === 'number' ? rangeOrConfig : rangeOrConfig.rangeMeters;
  const fovDeg =
    typeof rangeOrConfig === 'number'
      ? (maybeFovDeg ?? DEFAULT_COVERAGE_CONFIG.fovDeg)
      : rangeOrConfig.fovDeg;

  const areaM2 = Number(computeSingleCameraAreaM2(rangeMeters, fovDeg).toFixed(1));
  const areaHa = computeSingleCameraAreaHa(rangeMeters, fovDeg).toFixed(4);
  const header = [
    'camera_id',
    'city',
    'unit_number',
    'rank_in_city',
    'cluster_index',
    'cluster_size',
    'road_corridor',
    'priority_tier',
    'latitude',
    'longitude',
    'bearing_deg',
    'reverse_bearing_deg',
    'range_m',
    'fov_deg',
    'covered_area_m2',
    'covered_area_ha',
    'historical_collisions_2021_2025',
    'white_tailed_deer',
    'roe_deer',
    'moose',
    'dominant_species',
  ].join(',');

  const rows = cameras.map((cam) => {
    const dominantSpecies = getDominantSpeciesLabel(cam);
    const tier = getCameraPriorityTier(cam.rankInCity);
    const [b1, b2] = getCameraBearings(cam);
    return [
      cam.id,
      `"${cam.cityName}"`,
      cam.unitNumber,
      cam.rankInCity,
      cam.clusterIndex,
      cam.clusterSize,
      `"${cam.roadLabel}"`,
      tier,
      cam.lat.toFixed(5),
      cam.lng.toFixed(5),
      b1,
      b2,
      rangeMeters,
      fovDeg,
      areaM2,
      areaHa,
      cam.historicalAccidents,
      cam.whiteTailedDeer,
      cam.roeDeer,
      cam.moose,
      `"${dominantSpecies}"`,
    ].join(',');
  });

  return [header, ...rows].join('\n');
}

/**
 * Ensures all 5 cities and their 100 cameras/city remain rendered on the map regardless
 * of which camera or city is selected in the sidebar.
 */
export function resolveMapVisiblePlan(
  _selectedCityId: string,
  _selectedCameraId: string | null,
  sourceCameras: PlannedCameraNode[] = ALL_PLANNED_CAMERAS
): {
  cities: CityWildlifeCameraPlan[];
  cameras: PlannedCameraNode[];
} {
  return {
    cities: TOP_5_WILDLIFE_ACCIDENT_CITIES,
    cameras: sourceCameras,
  };
}

/**
 * Preserves the broader overview when choosing a camera so other cities
 * are never filtered out upon camera selection.
 */
export function resolveCityIdOnCameraSelect(
  currentCityId: string,
  camera: PlannedCameraNode | null
): string {
  if (!camera) {
    return currentCityId;
  }
  if (currentCityId === 'all' || currentCityId === camera.cityId) {
    return currentCityId;
  }
  return 'all';
}
