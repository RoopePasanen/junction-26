import React, { useCallback, useEffect, useRef } from 'react';
import {
  ARCTIC_CIRCLE_LAT,
  FINLAND_TERRITORIAL_MASK_RING,
  FINLAND_VECTOR_FEATURES,
  NATURAL_MAP_LABELS,
} from '../data/finlandGeo';
import type { PlannedCameraNode } from '../data/finlandWildlifePlan';
import {
  buildGeographicCircleRing,
  computeCameraCoveragePolygons,
  destinationPoint,
  getCameraBearings,
  getCameraPriorityTier,
  type CameraCoverageConfig,
} from '../utils/cameraPlanGeometry';
import {
  SMALL_ANIMAL_RANGE_FACTOR,
  type EvaluatedCrossingEvent,
  type SimulatorConfig,
} from '../utils/crossingSimulator';
import type {
  CustomAreaPlanResult,
  DrawingToolMode,
} from '../types/customAreaPlan';
import {
  isPointInLatLngPolygon,
  polygonsApproximatelyEqual,
  simplifyLatLngRing,
} from '../utils/polygonGeometry';
import {
  calculateGroundResolutionMetersPerPixel,
  clampCamera,
  FINLAND_GEOGRAPHIC_BOUNDS,
  isPointWithinFinlandBounds,
  latLngToWorldPixel,
  TILE_SIZE,
  worldPixelToLatLng,
  zoomAroundScreenPoint,
  ZOOM_STEP,
  type BaseMapMode,
  type CameraState,
  type GoogleMapTypeId,
  type LatLngPoint,
} from '../utils/mapMath';

interface CanvasFinlandMapProps {
  camera: CameraState;
  mode: BaseMapMode;
  mapTypeId: GoogleMapTypeId;
  showLabels: boolean;
  showTerrain: boolean;
  showGraticule: boolean;
  areasOfInterest: CustomAreaPlanResult[];
  selectedAreaId: string | null;
  selectedCameraId: string | null;
  coverageConfig: CameraCoverageConfig;
  visibleCameras: PlannedCameraNode[];
  evaluatedEvents: EvaluatedCrossingEvent[];
  simulatorConfig: SimulatorConfig;
  selectedCrossingEventId: string | null;
  drawingMode?: DrawingToolMode;
  drawnPolygon?: LatLngPoint[];
  draftPolygonVertices?: LatLngPoint[];
  onCameraChange: (next: CameraState) => void;
  onCursorMove: (point: LatLngPoint | null) => void;
  onSelectCamera: (camera: PlannedCameraNode | null) => void;
  onSelectArea: (area: CustomAreaPlanResult) => void;
  onSelectCrossingEvent: (event: EvaluatedCrossingEvent) => void;
  onCompletePolygon?: (polygon: LatLngPoint[]) => void;
  onAddDraftVertex?: (point: LatLngPoint) => void;
}

interface TileRecord {
  img: HTMLImageElement;
  status: 'loading' | 'loaded' | 'error';
}

const MAX_CACHE_ENTRIES = 420;

function getTileUrl(
  layer: 'base' | 'terrain' | 'satellite' | 'labels',
  z: number,
  x: number,
  y: number
): string {
  switch (layer) {
    case 'satellite':
      return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
    case 'labels':
      return `https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${z}/${y}/${x}`;
    case 'terrain':
      return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/${z}/${y}/${x}`;
    case 'base':
    default:
      return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/${z}/${y}/${x}`;
  }
}

export function CanvasFinlandMap({
  camera,
  mode,
  mapTypeId,
  showLabels,
  showTerrain,
  showGraticule,
  areasOfInterest,
  selectedAreaId,
  selectedCameraId,
  coverageConfig,
  visibleCameras,
  evaluatedEvents,
  simulatorConfig,
  selectedCrossingEventId,
  drawingMode = 'none',
  drawnPolygon = [],
  draftPolygonVertices = [],
  onCameraChange,
  onCursorMove,
  onSelectCamera,
  onSelectArea,
  onSelectCrossingEvent,
  onCompletePolygon,
  onAddDraftVertex,
}: CanvasFinlandMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tileCacheRef = useRef<Record<string, TileRecord>>({});
  const tileKeysOrderRef = useRef<string[]>([]);
  const heatKernelCacheRef = useRef<Record<string, HTMLCanvasElement>>({});
  const rafIdRef = useRef<number | null>(null);

  const cameraRef = useRef<CameraState>(camera);
  cameraRef.current = camera;

  const areasOfInterestRef = useRef<CustomAreaPlanResult[]>(areasOfInterest);
  areasOfInterestRef.current = areasOfInterest;

  const drawingModeRef = useRef<DrawingToolMode>(drawingMode);
  drawingModeRef.current = drawingMode;

  const draftPolygonVerticesRef = useRef<LatLngPoint[]>(draftPolygonVertices);
  draftPolygonVerticesRef.current = draftPolygonVertices;

  const onCompletePolygonRef = useRef(onCompletePolygon);
  onCompletePolygonRef.current = onCompletePolygon;

  const onAddDraftVertexRef = useRef(onAddDraftVertex);
  onAddDraftVertexRef.current = onAddDraftVertex;

  const onSelectAreaRef = useRef(onSelectArea);
  onSelectAreaRef.current = onSelectArea;

  const freehandStrokeRef = useRef<LatLngPoint[]>([]);
  const freehandLastScreenRef = useRef<{ x: number; y: number } | null>(null);
  const cursorLatLngRef = useRef<LatLngPoint | null>(null);

  const visibleCamerasRef = useRef<PlannedCameraNode[]>(visibleCameras);
  visibleCamerasRef.current = visibleCameras;

  const evaluatedEventsRef = useRef<EvaluatedCrossingEvent[]>(evaluatedEvents);
  evaluatedEventsRef.current = evaluatedEvents;

  const simulatorConfigRef = useRef<SimulatorConfig>(simulatorConfig);
  simulatorConfigRef.current = simulatorConfig;

  const onCameraChangeRef = useRef(onCameraChange);
  onCameraChangeRef.current = onCameraChange;

  const getHeatmapKernel = useCallback(
    (kind: 'detected' | 'missed', satellite: boolean): HTMLCanvasElement => {
      const key = `${kind}:${satellite ? 'sat' : 'base'}`;
      const existing = heatKernelCacheRef.current[key];
      if (existing) {
        return existing;
      }
      const size = 72;
      const half = size / 2;
      const offscreen = document.createElement('canvas');
      offscreen.width = size;
      offscreen.height = size;
      const kctx = offscreen.getContext('2d');
      if (kctx) {
        const grad = kctx.createRadialGradient(half, half, 0, half, half, half);
        if (kind === 'detected') {
          if (satellite) {
            grad.addColorStop(0, 'rgba(52, 211, 153, 0.66)');
            grad.addColorStop(0.35, 'rgba(16, 185, 129, 0.38)');
            grad.addColorStop(0.7, 'rgba(5, 150, 105, 0.14)');
            grad.addColorStop(1, 'rgba(5, 150, 105, 0)');
          } else {
            grad.addColorStop(0, 'rgba(4, 120, 87, 0.54)');
            grad.addColorStop(0.34, 'rgba(16, 185, 129, 0.32)');
            grad.addColorStop(0.68, 'rgba(52, 211, 153, 0.12)');
            grad.addColorStop(1, 'rgba(16, 185, 129, 0)');
          }
        } else if (satellite) {
          grad.addColorStop(0, 'rgba(251, 113, 133, 0.64)');
          grad.addColorStop(0.35, 'rgba(244, 63, 94, 0.36)');
          grad.addColorStop(0.7, 'rgba(225, 29, 72, 0.14)');
          grad.addColorStop(1, 'rgba(225, 29, 72, 0)');
        } else {
          grad.addColorStop(0, 'rgba(190, 18, 60, 0.52)');
          grad.addColorStop(0.34, 'rgba(225, 29, 72, 0.30)');
          grad.addColorStop(0.68, 'rgba(251, 113, 133, 0.11)');
          grad.addColorStop(1, 'rgba(244, 63, 94, 0)');
        }
        kctx.fillStyle = grad;
        kctx.fillRect(0, 0, size, size);
      }
      heatKernelCacheRef.current[key] = offscreen;
      return offscreen;
    },
    []
  );

  const dragStateRef = useRef<{
    active: boolean;
    pointerId: number;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  }>({
    active: false,
    pointerId: -1,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    moved: false,
  });

  const scheduleDrawRef = useRef<() => void>(() => {});

  const requestTile = useCallback(
    (
      layer: 'base' | 'terrain' | 'satellite' | 'labels',
      z: number,
      x: number,
      y: number
    ): HTMLImageElement | null => {
      const tileCount = 1 << z;
      if (y < 0 || y >= tileCount) {
        return null;
      }
      const wrappedX = ((x % tileCount) + tileCount) % tileCount;
      const key = `${layer}:${z}:${wrappedX}:${y}`;

      const cache = tileCacheRef.current;
      const existing = cache[key];
      if (existing) {
        return existing.status === 'loaded' ? existing.img : null;
      }

      if (tileKeysOrderRef.current.length >= MAX_CACHE_ENTRIES) {
        const oldestKey = tileKeysOrderRef.current.shift();
        if (oldestKey) {
          delete cache[oldestKey];
        }
      }

      const img = new Image();
      const record: TileRecord = { img, status: 'loading' };
      cache[key] = record;
      tileKeysOrderRef.current.push(key);

      img.onload = () => {
        record.status = 'loaded';
        scheduleDrawRef.current();
      };
      img.onerror = () => {
        record.status = 'error';
      };
      img.src = getTileUrl(layer, z, wrappedX, y);

      return null;
    },
    []
  );

  const drawMap = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {
      return;
    }

    const rect = container.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    ctx.save();
    ctx.scale(dpr, dpr);

    const { center, zoom } = cameraRef.current;
    const centerWorld = latLngToWorldPixel(center, zoom);
    const topLeftWorldX = centerWorld.x - width / 2;
    const topLeftWorldY = centerWorld.y - height / 2;

    const isSatellite = mode === 'satellite';

    const toScreen = (lng: number, lat: number) => {
      const wp = latLngToWorldPixel({ lat, lng }, zoom);
      return {
        x: wp.x - topLeftWorldX,
        y: wp.y - topLeftWorldY,
      };
    };

    const traceMaskRing = () => {
      ctx.beginPath();
      FINLAND_TERRITORIAL_MASK_RING.forEach(([lng, lat], idx) => {
        const pt = toScreen(lng, lat);
        if (idx === 0) {
          ctx.moveTo(pt.x, pt.y);
        } else {
          ctx.lineTo(pt.x, pt.y);
        }
      });
      ctx.closePath();
    };

    // 1. Neutral exterior backdrop outside Finland
    ctx.fillStyle = isSatellite ? '#0b1320' : '#eef2f6';
    ctx.fillRect(0, 0, width, height);

    // Clip all map & camera plan rendering strictly inside Finland's territorial boundary
    ctx.save();
    traceMaskRing();
    ctx.clip();

    // 2. Coastal marine backdrop inside Finland's territorial waters
    const seaGradient = ctx.createLinearGradient(0, 0, 0, height);
    if (isSatellite) {
      seaGradient.addColorStop(0, '#071929');
      seaGradient.addColorStop(1, '#0c273d');
    } else if (showTerrain) {
      seaGradient.addColorStop(0, '#cadfed');
      seaGradient.addColorStop(1, '#dcebf5');
    } else {
      seaGradient.addColorStop(0, '#cfe2f3');
      seaGradient.addColorStop(1, '#ddebf7');
    }
    ctx.fillStyle = seaGradient;
    ctx.fillRect(0, 0, width, height);

    // 3. Vector Finland & Island Underlay
    for (const feature of FINLAND_VECTOR_FEATURES) {
      if (feature.coordinates.length < 3) continue;
      ctx.beginPath();
      feature.coordinates.forEach(([lng, lat], index) => {
        const pt = toScreen(lng, lat);
        if (index === 0) {
          ctx.moveTo(pt.x, pt.y);
        } else {
          ctx.lineTo(pt.x, pt.y);
        }
      });
      ctx.closePath();

      if (feature.kind === 'finland' || feature.kind === 'island') {
        if (isSatellite) {
          const landGrad = ctx.createLinearGradient(0, 0, 0, height);
          landGrad.addColorStop(0, '#273b2c');
          landGrad.addColorStop(0.55, '#1d3824');
          landGrad.addColorStop(1, '#244229');
          ctx.fillStyle = landGrad;
        } else if (showTerrain) {
          const terrainGrad = ctx.createLinearGradient(0, 0, 0, height);
          terrainGrad.addColorStop(0, '#e8e4d8');
          terrainGrad.addColorStop(0.5, '#dce6d5');
          terrainGrad.addColorStop(1, '#e4edd9');
          ctx.fillStyle = terrainGrad;
        } else {
          ctx.fillStyle = '#f8faf7';
        }
        ctx.fill();
        ctx.strokeStyle = isSatellite
          ? showLabels
            ? 'rgba(253, 224, 71, 0.65)'
            : 'rgba(148, 163, 184, 0.35)'
          : '#94a3b8';
        ctx.lineWidth = feature.kind === 'finland' ? 1.4 : 1;
        ctx.stroke();
      } else if (feature.kind === 'lake') {
        ctx.fillStyle = isSatellite ? '#092236' : '#c6def1';
        ctx.fill();
      }
    }

    // 4. Web Mercator Raster Tile Layer restricted to tiles intersecting Finland
    const tileZ = Math.max(5, Math.min(18, Math.floor(zoom)));
    const zoomScale = Math.pow(2, zoom - tileZ);
    const scaledTileSize = TILE_SIZE * zoomScale;

    const topLeftAtTileZ = latLngToWorldPixel(center, tileZ);
    const viewOriginTileX = topLeftAtTileZ.x - width / (2 * zoomScale);
    const viewOriginTileY = topLeftAtTileZ.y - height / (2 * zoomScale);

    const finlandNWAtTileZ = latLngToWorldPixel(
      { lat: FINLAND_GEOGRAPHIC_BOUNDS.north, lng: FINLAND_GEOGRAPHIC_BOUNDS.west },
      tileZ
    );
    const finlandSEAtTileZ = latLngToWorldPixel(
      { lat: FINLAND_GEOGRAPHIC_BOUNDS.south, lng: FINLAND_GEOGRAPHIC_BOUNDS.east },
      tileZ
    );

    const minTileX = Math.max(
      Math.floor(finlandNWAtTileZ.x / TILE_SIZE),
      Math.floor(viewOriginTileX / TILE_SIZE)
    );
    const maxTileX = Math.min(
      Math.floor(finlandSEAtTileZ.x / TILE_SIZE),
      Math.floor((viewOriginTileX + width / zoomScale) / TILE_SIZE)
    );
    const minTileY = Math.max(
      Math.floor(finlandNWAtTileZ.y / TILE_SIZE),
      Math.floor(viewOriginTileY / TILE_SIZE)
    );
    const maxTileY = Math.min(
      Math.floor(finlandSEAtTileZ.y / TILE_SIZE),
      Math.floor((viewOriginTileY + height / zoomScale) / TILE_SIZE)
    );

    const primaryLayer: 'base' | 'terrain' | 'satellite' = isSatellite
      ? 'satellite'
      : showTerrain
        ? 'terrain'
        : 'base';

    let loadedTilesCount = 0;
    let totalVisibleTiles = 0;

    for (let ty = minTileY; ty <= maxTileY; ty++) {
      for (let tx = minTileX; tx <= maxTileX; tx++) {
        totalVisibleTiles++;
        const screenX = (tx * TILE_SIZE - viewOriginTileX) * zoomScale;
        const screenY = (ty * TILE_SIZE - viewOriginTileY) * zoomScale;

        const img = requestTile(primaryLayer, tileZ, tx, ty);
        if (img) {
          loadedTilesCount++;
          ctx.drawImage(
            img,
            Math.floor(screenX),
            Math.floor(screenY),
            Math.ceil(scaledTileSize),
            Math.ceil(scaledTileSize)
          );
        } else if (tileZ > 4) {
          const parentZ = tileZ - 1;
          const parentX = Math.floor(tx / 2);
          const parentY = Math.floor(ty / 2);
          const parentKey = `${primaryLayer}:${parentZ}:${((parentX % (1 << parentZ)) + (1 << parentZ)) % (1 << parentZ)}:${parentY}`;
          const parentRecord = tileCacheRef.current[parentKey];
          if (parentRecord?.status === 'loaded') {
            loadedTilesCount++;
            const subX = ((tx % 2) + 2) % 2;
            const subY = ((ty % 2) + 2) % 2;
            ctx.drawImage(
              parentRecord.img,
              subX * 128,
              subY * 128,
              128,
              128,
              Math.floor(screenX),
              Math.floor(screenY),
              Math.ceil(scaledTileSize),
              Math.ceil(scaledTileSize)
            );
          }
        }

        if (isSatellite && showLabels) {
          const labelImg = requestTile('labels', tileZ, tx, ty);
          if (labelImg) {
            ctx.drawImage(
              labelImg,
              Math.floor(screenX),
              Math.floor(screenY),
              Math.ceil(scaledTileSize),
              Math.ceil(scaledTileSize)
            );
          }
        }
      }
    }

    // 5. Natural Vector Labels fallback while raster tiles load
    const shouldRenderVectorLabels =
      loadedTilesCount < Math.ceil(totalVisibleTiles * 0.5) && (!isSatellite || showLabels);

    if (shouldRenderVectorLabels) {
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const lbl of NATURAL_MAP_LABELS) {
        if (zoom < lbl.minZoom || zoom > lbl.maxZoom) continue;
        const pt = toScreen(lbl.position.lng, lbl.position.lat);
        if (pt.x < -80 || pt.x > width + 80 || pt.y < -40 || pt.y > height + 40) continue;

        if (lbl.category === 'country') {
          ctx.font = '600 13px "Plus Jakarta Sans", sans-serif';
          ctx.fillStyle = isSatellite ? '#f8fafc' : '#334155';
        } else if (lbl.category === 'sea' || lbl.category === 'hydro') {
          ctx.font = 'italic 500 11px "Plus Jakarta Sans", sans-serif';
          ctx.fillStyle = isSatellite ? '#93c5fd' : '#2563eb';
        } else {
          ctx.font = '500 11px "Plus Jakarta Sans", sans-serif';
          ctx.fillStyle = isSatellite ? '#e2e8f0' : '#475569';
        }

        ctx.lineWidth = 3;
        ctx.strokeStyle = isSatellite ? 'rgba(7, 25, 41, 0.85)' : 'rgba(255, 255, 255, 0.88)';
        ctx.strokeText(lbl.text, pt.x, pt.y);
        ctx.fillText(lbl.text, pt.x, pt.y);
      }
    }

    // 6. Optional Coordinate Graticule & Arctic Circle inside Finland's bounds
    if (showGraticule) {
      const stepDeg = zoom >= 10 ? 0.5 : zoom >= 7.5 ? 1 : 2;
      ctx.lineWidth = 1;
      ctx.strokeStyle = isSatellite ? 'rgba(226, 232, 240, 0.22)' : 'rgba(15, 23, 42, 0.10)';

      for (let lat = 60; lat <= 70; lat += stepDeg) {
        const y = toScreen(center.lng, lat).y;
        if (y < 0 || y > height) continue;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      for (let lng = 20; lng <= 31; lng += stepDeg) {
        const x = toScreen(lng, center.lat).x;
        if (x < 0 || x > width) continue;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, height);
        ctx.stroke();
      }

      const arcticY = toScreen(center.lng, ARCTIC_CIRCLE_LAT).y;
      if (arcticY >= 0 && arcticY <= height) {
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isSatellite ? 'rgba(125, 211, 252, 0.8)' : 'rgba(3, 105, 161, 0.72)';
        ctx.beginPath();
        ctx.moveTo(0, arcticY);
        ctx.lineTo(width, arcticY);
        ctx.stroke();
        ctx.restore();
      }
    }

    // 7. User-Added Areas of Interest Polygons, Draft Polygon, and Live Drawing Strokes
    for (const area of areasOfInterest) {
      const activeRing =
        area.polygon.length >= 3
          ? area.polygon
          : buildGeographicCircleRing(area.center, area.radiusKm * 1000, 72);
      const isSelected = area.id === selectedAreaId;

      ctx.beginPath();
      activeRing.forEach((pt, idx) => {
        const sp = toScreen(pt.lng, pt.lat);
        if (idx === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      });
      ctx.closePath();

      if (coverageConfig.showCityBoundaries) {
        ctx.fillStyle = isSatellite
          ? isSelected
            ? 'rgba(56, 189, 248, 0.12)'
            : 'rgba(56, 189, 248, 0.07)'
          : isSelected
            ? 'rgba(2, 132, 199, 0.08)'
            : 'rgba(2, 132, 199, 0.045)';
        ctx.fill();
      }

      ctx.save();
      ctx.setLineDash([8, 5]);
      ctx.lineWidth = isSelected ? 2.3 : 1.7;
      ctx.strokeStyle = isSatellite
        ? isSelected
          ? 'rgba(125, 211, 252, 0.96)'
          : 'rgba(125, 211, 252, 0.78)'
        : isSelected
          ? 'rgba(3, 105, 161, 0.92)'
          : 'rgba(3, 105, 161, 0.72)';
      ctx.stroke();
      ctx.restore();
    }

    const matchesExistingArea = areasOfInterest.some((a) =>
      polygonsApproximatelyEqual(drawnPolygon, a.polygon)
    );

    const showUnplottedDrawnPolygon =
      drawnPolygon.length >= 3 && drawingMode === 'none' && !matchesExistingArea;

    if (showUnplottedDrawnPolygon) {
      ctx.beginPath();
      drawnPolygon.forEach((pt, idx) => {
        const sp = toScreen(pt.lng, pt.lat);
        if (idx === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      });
      ctx.closePath();

      ctx.fillStyle = isSatellite
        ? 'rgba(251, 191, 36, 0.12)'
        : 'rgba(217, 119, 6, 0.08)';
      ctx.fill();

      ctx.save();
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 2.0;
      ctx.strokeStyle = isSatellite
        ? 'rgba(253, 224, 71, 0.94)'
        : 'rgba(180, 83, 9, 0.90)';
      ctx.stroke();
      ctx.restore();

      for (const pt of drawnPolygon) {
        const sp = toScreen(pt.lng, pt.lat);
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 3.0, 0, Math.PI * 2);
        ctx.fillStyle = isSatellite ? '#fde047' : '#b45309';
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    }

    // Live Freehand Lasso Stroke
    if (drawingMode === 'freehand' && freehandStrokeRef.current.length >= 2) {
      const stroke = freehandStrokeRef.current;
      ctx.beginPath();
      stroke.forEach((pt, idx) => {
        const sp = toScreen(pt.lng, pt.lat);
        if (idx === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      });
      ctx.closePath();
      ctx.fillStyle = isSatellite
        ? 'rgba(251, 191, 36, 0.14)'
        : 'rgba(217, 119, 6, 0.10)';
      ctx.fill();

      ctx.beginPath();
      stroke.forEach((pt, idx) => {
        const sp = toScreen(pt.lng, pt.lat);
        if (idx === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      });
      ctx.lineWidth = 2.3;
      ctx.strokeStyle = isSatellite ? '#fde047' : '#d97706';
      ctx.stroke();

      const firstSp = toScreen(stroke[0].lng, stroke[0].lat);
      const lastSp = toScreen(stroke[stroke.length - 1].lng, stroke[stroke.length - 1].lat);
      ctx.save();
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(lastSp.x, lastSp.y);
      ctx.lineTo(firstSp.x, firstSp.y);
      ctx.lineWidth = 1.6;
      ctx.strokeStyle = isSatellite ? 'rgba(253, 224, 71, 0.8)' : 'rgba(180, 83, 9, 0.75)';
      ctx.stroke();
      ctx.restore();
    }

    // Live Click-by-Click Polygon Vertex Sketch
    if (drawingMode === 'polygon' && draftPolygonVertices.length >= 1) {
      if (draftPolygonVertices.length >= 3) {
        ctx.beginPath();
        draftPolygonVertices.forEach((pt, idx) => {
          const sp = toScreen(pt.lng, pt.lat);
          if (idx === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.closePath();
        ctx.fillStyle = isSatellite
          ? 'rgba(251, 191, 36, 0.12)'
          : 'rgba(217, 119, 6, 0.08)';
        ctx.fill();
      }

      ctx.beginPath();
      draftPolygonVertices.forEach((pt, idx) => {
        const sp = toScreen(pt.lng, pt.lat);
        if (idx === 0) ctx.moveTo(sp.x, sp.y);
        else ctx.lineTo(sp.x, sp.y);
      });
      ctx.lineWidth = 2.1;
      ctx.strokeStyle = isSatellite ? '#fde047' : '#d97706';
      ctx.stroke();

      const liveCursor = cursorLatLngRef.current;
      if (liveCursor) {
        const lastVertex = draftPolygonVertices[draftPolygonVertices.length - 1];
        const lastSp = toScreen(lastVertex.lng, lastVertex.lat);
        const curSp = toScreen(liveCursor.lng, liveCursor.lat);
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(lastSp.x, lastSp.y);
        ctx.lineTo(curSp.x, curSp.y);
        if (draftPolygonVertices.length >= 2) {
          const firstSp = toScreen(draftPolygonVertices[0].lng, draftPolygonVertices[0].lat);
          ctx.lineTo(firstSp.x, firstSp.y);
        }
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = isSatellite
          ? 'rgba(253, 224, 71, 0.85)'
          : 'rgba(180, 83, 9, 0.80)';
        ctx.stroke();
        ctx.restore();
      }

      draftPolygonVertices.forEach((pt, idx) => {
        const sp = toScreen(pt.lng, pt.lat);
        const isStartClosable = idx === 0 && draftPolygonVertices.length >= 3;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, isStartClosable ? 5.5 : 3.8, 0, Math.PI * 2);
        ctx.fillStyle = isStartClosable
          ? '#059669'
          : isSatellite
            ? '#fde047'
            : '#d97706';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      });
    }

    // 7.3. Historical Collision Hotspots inside Active Areas of Interest
    if (coverageConfig.showAccidentHotspots && areasOfInterest.length > 0) {
      const baseRadius =
        zoom < 7 ? 6 : zoom < 9 ? 9.5 : zoom < 11 ? 14 : zoom < 13 ? 21 : 30;

      ctx.beginPath();
      for (const area of areasOfInterest) {
        for (const [lng, lat, count] of area.hotspots) {
          const pt = toScreen(lng, lat);
          const r = baseRadius * Math.min(1.45, 0.72 + Math.log1p(count) * 0.18);
          if (pt.x < -r || pt.x > width + r || pt.y < -r || pt.y > height + r) {
            continue;
          }
          ctx.moveTo(pt.x + r, pt.y);
          ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        }
      }
      ctx.fillStyle = isSatellite ? 'rgba(239, 68, 68, 0.15)' : 'rgba(220, 38, 38, 0.11)';
      ctx.fill();

      ctx.beginPath();
      for (const area of areasOfInterest) {
        for (const [lng, lat, count] of area.hotspots) {
          if (count < 6) continue;
          const pt = toScreen(lng, lat);
          const rCore = baseRadius * 0.52 * Math.min(1.4, 0.75 + Math.log1p(count) * 0.16);
          if (pt.x < -rCore || pt.x > width + rCore || pt.y < -rCore || pt.y > height + rCore) {
            continue;
          }
          ctx.moveTo(pt.x + rCore, pt.y);
          ctx.arc(pt.x, pt.y, rCore, 0, Math.PI * 2);
        }
      }
      ctx.fillStyle = isSatellite ? 'rgba(251, 146, 60, 0.24)' : 'rgba(234, 88, 12, 0.18)';
      ctx.fill();
    }

    // 7.5. Crossing Event Simulation Heatmaps (clipped strictly to user-added Areas of Interest)
    if (
      areasOfInterest.length > 0 &&
      evaluatedEvents.length > 0 &&
      (simulatorConfig.showMissedHeatmap || simulatorConfig.showDetectedHeatmap)
    ) {
      const baseHeatRadius =
        zoom < 6.5 ? 16 : zoom < 8.5 ? 22 : zoom < 10.5 ? 28 : zoom < 12.8 ? 34 : 42;

      ctx.save();
      ctx.beginPath();
      for (const area of areasOfInterest) {
        const clipPoly =
          area.polygon.length >= 3
            ? area.polygon
            : buildGeographicCircleRing(area.center, area.radiusKm * 1000, 72);
        clipPoly.forEach((pt, idx) => {
          const sp = toScreen(pt.lng, pt.lat);
          if (idx === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.closePath();
      }
      ctx.clip();

      if (simulatorConfig.showMissedHeatmap) {
        const missedSprite = getHeatmapKernel('missed', isSatellite);
        for (const ev of evaluatedEvents) {
          if (ev.detected) continue;
          const hLng = ev.hasRoadCrossingLine ? ev.roadLng : ev.lng;
          const hLat = ev.hasRoadCrossingLine ? ev.roadLat : ev.lat;
          const pt = toScreen(hLng, hLat);
          const r = baseHeatRadius * (ev.animalSize === 'large' ? 1.12 : 0.88);
          if (pt.x < -r || pt.x > width + r || pt.y < -r || pt.y > height + r) {
            continue;
          }
          ctx.drawImage(missedSprite, pt.x - r, pt.y - r, r * 2, r * 2);
        }
      }

      if (simulatorConfig.showDetectedHeatmap) {
        const detectedSprite = getHeatmapKernel('detected', isSatellite);
        for (const ev of evaluatedEvents) {
          if (!ev.detected) continue;
          const hLng = ev.hasRoadCrossingLine ? ev.roadLng : ev.lng;
          const hLat = ev.hasRoadCrossingLine ? ev.roadLat : ev.lat;
          const pt = toScreen(hLng, hLat);
          const r = baseHeatRadius * (ev.animalSize === 'large' ? 1.12 : 0.88);
          if (pt.x < -r || pt.x > width + r || pt.y < -r || pt.y > height + r) {
            continue;
          }
          ctx.drawImage(detectedSprite, pt.x - r, pt.y - r, r * 2, r * 2);
        }
      }

      ctx.restore();
    }

    // 8. Plotted Roadside Cameras & Directional Road Coverage Cones (strict 1:1 physical ground scale)
    const metersPerPx = calculateGroundResolutionMetersPerPixel(center.lat, zoom);
    const trueCoveragePx = coverageConfig.rangeMeters / Math.max(0.05, metersPerPx);
    const effectiveRangeMeters = coverageConfig.rangeMeters;

    if (coverageConfig.showCoverageAreas && visibleCameras.length > 0 && trueCoveragePx >= 0.6) {
      const cullMargin = Math.max(24, effectiveRangeMeters / metersPerPx + 16);
      const arcSteps = zoom >= 11.5 ? 18 : 12;
      let selectedCamForSector: PlannedCameraNode | null = null;

      ctx.beginPath();
      for (const cam of visibleCameras) {
        if (cam.id === selectedCameraId) {
          selectedCamForSector = cam;
          continue;
        }
        const originScreen = toScreen(cam.lng, cam.lat);
        if (
          originScreen.x < -cullMargin ||
          originScreen.x > width + cullMargin ||
          originScreen.y < -cullMargin ||
          originScreen.y > height + cullMargin
        ) {
          continue;
        }

        const polys = computeCameraCoveragePolygons(
          cam,
          effectiveRangeMeters,
          coverageConfig.fovDeg,
          arcSteps
        );
        for (const poly of polys) {
          poly.forEach((pt: LatLngPoint, idx: number) => {
            const sp = toScreen(pt.lng, pt.lat);
            if (idx === 0) ctx.moveTo(sp.x, sp.y);
            else ctx.lineTo(sp.x, sp.y);
          });
          ctx.closePath();
        }
      }

      ctx.fillStyle = isSatellite
        ? 'rgba(56, 189, 248, 0.26)'
        : 'rgba(8, 145, 178, 0.23)';
      ctx.strokeStyle = isSatellite
        ? 'rgba(125, 211, 252, 0.85)'
        : 'rgba(14, 116, 144, 0.78)';
      ctx.lineWidth = zoom >= 12.0 ? 1.4 : 1.05;
      ctx.fill();
      ctx.stroke();

      // Optional 70% small-animal inner range arc when user enables small-animal range scaling
      if (
        simulatorConfig.scaleRangeByAnimalSize &&
        evaluatedEvents.length > 0 &&
        trueCoveragePx >= 10
      ) {
        const smallRangeM = effectiveRangeMeters * SMALL_ANIMAL_RANGE_FACTOR;
        const clampedFov = Math.max(1, Math.min(360, coverageConfig.fovDeg));
        const halfFov = clampedFov / 2;
        const gateSteps = Math.max(8, Math.ceil(clampedFov / 6));

        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (const cam of visibleCameras) {
          const originScreen = toScreen(cam.lng, cam.lat);
          if (
            originScreen.x < -cullMargin ||
            originScreen.x > width + cullMargin ||
            originScreen.y < -cullMargin ||
            originScreen.y > height + cullMargin
          ) {
            continue;
          }
          const [b1, b2] = getCameraBearings(cam);
          const gap1 = (((b2 - b1) % 360) + 360) % 360;
          const gap2 = 360 - gap1;
          const isFullDisk = clampedFov >= gap1 - 0.25 && clampedFov >= gap2 - 0.25;
          if (isFullDisk) {
            const diskSteps = Math.max(36, gateSteps * 2);
            for (let i = 0; i <= diskSteps; i++) {
              const bearing = (360 * i) / diskSteps;
              const pt = destinationPoint({ lat: cam.lat, lng: cam.lng }, smallRangeM, bearing);
              const sp = toScreen(pt.lng, pt.lat);
              if (i === 0) ctx.moveTo(sp.x, sp.y);
              else ctx.lineTo(sp.x, sp.y);
            }
          } else {
            for (const lobeBearing of [b1, b2]) {
              const startAngle = lobeBearing - halfFov;
              for (let i = 0; i <= gateSteps; i++) {
                const bearing = startAngle + (clampedFov * i) / gateSteps;
                const pt = destinationPoint({ lat: cam.lat, lng: cam.lng }, smallRangeM, bearing);
                const sp = toScreen(pt.lng, pt.lat);
                if (i === 0) ctx.moveTo(sp.x, sp.y);
                else ctx.lineTo(sp.x, sp.y);
              }
            }
          }
        }
        ctx.lineWidth = 1.1;
        ctx.strokeStyle = isSatellite
          ? 'rgba(253, 224, 71, 0.75)'
          : 'rgba(14, 116, 144, 0.65)';
        ctx.stroke();
        ctx.restore();
      }

      if (trueCoveragePx >= 6 && coverageConfig.fovDeg < 180) {
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        for (const cam of visibleCameras) {
          if (cam.id === selectedCameraId) continue;
          const originScreen = toScreen(cam.lng, cam.lat);
          if (
            originScreen.x < -cullMargin ||
            originScreen.x > width + cullMargin ||
            originScreen.y < -cullMargin ||
            originScreen.y > height + cullMargin
          ) {
            continue;
          }
          for (const lobeBearing of getCameraBearings(cam)) {
            const axisTip = destinationPoint(
              { lat: cam.lat, lng: cam.lng },
              effectiveRangeMeters,
              lobeBearing
            );
            const tipScreen = toScreen(axisTip.lng, axisTip.lat);
            ctx.moveTo(originScreen.x, originScreen.y);
            ctx.lineTo(tipScreen.x, tipScreen.y);
          }
        }
        ctx.lineWidth = 1.0;
        ctx.strokeStyle = isSatellite
          ? 'rgba(186, 230, 253, 0.70)'
          : 'rgba(7, 89, 133, 0.52)';
        ctx.stroke();
        ctx.restore();
      }

      if (selectedCamForSector) {
        const originScreen = toScreen(selectedCamForSector.lng, selectedCamForSector.lat);
        const polys = computeCameraCoveragePolygons(
          selectedCamForSector,
          effectiveRangeMeters,
          coverageConfig.fovDeg,
          20
        );
        ctx.beginPath();
        for (const poly of polys) {
          poly.forEach((pt: LatLngPoint, idx: number) => {
            const sp = toScreen(pt.lng, pt.lat);
            if (idx === 0) ctx.moveTo(sp.x, sp.y);
            else ctx.lineTo(sp.x, sp.y);
          });
          ctx.closePath();
        }
        ctx.fillStyle = isSatellite
          ? 'rgba(251, 191, 36, 0.38)'
          : 'rgba(217, 119, 6, 0.28)';
        ctx.strokeStyle = isSatellite ? '#fde047' : '#b45309';
        ctx.lineWidth = 2.0;
        ctx.fill();
        ctx.stroke();

        if (coverageConfig.fovDeg < 180) {
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          for (const lobeBearing of getCameraBearings(selectedCamForSector)) {
            const axisTip = destinationPoint(
              { lat: selectedCamForSector.lat, lng: selectedCamForSector.lng },
              effectiveRangeMeters,
              lobeBearing
            );
            const tipScreen = toScreen(axisTip.lng, axisTip.lat);
            ctx.moveTo(originScreen.x, originScreen.y);
            ctx.lineTo(tipScreen.x, tipScreen.y);
          }
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = isSatellite ? '#fef08a' : '#92400e';
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // 9. Camera Hardware Nodes
    const nodeRadius =
      zoom < 6.8
        ? 2.4
        : zoom < 9.2
          ? 3.0
          : zoom < 12.2
            ? 2.8
            : Math.min(4.4, Math.max(2.8, trueCoveragePx * 0.22));
    let selectedCamObj: PlannedCameraNode | null = null;

    for (const cam of visibleCameras) {
      if (cam.id === selectedCameraId) {
        selectedCamObj = cam;
        continue;
      }
      const sp = toScreen(cam.lng, cam.lat);
      if (sp.x < -16 || sp.x > width + 16 || sp.y < -16 || sp.y > height + 16) continue;

      ctx.beginPath();
      ctx.arc(sp.x, sp.y, nodeRadius, 0, Math.PI * 2);
      const tier = getCameraPriorityTier(cam.rankInCity);
      if (tier === 'critical') {
        ctx.fillStyle = isSatellite ? '#fb7185' : '#be123c';
      } else if (tier === 'high') {
        ctx.fillStyle = isSatellite ? '#38bdf8' : '#0369a1';
      } else {
        ctx.fillStyle = isSatellite ? '#2dd4bf' : '#0f766e';
      }
      ctx.fill();

      if (zoom >= 8.2) {
        ctx.lineWidth = 1.4;
        ctx.strokeStyle = isSatellite ? '#082f49' : '#ffffff';
        ctx.stroke();
      }

      if (zoom >= 13.0) {
        ctx.font = '600 10px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3;
        ctx.strokeStyle = isSatellite ? 'rgba(15, 23, 42, 0.9)' : 'rgba(255, 255, 255, 0.92)';
        ctx.strokeText(cam.id, sp.x, sp.y - nodeRadius - 3);
        ctx.fillStyle = isSatellite ? '#f8fafc' : '#0f172a';
        ctx.fillText(cam.id, sp.x, sp.y - nodeRadius - 3);
      }
    }

    if (selectedCamObj) {
      const sp = toScreen(selectedCamObj.lng, selectedCamObj.lat);
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, nodeRadius + 3.2, 0, Math.PI * 2);
      ctx.fillStyle = isSatellite ? 'rgba(251, 191, 36, 0.35)' : 'rgba(217, 119, 6, 0.28)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(sp.x, sp.y, nodeRadius + 1.4, 0, Math.PI * 2);
      ctx.fillStyle = '#d97706';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      ctx.font = '700 11px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = isSatellite ? 'rgba(15, 23, 42, 0.92)' : 'rgba(255, 255, 255, 0.95)';
      ctx.strokeText(selectedCamObj.id, sp.x, sp.y - nodeRadius - 5);
      ctx.fillStyle = isSatellite ? '#fde68a' : '#92400e';
      ctx.fillText(selectedCamObj.id, sp.x, sp.y - nodeRadius - 5);
    }

    // 9.5. Normal-Incidence Animal Road-Crossing Trajectories & Event Pins (zoom >= 11x or selected event)
    if (
      evaluatedEvents.length > 0 &&
      ((simulatorConfig.showEventPoints && zoom >= 11.0) || selectedCrossingEventId !== null)
    ) {
      const onlyOneLayerActive =
        simulatorConfig.showDetectedHeatmap !== simulatorConfig.showMissedHeatmap;
      let selectedEvObj: EvaluatedCrossingEvent | null = null;

      const drawArrowHead = (
        fromX: number,
        fromY: number,
        toX: number,
        toY: number,
        headLen: number,
        color: string
      ) => {
        const segLen = Math.hypot(toX - fromX, toY - fromY);
        if (segLen < 7) return;
        const angle = Math.atan2(toY - fromY, toX - fromX);
        ctx.beginPath();
        ctx.moveTo(toX, toY);
        ctx.lineTo(
          toX - headLen * Math.cos(angle - Math.PI / 6),
          toY - headLen * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
          toX - headLen * Math.cos(angle + Math.PI / 6),
          toY - headLen * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.fill();
      };

      for (const ev of evaluatedEvents) {
        if (ev.eventId === selectedCrossingEventId) {
          selectedEvObj = ev;
          continue;
        }
        if (!(simulatorConfig.showEventPoints && zoom >= 11.0)) {
          continue;
        }
        if (onlyOneLayerActive) {
          if (ev.detected && !simulatorConfig.showDetectedHeatmap) continue;
          if (!ev.detected && !simulatorConfig.showMissedHeatmap) continue;
        }

        const startSp = toScreen(ev.crossingStartLng, ev.crossingStartLat);
        const endSp = toScreen(ev.crossingEndLng, ev.crossingEndLat);
        const animalSp = toScreen(ev.lng, ev.lat);

        const minX = Math.min(startSp.x, endSp.x, animalSp.x);
        const maxX = Math.max(startSp.x, endSp.x, animalSp.x);
        const minY = Math.min(startSp.y, endSp.y, animalSp.y);
        const maxY = Math.max(startSp.y, endSp.y, animalSp.y);
        if (maxX < -20 || minX > width + 20 || maxY < -20 || minY > height + 20) continue;

        const strokeColor = ev.detected
          ? isSatellite
            ? '#34d399'
            : '#059669'
          : isSatellite
            ? '#fb7185'
            : '#e11d48';

        // Draw normal-incidence crossing line from animal position through closest road
        if (ev.hasRoadCrossingLine) {
          const pxLen = Math.hypot(endSp.x - startSp.x, endSp.y - startSp.y);
          if (pxLen >= 2.2) {
            ctx.beginPath();
            ctx.moveTo(startSp.x, startSp.y);
            ctx.lineTo(endSp.x, endSp.y);
            ctx.lineWidth = zoom >= 13.5 ? 2.1 : 1.6;
            ctx.strokeStyle = strokeColor;
            ctx.stroke();

            if (zoom >= 12.6 && pxLen >= 9) {
              drawArrowHead(
                startSp.x,
                startSp.y,
                endSp.x,
                endSp.y,
                zoom >= 14.2 ? 5.6 : 4.5,
                strokeColor
              );
            }
          }
        }

        // Animal starting spot diamond marker
        const d = (ev.animalSize === 'large' ? 4.4 : 3.4) * (zoom >= 14 ? 1.15 : 1.0);
        ctx.beginPath();
        ctx.moveTo(animalSp.x, animalSp.y - d);
        ctx.lineTo(animalSp.x + d, animalSp.y);
        ctx.lineTo(animalSp.x, animalSp.y + d);
        ctx.lineTo(animalSp.x - d, animalSp.y);
        ctx.closePath();

        ctx.fillStyle = ev.detected ? '#10b981' : '#f43f5e';
        ctx.fill();
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = isSatellite ? '#0f172a' : '#ffffff';
        ctx.stroke();
      }

      if (selectedEvObj) {
        const startSp = toScreen(selectedEvObj.crossingStartLng, selectedEvObj.crossingStartLat);
        const roadSp = toScreen(selectedEvObj.roadLng, selectedEvObj.roadLat);
        const endSp = toScreen(selectedEvObj.crossingEndLng, selectedEvObj.crossingEndLat);
        const animalSp = toScreen(selectedEvObj.lng, selectedEvObj.lat);
        const primaryStroke = selectedEvObj.detected ? '#059669' : '#e11d48';

        if (selectedEvObj.hasRoadCrossingLine) {
          // Contrast halo along normal-incidence crossing trajectory
          ctx.beginPath();
          ctx.moveTo(startSp.x, startSp.y);
          ctx.lineTo(endSp.x, endSp.y);
          ctx.lineWidth = 6.0;
          ctx.lineCap = 'round';
          ctx.strokeStyle = isSatellite
            ? 'rgba(251, 191, 36, 0.45)'
            : 'rgba(255, 255, 255, 0.92)';
          ctx.stroke();

          ctx.beginPath();
          ctx.moveTo(startSp.x, startSp.y);
          ctx.lineTo(endSp.x, endSp.y);
          ctx.lineWidth = 2.8;
          ctx.lineCap = 'round';
          ctx.strokeStyle = primaryStroke;
          ctx.stroke();
          ctx.lineCap = 'butt';

          drawArrowHead(startSp.x, startSp.y, endSp.x, endSp.y, 7.0, primaryStroke);

          // Perpendicular road-incidence intersection ring
          ctx.beginPath();
          ctx.arc(roadSp.x, roadSp.y, 3.6, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.lineWidth = 1.8;
          ctx.strokeStyle = primaryStroke;
          ctx.stroke();
        }

        const d = 6.8;
        ctx.beginPath();
        ctx.moveTo(animalSp.x, animalSp.y - (d + 4));
        ctx.lineTo(animalSp.x + (d + 4), animalSp.y);
        ctx.lineTo(animalSp.x, animalSp.y + (d + 4));
        ctx.lineTo(animalSp.x - (d + 4), animalSp.y);
        ctx.closePath();
        ctx.fillStyle = isSatellite ? 'rgba(251, 191, 36, 0.38)' : 'rgba(217, 119, 6, 0.30)';
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(animalSp.x, animalSp.y - d);
        ctx.lineTo(animalSp.x + d, animalSp.y);
        ctx.lineTo(animalSp.x, animalSp.y + d);
        ctx.lineTo(animalSp.x - d, animalSp.y);
        ctx.closePath();
        ctx.fillStyle = primaryStroke;
        ctx.fill();
        ctx.lineWidth = 2.0;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();

        const labelAnchor = selectedEvObj.hasRoadCrossingLine ? roadSp : animalSp;
        const tag = `${selectedEvObj.eventId} · ${
          selectedEvObj.detected ? 'DETECTED' : 'MISSED'
        }`;
        ctx.font = '700 10.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = isSatellite ? 'rgba(15, 23, 42, 0.94)' : 'rgba(255, 255, 255, 0.96)';
        ctx.strokeText(tag, labelAnchor.x, Math.max(labelAnchor.y, animalSp.y) + d + 6);
        ctx.fillStyle = selectedEvObj.detected
          ? isSatellite
            ? '#6ee7b7'
            : '#065f46'
          : isSatellite
            ? '#fda4af'
            : '#9f1239';
        ctx.fillText(tag, labelAnchor.x, Math.max(labelAnchor.y, animalSp.y) + d + 6);
      }
    }

    ctx.restore();

    traceMaskRing();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = isSatellite ? 'rgba(148, 163, 184, 0.55)' : '#94a3b8';
    ctx.stroke();

    // 10. Area of Interest Callout Labels at Northernmost Edge (< 11.2x zoom)
    if (areasOfInterest.length > 0 && zoom < 11.2) {
      for (const area of areasOfInterest) {
        let northPt = destinationPoint(area.center, area.radiusKm * 1000, 0);
        if (area.polygon.length >= 3) {
          northPt = area.polygon.reduce((best, p) => (p.lat > best.lat ? p : best));
        }
        const sp = toScreen(northPt.lng, northPt.lat);
        if (sp.x >= -120 && sp.x <= width + 120 && sp.y >= 16 && sp.y <= height - 16) {
          const isSelected = area.id === selectedAreaId;
          const label = `${area.label} · ${area.areaKm2} km² · ${area.cameras.length} cam`;
          ctx.font = isSelected
            ? '700 11.5px "Plus Jakarta Sans", sans-serif'
            : '600 11px "Plus Jakarta Sans", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.lineWidth = 3.5;
          ctx.strokeStyle = isSatellite ? 'rgba(7, 25, 41, 0.92)' : 'rgba(255, 255, 255, 0.96)';
          ctx.strokeText(label, sp.x, sp.y - 6);
          ctx.fillStyle = isSatellite
            ? isSelected
              ? '#fde68a'
              : '#bae6fd'
            : isSelected
              ? '#0c4a6e'
              : '#0369a1';
          ctx.fillText(label, sp.x, sp.y - 6);
        }
      }
    }

    if (showGraticule) {
      const stepDeg = zoom >= 10 ? 0.5 : zoom >= 7.5 ? 1 : 2;
      const westEdgeX = Math.max(12, toScreen(FINLAND_GEOGRAPHIC_BOUNDS.west, center.lat).x + 6);
      const eastEdgeX = Math.min(width - 16, toScreen(29.46, ARCTIC_CIRCLE_LAT).x - 8);
      ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.fillStyle = isSatellite ? 'rgba(203, 213, 225, 0.8)' : 'rgba(71, 85, 105, 0.82)';

      for (let lat = 60; lat <= 70; lat += stepDeg) {
        const y = toScreen(center.lng, lat).y;
        if (y < 24 || y > height - 64) continue;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(`${lat.toFixed(stepDeg < 1 ? 1 : 0)}°N`, westEdgeX, y - 3);
      }

      for (let lng = 20; lng <= 31; lng += stepDeg) {
        const x = toScreen(lng, center.lat).x;
        if (x < Math.max(8, westEdgeX) || x > width - 330) continue;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`${lng.toFixed(stepDeg < 1 ? 1 : 0)}°E`, x + 4, 10);
      }

      const arcticY = toScreen(center.lng, ARCTIC_CIRCLE_LAT).y;
      if (arcticY >= 24 && arcticY <= height - 64 && eastEdgeX > 140) {
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.font = '600 10px "JetBrains Mono", monospace';
        ctx.fillStyle = isSatellite ? '#bae6fd' : '#0369a1';
        ctx.fillText('Arctic Circle · 66°33′N', eastEdgeX, arcticY - 4);
      }
    }

    ctx.restore();
  }, [
    areasOfInterest,
    coverageConfig,
    draftPolygonVertices,
    drawingMode,
    drawnPolygon,
    evaluatedEvents,
    getHeatmapKernel,
    mode,
    requestTile,
    selectedAreaId,
    selectedCameraId,
    selectedCrossingEventId,
    showGraticule,
    showLabels,
    showTerrain,
    simulatorConfig,
    visibleCameras,
  ]);

  const scheduleDraw = useCallback(() => {
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }
    rafIdRef.current = requestAnimationFrame(() => {
      rafIdRef.current = null;
      drawMap();
    });
  }, [drawMap]);

  scheduleDrawRef.current = scheduleDraw;

  useEffect(() => {
    scheduleDraw();
  }, [
    areasOfInterest,
    camera,
    mode,
    mapTypeId,
    showLabels,
    showTerrain,
    showGraticule,
    selectedAreaId,
    selectedCameraId,
    selectedCrossingEventId,
    coverageConfig,
    draftPolygonVertices,
    drawingMode,
    drawnPolygon,
    evaluatedEvents,
    simulatorConfig,
    visibleCameras,
    scheduleDraw,
  ]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      scheduleDraw();
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, [scheduleDraw]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      const dx = e.clientX - (rect.left + rect.width / 2);
      const dy = e.clientY - (rect.top + rect.height / 2);
      const zoomDelta = -Math.sign(e.deltaY) * 0.5;
      if (zoomDelta === 0) return;

      const next = zoomAroundScreenPoint(
        cameraRef.current,
        cameraRef.current.zoom + zoomDelta,
        { dx, dy },
        { width: rect.width, height: rect.height }
      );
      onCameraChangeRef.current(next);
    };

    container.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheel);
    };
  }, []);

  const clampPointToFinland = (pt: LatLngPoint): LatLngPoint => ({
    lat: Number(
      Math.max(
        FINLAND_GEOGRAPHIC_BOUNDS.south,
        Math.min(FINLAND_GEOGRAPHIC_BOUNDS.north, pt.lat)
      ).toFixed(5)
    ),
    lng: Number(
      Math.max(
        FINLAND_GEOGRAPHIC_BOUNDS.west,
        Math.min(FINLAND_GEOGRAPHIC_BOUNDS.east, pt.lng)
      ).toFixed(5)
    ),
  });

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    dragStateRef.current = {
      active: true,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    };

    if (drawingModeRef.current === 'freehand') {
      const rect = e.currentTarget.getBoundingClientRect();
      const offsetX = e.clientX - (rect.left + rect.width / 2);
      const offsetY = e.clientY - (rect.top + rect.height / 2);
      const centerWorld = latLngToWorldPixel(cameraRef.current.center, cameraRef.current.zoom);
      const startPt = clampPointToFinland(
        worldPixelToLatLng(
          { x: centerWorld.x + offsetX, y: centerWorld.y + offsetY },
          cameraRef.current.zoom
        )
      );
      freehandStrokeRef.current = [startPt];
      freehandLastScreenRef.current = { x: e.clientX, y: e.clientY };
      scheduleDrawRef.current();
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - (rect.left + rect.width / 2);
    const offsetY = e.clientY - (rect.top + rect.height / 2);
    const centerWorld = latLngToWorldPixel(cameraRef.current.center, cameraRef.current.zoom);
    const cursorLatLng = worldPixelToLatLng(
      { x: centerWorld.x + offsetX, y: centerWorld.y + offsetY },
      cameraRef.current.zoom
    );
    const inFinland = isPointWithinFinlandBounds(cursorLatLng);
    cursorLatLngRef.current = inFinland ? cursorLatLng : null;
    onCursorMove(inFinland ? cursorLatLng : null);

    if (
      drawingModeRef.current === 'polygon' &&
      draftPolygonVerticesRef.current.length > 0 &&
      !dragStateRef.current.active
    ) {
      scheduleDrawRef.current();
    }

    if (!dragStateRef.current.active || dragStateRef.current.pointerId !== e.pointerId) {
      return;
    }

    if (drawingModeRef.current === 'freehand') {
      const prevScreen = freehandLastScreenRef.current;
      if (!prevScreen || Math.hypot(e.clientX - prevScreen.x, e.clientY - prevScreen.y) >= 4) {
        freehandStrokeRef.current.push(clampPointToFinland(cursorLatLng));
        freehandLastScreenRef.current = { x: e.clientX, y: e.clientY };
        dragStateRef.current.moved = true;
        scheduleDrawRef.current();
      }
      return;
    }

    const totalMove = Math.hypot(
      e.clientX - dragStateRef.current.startX,
      e.clientY - dragStateRef.current.startY
    );
    if (totalMove > 5) {
      dragStateRef.current.moved = true;
    }

    const deltaX = e.clientX - dragStateRef.current.lastX;
    const deltaY = e.clientY - dragStateRef.current.lastY;
    dragStateRef.current.lastX = e.clientX;
    dragStateRef.current.lastY = e.clientY;

    const nextWorld = {
      x: centerWorld.x - deltaX,
      y: centerWorld.y - deltaY,
    };
    const nextCamera = clampCamera(
      {
        center: worldPixelToLatLng(nextWorld, cameraRef.current.zoom),
        zoom: cameraRef.current.zoom,
      },
      { width: rect.width, height: rect.height }
    );
    onCameraChange(nextCamera);
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const wasTap =
      dragStateRef.current.pointerId === e.pointerId && !dragStateRef.current.moved;
    if (dragStateRef.current.pointerId === e.pointerId) {
      dragStateRef.current.active = false;
      dragStateRef.current.pointerId = -1;
    }

    if (drawingModeRef.current === 'freehand') {
      const rawStroke = freehandStrokeRef.current;
      freehandStrokeRef.current = [];
      freehandLastScreenRef.current = null;
      scheduleDrawRef.current();

      if (rawStroke.length >= 3) {
        const simplified = simplifyLatLngRing(rawStroke);
        if (simplified.length >= 3) {
          onCompletePolygonRef.current?.(simplified);
        }
      }
      return;
    }

    if (!wasTap) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const cur = cameraRef.current;
    const centerWorld = latLngToWorldPixel(cur.center, cur.zoom);
    const topLeftX = centerWorld.x - rect.width / 2;
    const topLeftY = centerWorld.y - rect.height / 2;

    const clickedPoint = worldPixelToLatLng(
      { x: topLeftX + clickX, y: topLeftY + clickY },
      cur.zoom
    );

    if (drawingModeRef.current === 'polygon') {
      const vertices = draftPolygonVerticesRef.current;
      if (vertices.length >= 3) {
        const firstWp = latLngToWorldPixel(vertices[0], cur.zoom);
        const firstSx = firstWp.x - topLeftX;
        const firstSy = firstWp.y - topLeftY;
        if (Math.hypot(firstSx - clickX, firstSy - clickY) <= 14) {
          onCompletePolygonRef.current?.(vertices);
          return;
        }
      }

      if (isPointWithinFinlandBounds(clickedPoint)) {
        onAddDraftVertexRef.current?.(clampPointToFinland(clickedPoint));
      }
      return;
    }

    if (cur.zoom >= 7.2) {
      let nearestCam: PlannedCameraNode | null = null;
      let nearestDist = 14;
      for (const cam of visibleCamerasRef.current) {
        const wp = latLngToWorldPixel({ lat: cam.lat, lng: cam.lng }, cur.zoom);
        const sx = wp.x - topLeftX;
        const sy = wp.y - topLeftY;
        const d = Math.hypot(sx - clickX, sy - clickY);
        if (d <= nearestDist) {
          nearestDist = d;
          nearestCam = cam;
        }
      }
      if (nearestCam) {
        onSelectCamera(nearestCam);
        return;
      }

      if (
        cur.zoom >= 11.0 &&
        simulatorConfigRef.current.showEventPoints &&
        evaluatedEventsRef.current.length > 0
      ) {
        const simCfg = simulatorConfigRef.current;
        const onlyOneLayerActive = simCfg.showDetectedHeatmap !== simCfg.showMissedHeatmap;
        let nearestEv: EvaluatedCrossingEvent | null = null;
        let nearestEvDist = 12;
        for (const ev of evaluatedEventsRef.current) {
          if (onlyOneLayerActive) {
            if (ev.detected && !simCfg.showDetectedHeatmap) continue;
            if (!ev.detected && !simCfg.showMissedHeatmap) continue;
          }
          const wpStart = latLngToWorldPixel(
            { lat: ev.crossingStartLat, lng: ev.crossingStartLng },
            cur.zoom
          );
          const wpEnd = latLngToWorldPixel(
            { lat: ev.crossingEndLat, lng: ev.crossingEndLng },
            cur.zoom
          );
          const ax = wpStart.x - topLeftX;
          const ay = wpStart.y - topLeftY;
          const bx = wpEnd.x - topLeftX;
          const by = wpEnd.y - topLeftY;
          const vx = bx - ax;
          const vy = by - ay;
          const lenSq = vx * vx + vy * vy;
          const t =
            lenSq > 1e-6
              ? Math.max(0, Math.min(1, ((clickX - ax) * vx + (clickY - ay) * vy) / lenSq))
              : 0;
          const d = Math.hypot(clickX - (ax + t * vx), clickY - (ay + t * vy));
          if (d <= nearestEvDist) {
            nearestEvDist = d;
            nearestEv = ev;
          }
        }
        if (nearestEv) {
          onSelectCrossingEvent(nearestEv);
          return;
        }
      }
    }

    for (let i = areasOfInterestRef.current.length - 1; i >= 0; i--) {
      const area = areasOfInterestRef.current[i];
      if (
        area.polygon.length >= 3 &&
        isPointInLatLngPolygon(clickedPoint.lat, clickedPoint.lng, area.polygon)
      ) {
        onSelectAreaRef.current(area);
        return;
      }
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current.pointerId === e.pointerId) {
      dragStateRef.current.active = false;
      dragStateRef.current.pointerId = -1;
    }
    if (freehandStrokeRef.current.length > 0) {
      freehandStrokeRef.current = [];
      freehandLastScreenRef.current = null;
      scheduleDrawRef.current();
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (drawingModeRef.current === 'polygon') {
      e.preventDefault();
      if (draftPolygonVerticesRef.current.length >= 3) {
        onCompletePolygonRef.current?.(draftPolygonVerticesRef.current);
      }
      return;
    }
    if (drawingModeRef.current === 'freehand') {
      return;
    }

    const rect = e.currentTarget.getBoundingClientRect();
    const dx = e.clientX - (rect.left + rect.width / 2);
    const dy = e.clientY - (rect.top + rect.height / 2);
    const next = zoomAroundScreenPoint(
      cameraRef.current,
      cameraRef.current.zoom + ZOOM_STEP,
      { dx, dy },
      { width: rect.width, height: rect.height }
    );
    onCameraChange(next);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const cur = cameraRef.current;
    const rect = e.currentTarget.getBoundingClientRect();
    const viewport = { width: rect.width, height: rect.height };
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      onCameraChange(clampCamera({ center: cur.center, zoom: cur.zoom + ZOOM_STEP }, viewport));
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      onCameraChange(clampCamera({ center: cur.center, zoom: cur.zoom - ZOOM_STEP }, viewport));
    } else if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      const panPx = 80;
      const world = latLngToWorldPixel(cur.center, cur.zoom);
      const nextWorld = {
        x: world.x + (e.key === 'ArrowRight' ? panPx : e.key === 'ArrowLeft' ? -panPx : 0),
        y: world.y + (e.key === 'ArrowDown' ? panPx : e.key === 'ArrowUp' ? -panPx : 0),
      };
      onCameraChange(
        clampCamera(
          {
            center: worldPixelToLatLng(nextWorld, cur.zoom),
            zoom: cur.zoom,
          },
          viewport
        )
      );
    }
  };

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      role="application"
      aria-label={`Interactive Finland map in ${mode === 'satellite' ? 'Satellite' : 'Base Map'} mode at zoom ${camera.zoom.toFixed(1)} showing ${visibleCameras.length} planned wildlife cameras across ${areasOfInterest.length} areas of interest`}
      data-testid="finland-map-canvas"
      data-map-mode={mode}
      data-map-type={mapTypeId}
      data-zoom={camera.zoom.toFixed(2)}
      data-camera-count={visibleCameras.length}
      data-areas-count={areasOfInterest.length}
      data-selected-year={String(simulatorConfig.selectedYear)}
      data-sim-events={evaluatedEvents.length}
      data-drawing-mode={drawingMode}
      data-drawn-vertices={drawnPolygon.length}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={() => {
        cursorLatLngRef.current = null;
        onCursorMove(null);
      }}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      className={`w-full h-full relative outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-600 select-none touch-none ${
        drawingMode !== 'none' ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
      }`}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />
    </div>
  );
}
