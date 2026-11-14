export type BaseMapMode = 'base' | 'satellite';

export type GoogleMapTypeId = 'roadmap' | 'terrain' | 'satellite' | 'hybrid';

export interface LatLngPoint {
  lat: number;
  lng: number;
}

export interface CameraState {
  center: LatLngPoint;
  zoom: number;
}

export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface RegionPreset {
  id: string;
  name: string;
  shortLabel: string;
  summary: string;
  center: LatLngPoint;
  zoom: number;
}

export interface ScaleBarSpec {
  label: string;
  distanceMeters: number;
  pixelWidth: number;
}

export interface CoordinateValidationResult {
  valid: boolean;
  error?: string;
  point?: LatLngPoint;
}

export const MIN_ZOOM = 5.3;
export const MAX_ZOOM = 18;
export const ZOOM_STEP = 1;
export const TILE_SIZE = 256;

export const FINLAND_GEOGRAPHIC_BOUNDS = {
  north: 70.1,
  south: 59.45,
  west: 19.0,
  east: 31.6,
} as const;

export const FINLAND_VIEWPORT_BOUNDS = {
  north: 70.35,
  south: 59.3,
  west: 18.75,
  east: 31.95,
} as const;

export const DEFAULT_FINLAND_CAMERA: CameraState = {
  center: { lat: 65.31, lng: 25.3 },
  zoom: 5.3,
};

export const FINLAND_REGIONS: RegionPreset[] = [
  {
    id: 'overview',
    name: 'Full Finland Overview',
    shortLabel: 'Overview',
    summary: '60°N to 70°N national extent from Baltic coast to Lapland',
    center: { lat: 65.31, lng: 25.3 },
    zoom: 5.3,
  },
  {
    id: 'southern-coast',
    name: 'Southern Coast & Gulf',
    shortLabel: 'South Coast',
    summary: 'Uusimaa coastal peninsula and Gulf of Finland',
    center: { lat: 60.17, lng: 24.94 },
    zoom: 10.5,
  },
  {
    id: 'archipelago',
    name: 'Southwest & Archipelago Sea',
    shortLabel: 'Archipelago',
    summary: 'Turku coast, Satakunta, and outer Baltic island chains',
    center: { lat: 60.45, lng: 21.65 },
    zoom: 8.8,
  },
  {
    id: 'lakeland',
    name: 'Finnish Lakeland Basin',
    shortLabel: 'Lakeland',
    summary: 'Glacial lake labyrinth across Saimaa and Päijänne',
    center: { lat: 61.85, lng: 28.15 },
    zoom: 8.0,
  },
  {
    id: 'lapland',
    name: 'Arctic Circle & Lapland',
    shortLabel: 'Lapland',
    summary: '66°33′N Arctic Circle, boreal fells, and Lake Inari basin',
    center: { lat: 66.55, lng: 25.85 },
    zoom: 7.0,
  },
];

export const ZOOM_PRESETS: Array<{ label: string; zoom: number }> = [
  { label: 'Country · 5.3x', zoom: 5.3 },
  { label: 'Region · 8.0x', zoom: 8.0 },
  { label: 'City · 11.5x', zoom: 11.5 },
  { label: 'Street · 15.0x', zoom: 15.0 },
];

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) {
    return DEFAULT_FINLAND_CAMERA.zoom;
  }
  const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
  return Math.round(clamped * 100) / 100;
}

export function latLngToWorldPixel(point: LatLngPoint, zoom: number): { x: number; y: number } {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const clampedLat = Math.max(-85.05112878, Math.min(85.05112878, point.lat));
  const sinLat = Math.sin((clampedLat * Math.PI) / 180);

  const x = ((point.lng + 180) / 360) * scale;
  const y = (0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI)) * scale;

  return { x, y };
}

export function worldPixelToLatLng(pixel: { x: number; y: number }, zoom: number): LatLngPoint {
  const scale = TILE_SIZE * Math.pow(2, zoom);
  const lng = (pixel.x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * pixel.y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));

  return { lat, lng };
}

export function isPointWithinFinlandBounds(point: LatLngPoint): boolean {
  return (
    point.lat >= FINLAND_GEOGRAPHIC_BOUNDS.south &&
    point.lat <= FINLAND_GEOGRAPHIC_BOUNDS.north &&
    point.lng >= FINLAND_GEOGRAPHIC_BOUNDS.west &&
    point.lng <= FINLAND_GEOGRAPHIC_BOUNDS.east
  );
}

export function clampCamera(camera: CameraState, viewport?: ViewportDimensions): CameraState {
  const zoom = clampZoom(camera.zoom);

  let rawLat = Number.isFinite(camera.center.lat)
    ? camera.center.lat
    : DEFAULT_FINLAND_CAMERA.center.lat;
  let rawLng = Number.isFinite(camera.center.lng)
    ? camera.center.lng
    : DEFAULT_FINLAND_CAMERA.center.lng;

  if (viewport && viewport.width > 0 && viewport.height > 0) {
    const nw = latLngToWorldPixel(
      { lat: FINLAND_VIEWPORT_BOUNDS.north, lng: FINLAND_VIEWPORT_BOUNDS.west },
      zoom
    );
    const se = latLngToWorldPixel(
      { lat: FINLAND_VIEWPORT_BOUNDS.south, lng: FINLAND_VIEWPORT_BOUNDS.east },
      zoom
    );
    const currentPx = latLngToWorldPixel({ lat: rawLat, lng: rawLng }, zoom);

    const boundsWidth = se.x - nw.x;
    const boundsHeight = se.y - nw.y;

    const clampedX =
      boundsWidth <= viewport.width
        ? (nw.x + se.x) / 2
        : Math.min(se.x - viewport.width / 2, Math.max(nw.x + viewport.width / 2, currentPx.x));

    const clampedY =
      boundsHeight <= viewport.height
        ? (nw.y + se.y) / 2
        : Math.min(se.y - viewport.height / 2, Math.max(nw.y + viewport.height / 2, currentPx.y));

    const projected = worldPixelToLatLng({ x: clampedX, y: clampedY }, zoom);
    rawLat = projected.lat;
    rawLng = projected.lng;
  }

  const lat = Math.min(
    FINLAND_GEOGRAPHIC_BOUNDS.north,
    Math.max(FINLAND_GEOGRAPHIC_BOUNDS.south, rawLat)
  );
  const lng = Math.min(
    FINLAND_GEOGRAPHIC_BOUNDS.east,
    Math.max(FINLAND_GEOGRAPHIC_BOUNDS.west, rawLng)
  );

  return {
    center: {
      lat: Math.round(lat * 1_000_000) / 1_000_000,
      lng: Math.round(lng * 1_000_000) / 1_000_000,
    },
    zoom,
  };
}

export function resolveGoogleMapTypeId(
  mode: BaseMapMode,
  options: { showLabels: boolean; showTerrain: boolean }
): GoogleMapTypeId {
  if (mode === 'satellite') {
    return options.showLabels ? 'hybrid' : 'satellite';
  }
  return options.showTerrain ? 'terrain' : 'roadmap';
}

export function zoomAroundScreenPoint(
  camera: CameraState,
  targetZoom: number,
  cursorOffsetFromCenter: { dx: number; dy: number },
  viewport?: ViewportDimensions
): CameraState {
  const nextZoom = clampZoom(targetZoom);
  if (nextZoom === camera.zoom) {
    return clampCamera(camera, viewport);
  }

  const centerWorldBefore = latLngToWorldPixel(camera.center, camera.zoom);
  const cursorWorldBefore = {
    x: centerWorldBefore.x + cursorOffsetFromCenter.dx,
    y: centerWorldBefore.y + cursorOffsetFromCenter.dy,
  };
  const anchorLatLng = worldPixelToLatLng(cursorWorldBefore, camera.zoom);
  const anchorWorldAfter = latLngToWorldPixel(anchorLatLng, nextZoom);
  const nextCenterWorld = {
    x: anchorWorldAfter.x - cursorOffsetFromCenter.dx,
    y: anchorWorldAfter.y - cursorOffsetFromCenter.dy,
  };

  return clampCamera(
    {
      center: worldPixelToLatLng(nextCenterWorld, nextZoom),
      zoom: nextZoom,
    },
    viewport
  );
}

export function calculateGroundResolutionMetersPerPixel(lat: number, zoom: number): number {
  const earthCircumferenceMeters = 40_075_016.686;
  const cosLat = Math.cos((Math.max(-85, Math.min(85, lat)) * Math.PI) / 180);
  return (earthCircumferenceMeters * cosLat) / (TILE_SIZE * Math.pow(2, zoom));
}

const NICE_SCALE_DISTANCES_METERS = [
  20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000, 50_000, 100_000, 200_000, 500_000,
];

export function calculateScaleBar(lat: number, zoom: number, maxPixelWidth = 120): ScaleBarSpec {
  const metersPerPixel = calculateGroundResolutionMetersPerPixel(lat, zoom);
  const maxMeters = metersPerPixel * maxPixelWidth;

  let chosen = NICE_SCALE_DISTANCES_METERS[0];
  for (const candidate of NICE_SCALE_DISTANCES_METERS) {
    if (candidate <= maxMeters) {
      chosen = candidate;
    } else {
      break;
    }
  }

  const pixelWidth = Math.max(28, Math.round(chosen / metersPerPixel));
  const label = chosen >= 1_000 ? `${chosen / 1_000} km` : `${chosen} m`;

  return {
    label,
    distanceMeters: chosen,
    pixelWidth,
  };
}

export function formatLat(lat: number): string {
  const abs = Math.abs(lat).toFixed(4);
  const hemisphere = lat >= 0 ? 'N' : 'S';
  return `${abs}° ${hemisphere}`;
}

export function formatLng(lng: number): string {
  const abs = Math.abs(lng).toFixed(4);
  const hemisphere = lng >= 0 ? 'E' : 'W';
  return `${abs}° ${hemisphere}`;
}

export function validateCoordinateInput(latRaw: string, lngRaw: string): CoordinateValidationResult {
  const trimmedLat = latRaw.trim();
  const trimmedLng = lngRaw.trim();

  if (!trimmedLat || !trimmedLng) {
    return {
      valid: false,
      error: 'Enter both latitude and longitude values.',
    };
  }

  const lat = Number(trimmedLat);
  const lng = Number(trimmedLng);

  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return {
      valid: false,
      error: 'Coordinates must be valid decimal numbers.',
    };
  }

  if (
    lat < FINLAND_GEOGRAPHIC_BOUNDS.south ||
    lat > FINLAND_GEOGRAPHIC_BOUNDS.north ||
    lng < FINLAND_GEOGRAPHIC_BOUNDS.west ||
    lng > FINLAND_GEOGRAPHIC_BOUNDS.east
  ) {
    return {
      valid: false,
      error: `Enter coordinates within Finland (${FINLAND_GEOGRAPHIC_BOUNDS.south}°N–${FINLAND_GEOGRAPHIC_BOUNDS.north}°N, ${FINLAND_GEOGRAPHIC_BOUNDS.west}°E–${FINLAND_GEOGRAPHIC_BOUNDS.east}°E).`,
    };
  }

  return {
    valid: true,
    point: { lat, lng },
  };
}
