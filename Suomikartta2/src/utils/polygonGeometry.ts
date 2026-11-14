export interface SimpleLatLng {
  lat: number;
  lng: number;
}

export interface PolygonBBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
  centerLat: number;
  centerLng: number;
  spanLatKm: number;
  spanLngKm: number;
  equivRadiusKm: number;
}

export function computePolygonBBox(polygon: ReadonlyArray<SimpleLatLng>): PolygonBBox {
  if (polygon.length === 0) {
    return {
      minLat: 60.2,
      maxLat: 60.2,
      minLng: 24.0,
      maxLng: 24.0,
      centerLat: 60.2,
      centerLng: 24.0,
      spanLatKm: 0,
      spanLngKm: 0,
      equivRadiusKm: 1,
    };
  }

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;

  for (const pt of polygon) {
    if (pt.lat < minLat) minLat = pt.lat;
    if (pt.lat > maxLat) maxLat = pt.lat;
    if (pt.lng < minLng) minLng = pt.lng;
    if (pt.lng > maxLng) maxLng = pt.lng;
  }

  const centerLat = (minLat + maxLat) / 2;
  const centerLng = (minLng + maxLng) / 2;
  const cosLat = Math.max(0.2, Math.cos((centerLat * Math.PI) / 180));
  const spanLatKm = (maxLat - minLat) * 111.132;
  const spanLngKm = (maxLng - minLng) * 111.32 * cosLat;
  const areaKm2 = computePolygonAreaKm2(polygon);
  const equivRadiusKm = Math.max(0.5, Math.sqrt(Math.max(0.25, areaKm2) / Math.PI));

  return {
    minLat,
    maxLat,
    minLng,
    maxLng,
    centerLat,
    centerLng,
    spanLatKm,
    spanLngKm,
    equivRadiusKm,
  };
}

/**
 * Computes the planar equirectangular shoelace area of a WGS84 polygon in square kilometers.
 */
export function computePolygonAreaKm2(polygon: ReadonlyArray<SimpleLatLng>): number {
  if (polygon.length < 3) return 0;

  let sumLat = 0;
  for (const pt of polygon) sumLat += pt.lat;
  const meanLatRad = ((sumLat / polygon.length) * Math.PI) / 180;
  const cosLat = Math.max(0.15, Math.cos(meanLatRad));
  const refLat = polygon[0].lat;
  const refLng = polygon[0].lng;

  let twiceAreaM2 = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const ax = (a.lng - refLng) * 111_320 * cosLat;
    const ay = (a.lat - refLat) * 111_132;
    const bx = (b.lng - refLng) * 111_320 * cosLat;
    const by = (b.lat - refLat) * 111_132;
    twiceAreaM2 += ax * by - bx * ay;
  }

  return Math.abs(twiceAreaM2) * 0.5 * 1e-6;
}

export function computePolygonPerimeterKm(polygon: ReadonlyArray<SimpleLatLng>): number {
  if (polygon.length < 2) return 0;
  let totalM = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    const meanLatRad = (((a.lat + b.lat) / 2) * Math.PI) / 180;
    const dx = (b.lng - a.lng) * 111_320 * Math.cos(meanLatRad);
    const dy = (b.lat - a.lat) * 111_132;
    totalM += Math.hypot(dx, dy);
  }
  return totalM / 1000;
}

/**
 * Ray-casting point-in-polygon check for { lat, lng } vertices.
 */
export function isPointInLatLngPolygon(
  lat: number,
  lng: number,
  polygon: ReadonlyArray<SimpleLatLng>
): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].lng;
    const yi = polygon[i].lat;
    const xj = polygon[j].lng;
    const yj = polygon[j].lat;

    const intersects =
      yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function perpendicularDistanceMeters(
  pt: SimpleLatLng,
  lineStart: SimpleLatLng,
  lineEnd: SimpleLatLng,
  cosLat: number
): number {
  const px = pt.lng * 111_320 * cosLat;
  const py = pt.lat * 111_132;
  const ax = lineStart.lng * 111_320 * cosLat;
  const ay = lineStart.lat * 111_132;
  const bx = lineEnd.lng * 111_320 * cosLat;
  const by = lineEnd.lat * 111_132;

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) {
    return Math.hypot(px - ax, py - ay);
  }
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function rdpSimplify(
  points: ReadonlyArray<SimpleLatLng>,
  toleranceM: number,
  cosLat: number
): SimpleLatLng[] {
  if (points.length <= 2) return [...points];

  let maxDist = 0;
  let maxIndex = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistanceMeters(points[i], first, last, cosLat);
    if (d > maxDist) {
      maxDist = d;
      maxIndex = i;
    }
  }

  if (maxDist > toleranceM) {
    const left = rdpSimplify(points.slice(0, maxIndex + 1), toleranceM, cosLat);
    const right = rdpSimplify(points.slice(maxIndex), toleranceM, cosLat);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

/**
 * Simplifies a raw freehand lasso stroke into a clean, closed polygon ring with 3..96 vertices.
 */
export function simplifyLatLngRing(
  rawPoints: ReadonlyArray<SimpleLatLng>,
  explicitToleranceM?: number
): SimpleLatLng[] {
  if (rawPoints.length < 3) return [...rawPoints];

  const bbox = computePolygonBBox(rawPoints);
  const cosLat = Math.max(0.2, Math.cos((bbox.centerLat * Math.PI) / 180));
  const perimeterM = computePolygonPerimeterKm(rawPoints) * 1000;
  const adaptiveTolM =
    explicitToleranceM ?? Math.max(8, Math.min(450, perimeterM / 180));

  // Split closed loop at farthest point from start so RDP preserves both sides of a closed lasso
  let farthestIdx = Math.floor(rawPoints.length / 2);
  let farthestDist = -1;
  for (let i = 1; i < rawPoints.length; i++) {
    const dx = (rawPoints[i].lng - rawPoints[0].lng) * 111_320 * cosLat;
    const dy = (rawPoints[i].lat - rawPoints[0].lat) * 111_132;
    const d = Math.hypot(dx, dy);
    if (d > farthestDist) {
      farthestDist = d;
      farthestIdx = i;
    }
  }

  if (farthestDist < 25) {
    return [];
  }

  const halfA = rdpSimplify(rawPoints.slice(0, farthestIdx + 1), adaptiveTolM, cosLat);
  const halfB = rdpSimplify(
    [...rawPoints.slice(farthestIdx), rawPoints[0]],
    adaptiveTolM,
    cosLat
  );

  const combined = [...halfA.slice(0, -1), ...halfB.slice(0, -1)].map((p) => ({
    lat: Number(p.lat.toFixed(5)),
    lng: Number(p.lng.toFixed(5)),
  }));

  return combined.length >= 3 ? combined : rawPoints.slice(0, 3);
}

export function recommendedZoomForPolygon(polygon: ReadonlyArray<SimpleLatLng>): number {
  const bbox = computePolygonBBox(polygon);
  const maxSpanKm = Math.max(bbox.spanLatKm, bbox.spanLngKm * 0.85);
  if (maxSpanKm <= 2.5) return 13.6;
  if (maxSpanKm <= 6) return 12.4;
  if (maxSpanKm <= 13) return 11.4;
  if (maxSpanKm <= 24) return 10.4;
  if (maxSpanKm <= 45) return 9.5;
  if (maxSpanKm <= 85) return 8.6;
  if (maxSpanKm <= 160) return 7.6;
  return 6.6;
}

export function polygonsApproximatelyEqual(
  a: ReadonlyArray<SimpleLatLng> | null | undefined,
  b: ReadonlyArray<SimpleLatLng> | null | undefined
): boolean {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      Math.abs(a[i].lat - b[i].lat) > 0.00005 ||
      Math.abs(a[i].lng - b[i].lng) > 0.00005
    ) {
      return false;
    }
  }
  return true;
}
