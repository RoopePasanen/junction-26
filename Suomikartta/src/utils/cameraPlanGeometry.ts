import {
  ALL_PLANNED_CAMERAS,
  SECTOR_ROTATION_SCHEDULE,
  TOP_5_WILDLIFE_ACCIDENT_CITIES,
  type CameraPriorityTier,
  type CityWildlifeCameraPlan,
  type PlannedCameraNode,
  type SectorFilter,
  type SectorId,
} from '../data/finlandWildlifePlan';
import type { LatLngPoint } from './mapMath';

export interface CameraCoverageConfig {
  rangeMeters: number;
  fovDeg: number;
  showDeploymentSectors: boolean;
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

export interface SectorVisualStyle {
  sectorIndex: SectorId;
  shortCode: string;
  shortPeriod: string;
  hex: string;
  fillBase: string;
  fillActiveBase: string;
  fillSat: string;
  fillActiveSat: string;
  strokeBase: string;
  strokeSat: string;
  dotBase: string;
  dotSat: string;
}

export const SECTOR_PALETTE: Record<SectorId, SectorVisualStyle> = {
  1: {
    sectorIndex: 1,
    shortCode: 'S1',
    shortPeriod: SECTOR_ROTATION_SCHEDULE[1].shortPeriod,
    hex: '#0369a1',
    fillBase: 'rgba(3, 105, 161, 0.10)',
    fillActiveBase: 'rgba(3, 105, 161, 0.20)',
    fillSat: 'rgba(56, 189, 248, 0.14)',
    fillActiveSat: 'rgba(56, 189, 248, 0.26)',
    strokeBase: 'rgba(3, 105, 161, 0.78)',
    strokeSat: 'rgba(125, 211, 252, 0.88)',
    dotBase: '#0369a1',
    dotSat: '#38bdf8',
  },
  2: {
    sectorIndex: 2,
    shortCode: 'S2',
    shortPeriod: SECTOR_ROTATION_SCHEDULE[2].shortPeriod,
    hex: '#0f766e',
    fillBase: 'rgba(15, 118, 110, 0.10)',
    fillActiveBase: 'rgba(15, 118, 110, 0.20)',
    fillSat: 'rgba(45, 212, 191, 0.14)',
    fillActiveSat: 'rgba(45, 212, 191, 0.26)',
    strokeBase: 'rgba(15, 118, 110, 0.78)',
    strokeSat: 'rgba(94, 234, 212, 0.88)',
    dotBase: '#0f766e',
    dotSat: '#2dd4bf',
  },
  3: {
    sectorIndex: 3,
    shortCode: 'S3',
    shortPeriod: SECTOR_ROTATION_SCHEDULE[3].shortPeriod,
    hex: '#b45309',
    fillBase: 'rgba(180, 83, 9, 0.10)',
    fillActiveBase: 'rgba(180, 83, 9, 0.20)',
    fillSat: 'rgba(251, 191, 36, 0.14)',
    fillActiveSat: 'rgba(251, 191, 36, 0.26)',
    strokeBase: 'rgba(180, 83, 9, 0.78)',
    strokeSat: 'rgba(253, 224, 71, 0.88)',
    dotBase: '#b45309',
    dotSat: '#fbbf24',
  },
  4: {
    sectorIndex: 4,
    shortCode: 'S4',
    shortPeriod: SECTOR_ROTATION_SCHEDULE[4].shortPeriod,
    hex: '#c2410c',
    fillBase: 'rgba(194, 65, 12, 0.10)',
    fillActiveBase: 'rgba(194, 65, 12, 0.20)',
    fillSat: 'rgba(251, 146, 60, 0.14)',
    fillActiveSat: 'rgba(251, 146, 60, 0.26)',
    strokeBase: 'rgba(194, 65, 12, 0.78)',
    strokeSat: 'rgba(253, 186, 116, 0.88)',
    dotBase: '#c2410c',
    dotSat: '#fb923c',
  },
  5: {
    sectorIndex: 5,
    shortCode: 'S5',
    shortPeriod: SECTOR_ROTATION_SCHEDULE[5].shortPeriod,
    hex: '#3730a3',
    fillBase: 'rgba(55, 48, 163, 0.10)',
    fillActiveBase: 'rgba(55, 48, 163, 0.20)',
    fillSat: 'rgba(129, 140, 248, 0.14)',
    fillActiveSat: 'rgba(129, 140, 248, 0.26)',
    strokeBase: 'rgba(55, 48, 163, 0.78)',
    strokeSat: 'rgba(165, 180, 252, 0.88)',
    dotBase: '#3730a3',
    dotSat: '#818cf8',
  },
};

export const MIN_CAMERA_RANGE_M = 5;
export const MAX_CAMERA_RANGE_M = 100;
export const MIN_CAMERA_FOV_DEG = 35;
export const MAX_CAMERA_FOV_DEG = 360;

export const DEFAULT_COVERAGE_CONFIG: CameraCoverageConfig = {
  rangeMeters: 50,
  fovDeg: 65,
  showDeploymentSectors: true,
  showCoverageAreas: true,
  showAccidentHotspots: true,
  showCityBoundaries: true,
};

export const DEFAULT_CAMERA_COVERAGE_CONFIG = DEFAULT_COVERAGE_CONFIG;

const EARTH_RADIUS_METERS = 6_371_008.8;

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
    showDeploymentSectors: config.showDeploymentSectors ?? true,
    showCoverageAreas: Boolean(config.showCoverageAreas ?? true),
    showAccidentHotspots: Boolean(config.showAccidentHotspots ?? true),
    showCityBoundaries: Boolean(config.showCityBoundaries ?? true),
  };
}

export function getCameraPriorityTier(rankInSector: number): CameraPriorityTier {
  if (rankInSector <= 20) return 'critical';
  if (rankInSector <= 55) return 'high';
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
 * Circular sector area A = (fovDeg / 360) * pi * r^2 in square meters.
 */
export function computeSingleCameraAreaM2(rangeMeters: number, fovDeg: number): number {
  const r = Math.max(0, rangeMeters);
  const fov = Math.max(0, Math.min(360, fovDeg));
  return (fov / 360) * Math.PI * r * r;
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
 * Supports directional sectors (< 360°) anchored at the camera origin as well as full 360° zones.
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
  const steps = Math.max(6, arcSteps);

  if (clampedFov >= 359.5) {
    const circleSteps = Math.max(18, steps * 2);
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
        priority: getCameraPriorityTier(cam.rankInSector),
      });
    }
  }
  return list;
}

export function calculatePlanSummaryMetrics(
  cities: CityWildlifeCameraPlan[],
  config: Pick<CameraCoverageConfig, 'rangeMeters' | 'fovDeg'>,
  selectedCityId: string | null,
  selectedSector: SectorFilter = 'all'
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
    const cityCams =
      selectedSector === 'all'
        ? city.cameras
        : city.cameras.filter((c) => c.sectorIndex === selectedSector);
    cameraCount += cityCams.length;
    totalHistoricalAccidents += city.totalAccidents;
    if (selectedSector === 'all') {
      corridorAccidentsCaptured += city.coveredAccidents;
    } else {
      const secMeta = city.sectors.find((s) => s.sectorIndex === selectedSector);
      corridorAccidentsCaptured += secMeta ? secMeta.historicalAccidents : 0;
    }
    for (const cam of cityCams) {
      tierCounts[getCameraPriorityTier(cam.rankInSector)]++;
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
    selectedSector?: SectorFilter;
    priorityFilter: 'all' | CameraPriorityTier;
    searchQuery: string;
  }
): EnrichedPlannedCamera[] {
  const q = options.searchQuery.trim().toLowerCase();
  const sectorFilter = options.selectedSector ?? 'all';
  return allCameras.filter((cam) => {
    if (
      options.selectedCityId &&
      options.selectedCityId !== 'all' &&
      cam.cityId !== options.selectedCityId
    ) {
      return false;
    }
    if (sectorFilter !== 'all' && cam.sectorIndex !== sectorFilter) {
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
      const matchSector = cam.sectorName.toLowerCase().includes(q);
      if (!matchId && !matchCity && !matchSpecies && !matchCorridor && !matchSector) {
        return false;
      }
    }
    return true;
  });
}

/**
 * Filters planned camera nodes by selected city ID ('all' or city slug), optional sector
 * ('all' or 1..5), and search query.
 */
export function filterCamerasByCityAndSearch(
  allCameras: PlannedCameraNode[],
  selectedCityId: string,
  searchQuery: string,
  selectedSector: SectorFilter = 'all'
): PlannedCameraNode[] {
  const query = searchQuery.trim().toLowerCase();
  const sectorQueryMatch = query.match(/^(?:s|sec|sector\s*)([1-5])$/i);
  const targetQuerySector = sectorQueryMatch ? (Number(sectorQueryMatch[1]) as SectorId) : null;

  const exactUnitMatch = query.match(/^(?:#|u|unit\s*#?|h|hotspot\s*#?|c|cluster\s*#?)(\d{1,3})$/i);
  const targetIndex = exactUnitMatch ? Number(exactUnitMatch[1]) : null;

  return allCameras.filter((cam) => {
    if (selectedCityId !== 'all' && cam.cityId !== selectedCityId) {
      return false;
    }
    if (selectedSector !== 'all' && cam.sectorIndex !== selectedSector) {
      return false;
    }
    if (!query) {
      return true;
    }
    if (targetQuerySector !== null) {
      return cam.sectorIndex === targetQuerySector;
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
      cam.sectorName.toLowerCase().includes(query) ||
      cam.sectorPeriod.toLowerCase().includes(query) ||
      cam.clusterLabel.toLowerCase().includes(query) ||
      species.includes(query)
    );
  });
}

/**
 * Formats a CSV export of planned wildlife cameras, their 1/5th-year sector schedule,
 * and covered area parameters.
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
    'sector_index',
    'sector_name',
    'rotation_period',
    'unit_number',
    'cluster_index',
    'cluster_size',
    'road_corridor',
    'rank_in_sector',
    'rank_in_city',
    'priority_tier',
    'latitude',
    'longitude',
    'bearing_deg',
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
    const tier = getCameraPriorityTier(cam.rankInSector);
    return [
      cam.id,
      `"${cam.cityName}"`,
      cam.sectorIndex,
      `"${cam.sectorName}"`,
      `"${cam.sectorPeriod}"`,
      cam.unitNumber,
      cam.clusterIndex,
      cam.clusterSize,
      `"${cam.roadLabel}"`,
      cam.rankInSector,
      cam.rankInCity,
      tier,
      cam.lat.toFixed(5),
      cam.lng.toFixed(5),
      cam.bearingDeg,
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
 * Ensures all 5 cities and their deployment sectors remain rendered on the map regardless
 * of which camera or city is selected, while allowing inspection of an individual rotation
 * sector (S1–S5) across the 5 municipalities.
 */
export function resolveMapVisiblePlan(
  _selectedCityId: string,
  _selectedCameraId: string | null,
  selectedSector: SectorFilter = 'all',
  sourceCameras: PlannedCameraNode[] = ALL_PLANNED_CAMERAS
): {
  cities: CityWildlifeCameraPlan[];
  cameras: PlannedCameraNode[];
} {
  return {
    cities: TOP_5_WILDLIFE_ACCIDENT_CITIES,
    cameras:
      selectedSector === 'all'
        ? sourceCameras
        : sourceCameras.filter((c) => c.sectorIndex === selectedSector),
  };
}

/**
 * Preserves the broader overview when choosing a camera so other city sectors
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
