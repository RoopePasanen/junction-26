/**
 * Live Ramboll collision fetcher (the original SuomiKartta planner path).
 *
 * The newer planner reads a pre-downloaded nationwide dataset from
 * src/server/data/rambollFinlandAccidents.bin. When that file is not present,
 * rambollLocalStore.ts falls back to this module and fetches the vector tiles
 * for the requested area straight from mobilityanalytics.ramboll.com.
 * scripts/build-customer-sites.mts also uses it directly.
 */

const RAMBOLL_TILE_BASE_URL =
  'https://mobilityanalytics.ramboll.com/onn/hirvielain/data/tiles';

const EARTH_RADIUS_M = 6_371_008.8;

export interface DecodedRambollAccident {
  lat: number;
  lng: number;
  speciesClass: number; // 1=moose, 2=fallowDeer, 3=roeDeer, 4=forestReindeer, 5=whiteTailedDeer
  year: number;
  month: number;
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
