import React, { useCallback, useEffect, useRef } from 'react';
import {
  ARCTIC_CIRCLE_LAT,
  FINLAND_TERRITORIAL_MASK_RING,
  FINLAND_VECTOR_FEATURES,
  NATURAL_MAP_LABELS,
} from '../data/finlandGeo';
import {
  TOP_5_WILDLIFE_ACCIDENT_CITIES,
  type CityCameraPlan,
  type PlannedCameraNode,
  type SectorFilter,
} from '../data/finlandWildlifePlan';
import {
  buildGeographicCircleRing,
  computeCameraSectorPolygon,
  destinationPoint,
  getCameraPriorityTier,
  SECTOR_PALETTE,
  type CameraCoverageConfig,
} from '../utils/cameraPlanGeometry';
import {
  isArrangementRotational,
  type EvaluatedCrossingEvent,
  type SimulatorConfig,
} from '../utils/crossingSimulator';
import type { CustomAreaPlanResult, PlanScopeMode } from '../types/customAreaPlan';
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
  selectedCityId: string;
  selectedSector: SectorFilter;
  selectedCameraId: string | null;
  coverageConfig: CameraCoverageConfig;
  visibleCameras: PlannedCameraNode[];
  evaluatedEvents: EvaluatedCrossingEvent[];
  simulatorConfig: SimulatorConfig;
  selectedCrossingEventId: string | null;
  planScope?: PlanScopeMode;
  customAreaPlan?: CustomAreaPlanResult | null;
  customDraftArea?: { center: LatLngPoint; radiusKm: number; label: string } | null;
  isPickingCustomCenter?: boolean;
  onCameraChange: (next: CameraState) => void;
  onCursorMove: (point: LatLngPoint | null) => void;
  onSelectCamera: (camera: PlannedCameraNode | null) => void;
  onSelectCity: (city: CityCameraPlan) => void;
  onSelectSector: (sector: SectorFilter) => void;
  onSelectCrossingEvent: (event: EvaluatedCrossingEvent) => void;
  onPickCustomCenter?: (point: LatLngPoint) => void;
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
  selectedCityId,
  selectedSector,
  selectedCameraId,
  coverageConfig,
  visibleCameras,
  evaluatedEvents,
  simulatorConfig,
  selectedCrossingEventId,
  planScope = 'top5',
  customAreaPlan = null,
  customDraftArea = null,
  isPickingCustomCenter = false,
  onCameraChange,
  onCursorMove,
  onSelectCamera,
  onSelectCity,
  onSelectSector,
  onSelectCrossingEvent,
  onPickCustomCenter,
}: CanvasFinlandMapProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const tileCacheRef = useRef<Record<string, TileRecord>>({});
  const tileKeysOrderRef = useRef<string[]>([]);
  const heatKernelCacheRef = useRef<Record<string, HTMLCanvasElement>>({});
  const rafIdRef = useRef<number | null>(null);

  const visibleCities = planScope === 'custom' ? [] : TOP_5_WILDLIFE_ACCIDENT_CITIES;

  const cameraRef = useRef<CameraState>(camera);
  cameraRef.current = camera;

  const planScopeRef = useRef<PlanScopeMode>(planScope);
  planScopeRef.current = planScope;

  const isPickingCustomCenterRef = useRef<boolean>(isPickingCustomCenter);
  isPickingCustomCenterRef.current = isPickingCustomCenter;

  const onPickCustomCenterRef = useRef(onPickCustomCenter);
  onPickCustomCenterRef.current = onPickCustomCenter;

  const selectedSectorRef = useRef<SectorFilter>(selectedSector);
  selectedSectorRef.current = selectedSector;

  const coverageConfigRef = useRef<CameraCoverageConfig>(coverageConfig);
  coverageConfigRef.current = coverageConfig;

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

    // 7. Top 5 Wildlife Accident Cities: 5 Deployment Sectors, Boundaries & Hotspots
    const citiesToDraw = visibleCities;

    if (coverageConfig.showDeploymentSectors) {
      for (const city of citiesToDraw) {
        ctx.save();
        ctx.beginPath();
        for (const ring of city.borderLines) {
          if (ring.length < 3) continue;
          ring.forEach(([lng, lat], idx) => {
            const pt = toScreen(lng, lat);
            if (idx === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
          });
          ctx.closePath();
        }
        ctx.clip('evenodd');

        for (const sec of city.sectors) {
          if (sec.voronoiRing.length < 3) continue;
          const style = SECTOR_PALETTE[sec.sectorIndex];
          const isFocused = selectedSector === sec.sectorIndex;
          const isDimmed = selectedSector !== 'all' && !isFocused;

          ctx.beginPath();
          sec.voronoiRing.forEach(([lng, lat], idx) => {
            const pt = toScreen(lng, lat);
            if (idx === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
          });
          ctx.closePath();

          ctx.fillStyle = isDimmed
            ? isSatellite
              ? 'rgba(15, 23, 42, 0.16)'
              : 'rgba(148, 163, 184, 0.05)'
            : isFocused
              ? isSatellite
                ? style.fillActiveSat
                : style.fillActiveBase
              : isSatellite
                ? style.fillSat
                : style.fillBase;
          ctx.fill();

          ctx.save();
          ctx.setLineDash([5, 4]);
          ctx.lineWidth = isFocused ? 2.2 : 1.25;
          ctx.strokeStyle = isDimmed
            ? isSatellite
              ? 'rgba(148, 163, 184, 0.42)'
              : 'rgba(100, 116, 139, 0.36)'
            : isSatellite
              ? style.strokeSat
              : style.strokeBase;
          ctx.stroke();
          ctx.restore();
        }

        ctx.restore();
      }
    }

    if (coverageConfig.showCityBoundaries) {
      for (const city of citiesToDraw) {
        const isActiveCity = selectedCityId === city.id;
        for (const ring of city.borderLines) {
          if (ring.length < 3) continue;
          ctx.beginPath();
          ring.forEach(([lng, lat], idx) => {
            const pt = toScreen(lng, lat);
            if (idx === 0) ctx.moveTo(pt.x, pt.y);
            else ctx.lineTo(pt.x, pt.y);
          });
          ctx.closePath();

          if (!coverageConfig.showDeploymentSectors) {
            ctx.fillStyle = isSatellite
              ? isActiveCity
                ? 'rgba(56, 189, 248, 0.08)'
                : 'rgba(56, 189, 248, 0.06)'
              : isActiveCity
                ? 'rgba(2, 132, 199, 0.05)'
                : 'rgba(2, 132, 199, 0.04)';
            ctx.fill();
          }

          ctx.save();
          ctx.setLineDash(zoom >= 9 ? [7, 4] : []);
          ctx.lineWidth = isActiveCity ? 2.1 : 1.5;
          ctx.strokeStyle = isSatellite
            ? 'rgba(125, 211, 252, 0.88)'
            : 'rgba(3, 105, 161, 0.82)';
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // 7.2. Custom Location & Radius Study Circle + Draft Preview Circle
    if (planScope === 'custom' || isPickingCustomCenter) {
      const hasDistinctDraft =
        customDraftArea !== null &&
        (!customAreaPlan ||
          Math.abs(customDraftArea.center.lat - customAreaPlan.center.lat) > 0.0004 ||
          Math.abs(customDraftArea.center.lng - customAreaPlan.center.lng) > 0.0004 ||
          Math.abs(customDraftArea.radiusKm - customAreaPlan.radiusKm) > 0.05 ||
          isPickingCustomCenter);

      if (customAreaPlan) {
        const activeCircle = buildGeographicCircleRing(
          customAreaPlan.center,
          customAreaPlan.radiusKm * 1000,
          96
        );
        ctx.beginPath();
        activeCircle.forEach((pt, idx) => {
          const sp = toScreen(pt.lng, pt.lat);
          if (idx === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.closePath();

        if (coverageConfig.showCityBoundaries) {
          ctx.fillStyle = isSatellite
            ? 'rgba(56, 189, 248, 0.08)'
            : 'rgba(2, 132, 199, 0.05)';
          ctx.fill();
        }

        ctx.save();
        ctx.setLineDash([8, 5]);
        ctx.lineWidth = 2.1;
        ctx.strokeStyle = isSatellite
          ? 'rgba(125, 211, 252, 0.92)'
          : 'rgba(3, 105, 161, 0.88)';
        ctx.stroke();
        ctx.restore();

        // Center anchor crosshair
        const centerSp = toScreen(customAreaPlan.center.lng, customAreaPlan.center.lat);
        ctx.beginPath();
        ctx.arc(centerSp.x, centerSp.y, 4.2, 0, Math.PI * 2);
        ctx.fillStyle = isSatellite ? '#38bdf8' : '#0369a1';
        ctx.fill();
        ctx.lineWidth = 1.6;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }

      if (hasDistinctDraft && customDraftArea) {
        const draftCircle = buildGeographicCircleRing(
          customDraftArea.center,
          customDraftArea.radiusKm * 1000,
          96
        );
        ctx.beginPath();
        draftCircle.forEach((pt, idx) => {
          const sp = toScreen(pt.lng, pt.lat);
          if (idx === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.closePath();

        ctx.fillStyle = isSatellite
          ? 'rgba(251, 191, 36, 0.09)'
          : 'rgba(217, 119, 6, 0.06)';
        ctx.fill();

        ctx.save();
        ctx.setLineDash([5, 5]);
        ctx.lineWidth = 1.9;
        ctx.strokeStyle = isSatellite
          ? 'rgba(253, 224, 71, 0.92)'
          : 'rgba(180, 83, 9, 0.86)';
        ctx.stroke();
        ctx.restore();

        const draftSp = toScreen(customDraftArea.center.lng, customDraftArea.center.lat);
        ctx.beginPath();
        ctx.moveTo(draftSp.x - 8, draftSp.y);
        ctx.lineTo(draftSp.x + 8, draftSp.y);
        ctx.moveTo(draftSp.x, draftSp.y - 8);
        ctx.lineTo(draftSp.x, draftSp.y + 8);
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = isSatellite ? '#fde047' : '#b45309';
        ctx.stroke();
      }
    }

    if (coverageConfig.showAccidentHotspots) {
      const baseRadius =
        zoom < 7 ? 6 : zoom < 9 ? 9.5 : zoom < 11 ? 14 : zoom < 13 ? 21 : 30;

      const hotspotSets: Array<Array<[number, number, number]>> =
        planScope === 'custom'
          ? customAreaPlan
            ? [customAreaPlan.hotspots]
            : []
          : citiesToDraw.map((c) => c.hotspots);

      ctx.beginPath();
      for (const hList of hotspotSets) {
        for (const [lng, lat, count] of hList) {
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
      for (const hList of hotspotSets) {
        for (const [lng, lat, count] of hList) {
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

    // 7.5. Crossing Event Simulation Heatmaps (clipped strictly to covered cities or custom radius circle)
    if (
      evaluatedEvents.length > 0 &&
      (simulatorConfig.showMissedHeatmap || simulatorConfig.showDetectedHeatmap)
    ) {
      const coveredCityIdSet = new Set(visibleCameras.map((c) => c.cityId));
      const baseHeatRadius =
        zoom < 6.5 ? 16 : zoom < 8.5 ? 22 : zoom < 10.5 ? 28 : zoom < 12.8 ? 34 : 42;

      ctx.save();
      ctx.beginPath();
      if (planScope === 'custom' && customAreaPlan) {
        const clipCircle = buildGeographicCircleRing(
          customAreaPlan.center,
          customAreaPlan.radiusKm * 1000,
          96
        );
        clipCircle.forEach((pt, idx) => {
          const sp = toScreen(pt.lng, pt.lat);
          if (idx === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.closePath();
      } else {
        for (const city of citiesToDraw) {
          if (!coveredCityIdSet.has(city.id)) continue;
          for (const ring of city.borderLines) {
            if (ring.length < 3) continue;
            ring.forEach(([lng, lat], idx) => {
              const pt = toScreen(lng, lat);
              if (idx === 0) ctx.moveTo(pt.x, pt.y);
              else ctx.lineTo(pt.x, pt.y);
            });
            ctx.closePath();
          }
        }
      }
      ctx.clip();

      if (simulatorConfig.showMissedHeatmap) {
        const missedSprite = getHeatmapKernel('missed', isSatellite);
        for (const ev of evaluatedEvents) {
          if (ev.detected) continue;
          const pt = toScreen(ev.lng, ev.lat);
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
          const pt = toScreen(ev.lng, ev.lat);
          const r = baseHeatRadius * (ev.animalSize === 'large' ? 1.12 : 0.88);
          if (pt.x < -r || pt.x > width + r || pt.y < -r || pt.y > height + r) {
            continue;
          }
          ctx.drawImage(detectedSprite, pt.x - r, pt.y - r, r * 2, r * 2);
        }
      }

      ctx.restore();
    }

    // 8. Planned Cameras (500 nodes) & Area Covered by Each Camera
    const metersPerPx = calculateGroundResolutionMetersPerPixel(center.lat, zoom);
    const trueCoveragePx = coverageConfig.rangeMeters / Math.max(0.05, metersPerPx);
    const minVisualCoveragePx = zoom < 6.8 ? 4.5 : zoom < 9.2 ? 7.0 : zoom < 12.2 ? 9.5 : 0;
    const effectiveRangeMeters =
      trueCoveragePx < minVisualCoveragePx
        ? minVisualCoveragePx * metersPerPx
        : coverageConfig.rangeMeters;

    if (coverageConfig.showCoverageAreas) {
      const cullMargin = Math.max(24, effectiveRangeMeters / metersPerPx + 16);
      const arcSteps = zoom >= 11.5 ? 16 : 10;
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

        const poly = computeCameraSectorPolygon(
          cam,
          effectiveRangeMeters,
          coverageConfig.fovDeg,
          arcSteps
        );
        poly.forEach((pt: LatLngPoint, idx: number) => {
          const sp = toScreen(pt.lng, pt.lat);
          if (idx === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.closePath();
      }

      ctx.fillStyle = isSatellite
        ? 'rgba(56, 189, 248, 0.25)'
        : 'rgba(8, 145, 178, 0.22)';
      ctx.strokeStyle = isSatellite
        ? 'rgba(125, 211, 252, 0.82)'
        : 'rgba(14, 116, 144, 0.74)';
      ctx.lineWidth = zoom >= 10.5 ? 1.3 : 1.0;
      ctx.fill();
      ctx.stroke();

      if (zoom >= 9.3 && coverageConfig.fovDeg < 359) {
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
          const axisTip = destinationPoint(
            { lat: cam.lat, lng: cam.lng },
            effectiveRangeMeters,
            cam.bearingDeg
          );
          const tipScreen = toScreen(axisTip.lng, axisTip.lat);
          ctx.moveTo(originScreen.x, originScreen.y);
          ctx.lineTo(tipScreen.x, tipScreen.y);
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
        const poly = computeCameraSectorPolygon(
          selectedCamForSector,
          effectiveRangeMeters,
          coverageConfig.fovDeg,
          18
        );
        ctx.beginPath();
        poly.forEach((pt: LatLngPoint, idx: number) => {
          const sp = toScreen(pt.lng, pt.lat);
          if (idx === 0) ctx.moveTo(sp.x, sp.y);
          else ctx.lineTo(sp.x, sp.y);
        });
        ctx.closePath();
        ctx.fillStyle = isSatellite
          ? 'rgba(251, 191, 36, 0.38)'
          : 'rgba(217, 119, 6, 0.28)';
        ctx.strokeStyle = isSatellite ? '#fde047' : '#b45309';
        ctx.lineWidth = 2.0;
        ctx.fill();
        ctx.stroke();

        if (coverageConfig.fovDeg < 359) {
          const axisTip = destinationPoint(
            { lat: selectedCamForSector.lat, lng: selectedCamForSector.lng },
            effectiveRangeMeters,
            selectedCamForSector.bearingDeg
          );
          const tipScreen = toScreen(axisTip.lng, axisTip.lat);
          ctx.save();
          ctx.setLineDash([3, 3]);
          ctx.beginPath();
          ctx.moveTo(originScreen.x, originScreen.y);
          ctx.lineTo(tipScreen.x, tipScreen.y);
          ctx.lineWidth = 1.6;
          ctx.strokeStyle = isSatellite ? '#fef08a' : '#92400e';
          ctx.stroke();
          ctx.restore();
        }
      }
    }

    // 9. Camera Hardware Nodes (color-coded by sector S1–S5 in full overview, or priority tier when inspecting 1 sector)
    const nodeRadius =
      zoom < 6.8
        ? 2.2
        : zoom < 9.2
          ? 3.1
          : zoom < 11.8
            ? 4.0
            : Math.min(4.8, Math.max(3.2, trueCoveragePx * 0.45));
    const isRotationalPlan =
      planScope !== 'custom' && isArrangementRotational(simulatorConfig.arrangementId);
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
      if (isRotationalPlan && selectedSector === 'all') {
        const secStyle = SECTOR_PALETTE[cam.sectorIndex];
        ctx.fillStyle = isSatellite ? secStyle.dotSat : secStyle.dotBase;
      } else {
        const tier = getCameraPriorityTier(cam.rankInSector);
        if (tier === 'critical') {
          ctx.fillStyle = isSatellite ? '#fb7185' : '#be123c';
        } else if (tier === 'high') {
          ctx.fillStyle = isSatellite ? '#38bdf8' : '#0369a1';
        } else {
          ctx.fillStyle = isSatellite ? '#2dd4bf' : '#0f766e';
        }
      }
      ctx.fill();

      if (zoom >= 8.6) {
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

    // 9.5. Individual Crossing Event Diamond Pins (zoom >= 11x or selected event)
    if (
      evaluatedEvents.length > 0 &&
      ((simulatorConfig.showEventPoints && zoom >= 11.0) || selectedCrossingEventId !== null)
    ) {
      const onlyOneLayerActive =
        simulatorConfig.showDetectedHeatmap !== simulatorConfig.showMissedHeatmap;
      let selectedEvObj: EvaluatedCrossingEvent | null = null;

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

        const sp = toScreen(ev.lng, ev.lat);
        if (sp.x < -14 || sp.x > width + 14 || sp.y < -14 || sp.y > height + 14) continue;

        const d = (ev.animalSize === 'large' ? 4.8 : 3.6) * (zoom >= 14 ? 1.2 : 1.0);
        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y - d);
        ctx.lineTo(sp.x + d, sp.y);
        ctx.lineTo(sp.x, sp.y + d);
        ctx.lineTo(sp.x - d, sp.y);
        ctx.closePath();

        ctx.fillStyle = ev.detected ? '#10b981' : '#f43f5e';
        ctx.fill();
        ctx.lineWidth = 1.3;
        ctx.strokeStyle = isSatellite ? '#0f172a' : '#ffffff';
        ctx.stroke();

        if (!ev.detected && d >= 4.0) {
          ctx.beginPath();
          ctx.arc(sp.x, sp.y, 1.1, 0, Math.PI * 2);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
        }
      }

      if (selectedEvObj) {
        const sp = toScreen(selectedEvObj.lng, selectedEvObj.lat);
        const d = 7.0;

        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y - (d + 4));
        ctx.lineTo(sp.x + (d + 4), sp.y);
        ctx.lineTo(sp.x, sp.y + (d + 4));
        ctx.lineTo(sp.x - (d + 4), sp.y);
        ctx.closePath();
        ctx.fillStyle = isSatellite ? 'rgba(251, 191, 36, 0.38)' : 'rgba(217, 119, 6, 0.30)';
        ctx.fill();

        ctx.beginPath();
        ctx.moveTo(sp.x, sp.y - d);
        ctx.lineTo(sp.x + d, sp.y);
        ctx.lineTo(sp.x, sp.y + d);
        ctx.lineTo(sp.x - d, sp.y);
        ctx.closePath();
        ctx.fillStyle = selectedEvObj.detected ? '#059669' : '#e11d48';
        ctx.fill();
        ctx.lineWidth = 2.0;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();

        const tag = `${selectedEvObj.eventId} · ${selectedEvObj.detected ? 'DETECTED' : 'MISSED'}`;
        ctx.font = '700 10.5px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = isSatellite ? 'rgba(15, 23, 42, 0.94)' : 'rgba(255, 255, 255, 0.96)';
        ctx.strokeText(tag, sp.x, sp.y + d + 6);
        ctx.fillStyle = selectedEvObj.detected
          ? isSatellite
            ? '#6ee7b7'
            : '#065f46'
          : isSatellite
            ? '#fda4af'
            : '#9f1239';
        ctx.fillText(tag, sp.x, sp.y + d + 6);
      }
    }

    // 9.8. Deployment Sector Schedule Callout Labels (S1–S5) inside each municipality
    if (coverageConfig.showDeploymentSectors && zoom >= 7.8) {
      for (const city of citiesToDraw) {
        for (const sec of city.sectors) {
          const sp = toScreen(sec.center.lng, sec.center.lat);
          if (sp.x < -70 || sp.x > width + 70 || sp.y < -40 || sp.y > height + 40) continue;
          const style = SECTOR_PALETTE[sec.sectorIndex];
          const isFocused = selectedSector === sec.sectorIndex;
          const isDimmed = selectedSector !== 'all' && !isFocused;

          ctx.textAlign = 'center';
          if (zoom < 10.3) {
            const shortTag = `S${sec.sectorIndex}`;
            ctx.font = `${isFocused ? 800 : 700} 10.5px "JetBrains Mono", monospace`;
            ctx.textBaseline = 'middle';
            ctx.lineWidth = 3.5;
            ctx.strokeStyle = isSatellite
              ? 'rgba(7, 25, 41, 0.92)'
              : 'rgba(255, 255, 255, 0.96)';
            ctx.strokeText(shortTag, sp.x, sp.y);
            ctx.fillStyle = isDimmed
              ? isSatellite
                ? 'rgba(203, 213, 225, 0.65)'
                : 'rgba(100, 116, 139, 0.72)'
              : isSatellite
                ? style.dotSat
                : style.hex;
            ctx.fillText(shortTag, sp.x, sp.y);
          } else {
            const topLine = `S${sec.sectorIndex} · ${sec.directionLabel}`;
            const subLine = sec.shortPeriod;
            ctx.font = '700 11px "Plus Jakarta Sans", sans-serif';
            ctx.textBaseline = 'bottom';
            ctx.lineWidth = 3.6;
            ctx.strokeStyle = isSatellite
              ? 'rgba(7, 25, 41, 0.94)'
              : 'rgba(255, 255, 255, 0.96)';
            ctx.strokeText(topLine, sp.x, sp.y - 1);
            ctx.fillStyle = isDimmed
              ? isSatellite
                ? 'rgba(203, 213, 225, 0.65)'
                : 'rgba(100, 116, 139, 0.75)'
              : isSatellite
                ? '#f8fafc'
                : style.hex;
            ctx.fillText(topLine, sp.x, sp.y - 1);

            ctx.font = '600 9.5px "JetBrains Mono", monospace';
            ctx.textBaseline = 'top';
            ctx.lineWidth = 3.2;
            ctx.strokeText(subLine, sp.x, sp.y + 1);
            ctx.fillStyle = isDimmed
              ? isSatellite
                ? 'rgba(148, 163, 184, 0.62)'
                : 'rgba(100, 116, 139, 0.70)'
              : isSatellite
                ? style.dotSat
                : '#334155';
            ctx.fillText(subLine, sp.x, sp.y + 1);
          }
        }
      }
    }

    ctx.restore();

    traceMaskRing();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = isSatellite ? 'rgba(148, 163, 184, 0.55)' : '#94a3b8';
    ctx.stroke();

    // 10. City Callout Labels with Leader Lines at Overview Zoom (< 9.2x)
    if (zoom < 9.2) {
      const labelOffsets: Record<string, { dx: number; dy: number; align: CanvasTextAlign }> = {
        salo: { dx: -18, dy: -6, align: 'right' },
        raasepori: { dx: 22, dy: 15, align: 'left' },
        pori: { dx: -16, dy: -10, align: 'right' },
        hameenlinna: { dx: 20, dy: 2, align: 'left' },
        sastamala: { dx: 18, dy: -16, align: 'left' },
      };

      for (const city of citiesToDraw) {
        const cp = toScreen(city.center.lng, city.center.lat);
        if (cp.x < -80 || cp.x > width + 80 || cp.y < -50 || cp.y > height + 50) continue;
        const off = labelOffsets[city.id] ?? { dx: 14, dy: -8, align: 'left' };
        const tx = cp.x + off.dx;
        const ty = cp.y + off.dy;
        const label = `#${city.rank} ${city.name} · ${city.totalAccidents.toLocaleString()}`;

        ctx.beginPath();
        ctx.moveTo(cp.x, cp.y);
        ctx.lineTo(tx + (off.align === 'right' ? 4 : -4), ty);
        ctx.lineWidth = 1.2;
        ctx.strokeStyle = isSatellite ? 'rgba(248, 250, 252, 0.65)' : 'rgba(15, 23, 42, 0.45)';
        ctx.stroke();

        ctx.font = '700 11px "Plus Jakarta Sans", sans-serif';
        ctx.textAlign = off.align;
        ctx.textBaseline = 'middle';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = isSatellite ? 'rgba(7, 25, 41, 0.92)' : 'rgba(255, 255, 255, 0.95)';
        ctx.strokeText(label, tx, ty);
        ctx.fillStyle = isSatellite ? '#f8fafc' : '#0f172a';
        ctx.fillText(label, tx, ty);
      }
    }

    // 10.5. Custom Radius Callout Label at North Perimeter
    if (planScope === 'custom' && customAreaPlan && zoom < 11.2) {
      const northRim = destinationPoint(
        customAreaPlan.center,
        customAreaPlan.radiusKm * 1000,
        0
      );
      const sp = toScreen(northRim.lng, northRim.lat);
      if (sp.x >= -120 && sp.x <= width + 120 && sp.y >= 16 && sp.y <= height - 16) {
        const label = `${customAreaPlan.label} · ${customAreaPlan.radiusKm} km · ${customAreaPlan.totalAccidentsInRadius.toLocaleString()} acc`;
        ctx.font = '700 11px "Plus Jakarta Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.lineWidth = 3.5;
        ctx.strokeStyle = isSatellite ? 'rgba(7, 25, 41, 0.92)' : 'rgba(255, 255, 255, 0.96)';
        ctx.strokeText(label, sp.x, sp.y - 6);
        ctx.fillStyle = isSatellite ? '#bae6fd' : '#0369a1';
        ctx.fillText(label, sp.x, sp.y - 6);
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
    coverageConfig,
    customAreaPlan,
    customDraftArea,
    evaluatedEvents,
    getHeatmapKernel,
    isPickingCustomCenter,
    mode,
    planScope,
    requestTile,
    selectedCameraId,
    selectedCityId,
    selectedCrossingEventId,
    selectedSector,
    showGraticule,
    showLabels,
    showTerrain,
    simulatorConfig,
    visibleCameras,
    visibleCities,
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
    camera,
    mode,
    mapTypeId,
    showLabels,
    showTerrain,
    showGraticule,
    selectedCityId,
    selectedSector,
    selectedCameraId,
    selectedCrossingEventId,
    coverageConfig,
    customAreaPlan,
    customDraftArea,
    evaluatedEvents,
    isPickingCustomCenter,
    planScope,
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
    onCursorMove(isPointWithinFinlandBounds(cursorLatLng) ? cursorLatLng : null);

    if (!dragStateRef.current.active || dragStateRef.current.pointerId !== e.pointerId) {
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

    if (!wasTap) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    const cur = cameraRef.current;
    const centerWorld = latLngToWorldPixel(cur.center, cur.zoom);
    const topLeftX = centerWorld.x - rect.width / 2;
    const topLeftY = centerWorld.y - rect.height / 2;

    if (isPickingCustomCenterRef.current && onPickCustomCenterRef.current) {
      const clickedPoint = worldPixelToLatLng(
        { x: topLeftX + clickX, y: topLeftY + clickY },
        cur.zoom
      );
      if (isPointWithinFinlandBounds(clickedPoint)) {
        onPickCustomCenterRef.current({
          lat: Number(clickedPoint.lat.toFixed(4)),
          lng: Number(clickedPoint.lng.toFixed(4)),
        });
      }
      return;
    }

    if (cur.zoom >= 8.2) {
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
        let nearestEv: EvaluatedCrossingEvent | null = null;
        let nearestEvDist = 12;
        for (const ev of evaluatedEventsRef.current) {
          const wp = latLngToWorldPixel({ lat: ev.lat, lng: ev.lng }, cur.zoom);
          const sx = wp.x - topLeftX;
          const sy = wp.y - topLeftY;
          const d = Math.hypot(sx - clickX, sy - clickY);
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

    if (
      planScopeRef.current !== 'custom' &&
      cur.zoom >= 7.8 &&
      coverageConfigRef.current.showDeploymentSectors
    ) {
      let nearestSecIndex: SectorFilter | null = null;
      let nearestSecDist = 24;
      for (const city of TOP_5_WILDLIFE_ACCIDENT_CITIES) {
        for (const sec of city.sectors) {
          const wp = latLngToWorldPixel(sec.center, cur.zoom);
          const sx = wp.x - topLeftX;
          const sy = wp.y - topLeftY;
          const d = Math.hypot(sx - clickX, sy - clickY);
          if (d <= nearestSecDist) {
            nearestSecDist = d;
            nearestSecIndex = sec.sectorIndex;
          }
        }
      }
      if (nearestSecIndex !== null) {
        onSelectSector(
          selectedSectorRef.current === nearestSecIndex ? 'all' : nearestSecIndex
        );
        return;
      }
    }

    if (planScopeRef.current !== 'custom' && cur.zoom < 8.2) {
      let nearestCity: CityCameraPlan | null = null;
      let nearestCityDist = 32;
      for (const city of TOP_5_WILDLIFE_ACCIDENT_CITIES) {
        const wp = latLngToWorldPixel(city.center, cur.zoom);
        const sx = wp.x - topLeftX;
        const sy = wp.y - topLeftY;
        const d = Math.hypot(sx - clickX, sy - clickY);
        if (d <= nearestCityDist) {
          nearestCityDist = d;
          nearestCity = city;
        }
      }
      if (nearestCity) {
        onSelectCity(nearestCity);
        return;
      }
    }
  };

  const handlePointerCancel = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragStateRef.current.pointerId === e.pointerId) {
      dragStateRef.current.active = false;
      dragStateRef.current.pointerId = -1;
    }
  };

  const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
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
      aria-label={`Interactive Finland map in ${mode === 'satellite' ? 'Satellite' : 'Base Map'} mode at zoom ${camera.zoom.toFixed(1)} showing ${visibleCameras.length} planned wildlife cameras`}
      data-testid="finland-map-canvas"
      data-map-mode={mode}
      data-map-type={mapTypeId}
      data-zoom={camera.zoom.toFixed(2)}
      data-camera-count={visibleCameras.length}
      data-selected-sector={String(selectedSector)}
      data-selected-year={String(simulatorConfig.selectedYear)}
      data-arrangement={simulatorConfig.arrangementId}
      data-sim-events={evaluatedEvents.length}
      data-plan-scope={planScope}
      data-picking-center={isPickingCustomCenter ? 'true' : 'false'}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={() => {
        onCursorMove(null);
      }}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      className={`w-full h-full relative outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sky-600 select-none touch-none ${
        isPickingCustomCenter ? 'cursor-crosshair' : 'cursor-grab active:cursor-grabbing'
      }`}
    >
      <canvas ref={canvasRef} className="w-full h-full block" />
    </div>
  );
}
