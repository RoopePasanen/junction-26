import type { PlannedCameraNode, SpeciesCollisionBreakdown } from '../data/finlandWildlifePlan.ts';

export type PlanScopeMode = 'top5' | 'custom';

export interface CustomAreaRequestParams {
  lat: number;
  lng: number;
  radiusKm: number;
  label?: string;
}

export interface CustomAreaPlanResult {
  id: string;
  label: string;
  center: { lat: number; lng: number };
  radiusKm: number;
  areaKm2: number;
  roadNetworkKm: number;
  targetCameraCount: number;
  dataSourceUrl: string;
  dataPeriod: string;
  totalAccidentsInRadius: number;
  corridorAccidentsNearCameras: number;
  speciesTotals: SpeciesCollisionBreakdown;
  byYear: Record<string, number>;
  primaryRoads: string;
  /** Aggregated 2021–2025 Ramboll collision cells inside circle as [lng, lat, count] */
  hotspots: Array<[number, number, number]>;
  /** Up to 100 road-snapped cameras pointing strictly along the physical road */
  cameras: PlannedCameraNode[];
}

export interface CustomLocationPreset {
  id: string;
  name: string;
  region: string;
  lat: number;
  lng: number;
  defaultRadiusKm: number;
}

export const MIN_CUSTOM_RADIUS_KM = 2;
export const MAX_CUSTOM_RADIUS_KM = 50;
export const DEFAULT_CUSTOM_RADIUS_KM = 15;

export const CUSTOM_FINLAND_LOCATION_PRESETS: readonly CustomLocationPreset[] = [
  { id: 'lohja', name: 'Lohja', region: 'Uusimaa', lat: 60.2486, lng: 24.0653, defaultRadiusKm: 14 },
  { id: 'tampere', name: 'Tampere', region: 'Pirkanmaa', lat: 61.4978, lng: 23.7610, defaultRadiusKm: 16 },
  { id: 'porvoo', name: 'Porvoo', region: 'Uusimaa', lat: 60.3923, lng: 25.6651, defaultRadiusKm: 15 },
  { id: 'kouvola', name: 'Kouvola', region: 'Kymenlaakso', lat: 60.8679, lng: 26.7042, defaultRadiusKm: 18 },
  { id: 'lahti', name: 'Lahti', region: 'Päijät-Häme', lat: 60.9827, lng: 25.6612, defaultRadiusKm: 15 },
  { id: 'turku', name: 'Turku', region: 'Varsinais-Suomi', lat: 60.4518, lng: 22.2666, defaultRadiusKm: 15 },
  { id: 'jyvaskyla', name: 'Jyväskylä', region: 'Central Finland', lat: 62.2426, lng: 25.7473, defaultRadiusKm: 16 },
  { id: 'seinajoki', name: 'Seinäjoki', region: 'South Ostrobothnia', lat: 62.7903, lng: 22.8403, defaultRadiusKm: 16 },
  { id: 'mikkeli', name: 'Mikkeli', region: 'South Savo', lat: 61.6887, lng: 27.2721, defaultRadiusKm: 16 },
  { id: 'kuopio', name: 'Kuopio', region: 'North Savo', lat: 62.8924, lng: 27.6770, defaultRadiusKm: 16 },
  { id: 'joensuu', name: 'Joensuu', region: 'North Karelia', lat: 62.6010, lng: 29.7636, defaultRadiusKm: 16 },
  { id: 'oulu', name: 'Oulu', region: 'North Ostrobothnia', lat: 65.0121, lng: 25.4651, defaultRadiusKm: 18 },
  { id: 'rovaniemi', name: 'Rovaniemi', region: 'Lapland', lat: 66.5039, lng: 25.7294, defaultRadiusKm: 20 },
] as const;

export function recommendedZoomForRadiusKm(radiusKm: number): number {
  if (radiusKm <= 3) return 12.6;
  if (radiusKm <= 6) return 11.6;
  if (radiusKm <= 10) return 10.8;
  if (radiusKm <= 16) return 10.1;
  if (radiusKm <= 25) return 9.4;
  if (radiusKm <= 36) return 8.9;
  return 8.4;
}
