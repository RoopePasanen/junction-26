import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AdvancedMarker,
  APIProvider,
  Map as GoogleMap,
  useMap,
  useMapsLibrary,
  type MapCameraChangedEvent,
  type MapMouseEvent,
} from '@vis.gl/react-google-maps';
import type { PlannedCameraNode } from '../data/finlandWildlifePlan';
import {
  computeCameraCoveragePolygons,
  getCameraPriorityTier,
  type CameraCoverageConfig,
} from '../utils/cameraPlanGeometry';
import {
  type EvaluatedCrossingEvent,
  type SimulatorConfig,
} from '../utils/crossingSimulator';
import type {
  CustomAreaPlanResult,
  DrawingToolMode,
} from '../types/customAreaPlan';
import {
  polygonsApproximatelyEqual,
  simplifyLatLngRing,
} from '../utils/polygonGeometry';
import {
  clampCamera,
  FINLAND_GEOGRAPHIC_BOUNDS,
  FINLAND_VIEWPORT_BOUNDS,
  isPointWithinFinlandBounds,
  latLngToWorldPixel,
  MAX_ZOOM,
  MIN_ZOOM,
  worldPixelToLatLng,
  type CameraState,
  type GoogleMapTypeId,
  type LatLngPoint,
} from '../utils/mapMath';

interface GoogleFinlandMapProps {
  apiKey: string;
  camera: CameraState;
  mapTypeId: GoogleMapTypeId;
  areasOfInterest: CustomAreaPlanResult[];
  selectedAreaId: string | null;
  selectedCameraId: string | null;
  coverageConfig: CameraCoverageConfig;
  visibleCameras: PlannedCameraNode[];
  evaluatedEvents: EvaluatedCrossingEvent[];
  simulatorConfig: SimulatorConfig;
  drawingMode?: DrawingToolMode;
  drawnPolygon?: LatLngPoint[];
  draftPolygonVertices?: LatLngPoint[];
  onCameraChange: (next: CameraState) => void;
  onCursorMove: (point: LatLngPoint | null) => void;
  onSelectCamera: (camera: PlannedCameraNode | null) => void;
  onSelectArea: (area: CustomAreaPlanResult) => void;
  onCompletePolygon?: (polygon: LatLngPoint[]) => void;
  onAddDraftVertex?: (point: LatLngPoint) => void;
  onAuthError: () => void;
}

interface GoogleCameraPlanOverlaysProps {
  zoom: number;
  areasOfInterest: CustomAreaPlanResult[];
  selectedAreaId: string | null;
  visibleCameras: PlannedCameraNode[];
  selectedCameraId: string | null;
  coverageConfig: CameraCoverageConfig;
  evaluatedEvents: EvaluatedCrossingEvent[];
  simulatorConfig: SimulatorConfig;
  drawingMode: DrawingToolMode;
  drawnPolygon: LatLngPoint[];
  draftPolygonVertices: LatLngPoint[];
  liveFreehandPoints: LatLngPoint[];
  onSelectCamera: (camera: PlannedCameraNode) => void;
  onSelectArea: (area: CustomAreaPlanResult) => void;
}

interface DetachableMapOverlay {
  setMap: (map: null) => void;
}

function GoogleCameraPlanOverlays({
  zoom,
  areasOfInterest,
  selectedAreaId,
  visibleCameras,
  selectedCameraId,
  coverageConfig,
  evaluatedEvents,
  simulatorConfig,
  drawingMode,
  drawnPolygon,
  draftPolygonVertices,
  liveFreehandPoints,
  onSelectCamera,
  onSelectArea,
}: GoogleCameraPlanOverlaysProps) {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');
  const customAreaPolygonsRef = useRef<DetachableMapOverlay[]>([]);
  const hotspotCirclesRef = useRef<DetachableMapOverlay[]>([]);
  const simHeatCirclesRef = useRef<DetachableMapOverlay[]>([]);
  const polygonsRef = useRef<DetachableMapOverlay[]>([]);

  useEffect(() => {
    customAreaPolygonsRef.current.forEach((c: DetachableMapOverlay) => c.setMap(null));
    customAreaPolygonsRef.current = [];
    if (!map || !mapsLib) {
      return;
    }

    const created: DetachableMapOverlay[] = [];

    for (const area of areasOfInterest) {
      if (area.polygon.length < 3) continue;
      const isSelected = area.id === selectedAreaId;
      const poly = new mapsLib.Polygon({
        map,
        paths: area.polygon,
        fillColor: '#0284c7',
        fillOpacity: coverageConfig.showCityBoundaries ? (isSelected ? 0.1 : 0.06) : 0,
        strokeColor: '#0284c7',
        strokeOpacity: isSelected ? 0.95 : 0.78,
        strokeWeight: isSelected ? 2.4 : 1.8,
        clickable: drawingMode === 'none',
      });
      if (drawingMode === 'none') {
        poly.addListener('click', () => {
          onSelectArea(area);
        });
      }
      created.push(poly);
    }

    const matchesExistingArea = areasOfInterest.some((a) =>
      polygonsApproximatelyEqual(drawnPolygon, a.polygon)
    );

    if (drawnPolygon.length >= 3 && drawingMode === 'none' && !matchesExistingArea) {
      created.push(
        new mapsLib.Polygon({
          map,
          paths: drawnPolygon,
          fillColor: '#d97706',
          fillOpacity: 0.09,
          strokeColor: '#b45309',
          strokeOpacity: 0.9,
          strokeWeight: 2,
          clickable: false,
        })
      );
    }

    if (drawingMode === 'polygon' && draftPolygonVertices.length >= 2) {
      created.push(
        new mapsLib.Polyline({
          map,
          path: draftPolygonVertices,
          strokeColor: '#d97706',
          strokeOpacity: 0.95,
          strokeWeight: 2.2,
          clickable: false,
        })
      );
    }

    if (drawingMode === 'freehand' && liveFreehandPoints.length >= 2) {
      created.push(
        new mapsLib.Polygon({
          map,
          paths: liveFreehandPoints,
          fillColor: '#d97706',
          fillOpacity: 0.12,
          strokeColor: '#d97706',
          strokeOpacity: 0.95,
          strokeWeight: 2.2,
          clickable: false,
        })
      );
    }

    customAreaPolygonsRef.current = created;
    return () => {
      created.forEach((c: DetachableMapOverlay) => c.setMap(null));
    };
  }, [
    areasOfInterest,
    coverageConfig.showCityBoundaries,
    draftPolygonVertices,
    drawingMode,
    drawnPolygon,
    liveFreehandPoints,
    map,
    mapsLib,
    onSelectArea,
    selectedAreaId,
  ]);

  useEffect(() => {
    hotspotCirclesRef.current.forEach((c: DetachableMapOverlay) => c.setMap(null));
    hotspotCirclesRef.current = [];

    if (!map || !mapsLib || !coverageConfig.showAccidentHotspots || areasOfInterest.length === 0) {
      return;
    }

    const created: DetachableMapOverlay[] = [];

    for (const area of areasOfInterest) {
      for (const [lng, lat, count] of area.hotspots) {
        const circle = new mapsLib.Circle({
          map,
          center: { lat, lng },
          radius: Math.min(950, 260 + count * 18),
          fillColor: '#dc2626',
          fillOpacity: Math.min(0.42, 0.14 + Math.log1p(count) * 0.07),
          strokeWeight: 0,
          clickable: false,
        });
        created.push(circle);
      }
    }
    hotspotCirclesRef.current = created;

    return () => {
      created.forEach((c: DetachableMapOverlay) => c.setMap(null));
    };
  }, [areasOfInterest, coverageConfig.showAccidentHotspots, map, mapsLib]);

  useEffect(() => {
    polygonsRef.current.forEach((p: DetachableMapOverlay) => p.setMap(null));
    polygonsRef.current = [];

    if (!map || !mapsLib || !coverageConfig.showCoverageAreas) {
      return;
    }

    const created: DetachableMapOverlay[] = [];
    for (const cam of visibleCameras) {
      const isSelected = cam.id === selectedCameraId;
      const paths = computeCameraCoveragePolygons(
        cam,
        coverageConfig.rangeMeters,
        coverageConfig.fovDeg,
        12
      );
      for (const path of paths) {
        const polygon = new mapsLib.Polygon({
          map,
          paths: path,
          fillColor: isSelected ? '#d97706' : '#0891b2',
          fillOpacity: isSelected ? 0.36 : 0.25,
          strokeColor: isSelected ? '#b45309' : '#0e7490',
          strokeOpacity: 0.85,
          strokeWeight: isSelected ? 2 : 1.2,
          clickable: drawingMode === 'none',
        });
        if (drawingMode === 'none') {
          polygon.addListener('click', () => {
            onSelectCamera(cam);
          });
        }
        created.push(polygon);
      }
    }
    polygonsRef.current = created;

    return () => {
      created.forEach((p: DetachableMapOverlay) => p.setMap(null));
    };
  }, [
    coverageConfig.fovDeg,
    coverageConfig.rangeMeters,
    coverageConfig.showCoverageAreas,
    drawingMode,
    map,
    mapsLib,
    onSelectCamera,
    selectedCameraId,
    visibleCameras,
    zoom,
  ]);

  useEffect(() => {
    simHeatCirclesRef.current.forEach((c: DetachableMapOverlay) => c.setMap(null));
    simHeatCirclesRef.current = [];

    if (
      !map ||
      !mapsLib ||
      evaluatedEvents.length === 0 ||
      (!simulatorConfig.showDetectedHeatmap &&
        !simulatorConfig.showMissedHeatmap &&
        !(simulatorConfig.showEventPoints && zoom >= 11.0))
    ) {
      return;
    }

    const onlyOneLayerActive =
      simulatorConfig.showDetectedHeatmap !== simulatorConfig.showMissedHeatmap;
    const created: DetachableMapOverlay[] = [];
    for (const ev of evaluatedEvents) {
      const showHeatForEvent =
        (ev.detected && simulatorConfig.showDetectedHeatmap) ||
        (!ev.detected && simulatorConfig.showMissedHeatmap);

      if (showHeatForEvent) {
        const heatLat = ev.hasRoadCrossingLine ? ev.roadLat : ev.lat;
        const heatLng = ev.hasRoadCrossingLine ? ev.roadLng : ev.lng;
        const circle = new mapsLib.Circle({
          map,
          center: { lat: heatLat, lng: heatLng },
          radius: ev.animalSize === 'large' ? 420 : 310,
          fillColor: ev.detected ? '#10b981' : '#e11d48',
          fillOpacity: 0.28,
          strokeWeight: 0,
          clickable: false,
        });
        created.push(circle);
      }

      const passPointFilter =
        !onlyOneLayerActive ||
        (ev.detected && simulatorConfig.showDetectedHeatmap) ||
        (!ev.detected && simulatorConfig.showMissedHeatmap);

      if (
        passPointFilter &&
        simulatorConfig.showEventPoints &&
        zoom >= 11.0 &&
        ev.hasRoadCrossingLine
      ) {
        created.push(
          new mapsLib.Polyline({
            map,
            path: [
              { lat: ev.crossingStartLat, lng: ev.crossingStartLng },
              { lat: ev.crossingEndLat, lng: ev.crossingEndLng },
            ],
            strokeColor: ev.detected ? '#059669' : '#e11d48',
            strokeOpacity: 0.9,
            strokeWeight: 2.2,
            clickable: false,
          })
        );
      }
    }
    simHeatCirclesRef.current = created;

    return () => {
      created.forEach((c: DetachableMapOverlay) => c.setMap(null));
    };
  }, [
    evaluatedEvents,
    map,
    mapsLib,
    simulatorConfig.showDetectedHeatmap,
    simulatorConfig.showEventPoints,
    simulatorConfig.showMissedHeatmap,
    zoom,
  ]);

  return null;
}

export function GoogleFinlandMap({
  apiKey,
  camera,
  mapTypeId,
  areasOfInterest,
  selectedAreaId,
  selectedCameraId,
  coverageConfig,
  visibleCameras,
  evaluatedEvents,
  simulatorConfig,
  drawingMode = 'none',
  drawnPolygon = [],
  draftPolygonVertices = [],
  onCameraChange,
  onCursorMove,
  onSelectCamera,
  onSelectArea,
  onCompletePolygon,
  onAddDraftVertex,
  onAuthError,
}: GoogleFinlandMapProps) {
  const [liveFreehandPoints, setLiveFreehandPoints] = useState<LatLngPoint[]>([]);
  const freehandActiveRef = useRef<boolean>(false);
  const freehandPointsRef = useRef<LatLngPoint[]>([]);

  useEffect(() => {
    const win = window as Window & { gm_authFailure?: () => void };
    const prevHandler = win.gm_authFailure;
    win.gm_authFailure = () => {
      prevHandler?.();
      onAuthError();
    };
    return () => {
      win.gm_authFailure = prevHandler;
    };
  }, [onAuthError]);

  const handleCameraChanged = useCallback(
    (ev: MapCameraChangedEvent) => {
      const next = clampCamera({
        center: ev.detail.center,
        zoom: ev.detail.zoom,
      });
      onCameraChange(next);
    },
    [onCameraChange]
  );

  const handleMouseMove = useCallback(
    (ev: MapMouseEvent) => {
      if (ev.detail.latLng && isPointWithinFinlandBounds(ev.detail.latLng)) {
        onCursorMove(ev.detail.latLng);
      } else {
        onCursorMove(null);
      }
    },
    [onCursorMove]
  );

  const handleMouseOut = useCallback(() => {
    onCursorMove(null);
  }, [onCursorMove]);

  const handleMapClick = useCallback(
    (ev: MapMouseEvent) => {
      if (drawingMode !== 'polygon' || !ev.detail.latLng) return;
      if (isPointWithinFinlandBounds(ev.detail.latLng)) {
        onAddDraftVertex?.({
          lat: Number(ev.detail.latLng.lat.toFixed(5)),
          lng: Number(ev.detail.latLng.lng.toFixed(5)),
        });
      }
    },
    [drawingMode, onAddDraftVertex]
  );

  const screenEventToLatLng = (
    e: React.PointerEvent<HTMLDivElement>
  ): LatLngPoint => {
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetX = e.clientX - (rect.left + rect.width / 2);
    const offsetY = e.clientY - (rect.top + rect.height / 2);
    const centerWorld = latLngToWorldPixel(camera.center, camera.zoom);
    const raw = worldPixelToLatLng(
      { x: centerWorld.x + offsetX, y: centerWorld.y + offsetY },
      camera.zoom
    );
    return {
      lat: Number(
        Math.max(
          FINLAND_GEOGRAPHIC_BOUNDS.south,
          Math.min(FINLAND_GEOGRAPHIC_BOUNDS.north, raw.lat)
        ).toFixed(5)
      ),
      lng: Number(
        Math.max(
          FINLAND_GEOGRAPHIC_BOUNDS.west,
          Math.min(FINLAND_GEOGRAPHIC_BOUNDS.east, raw.lng)
        ).toFixed(5)
      ),
    };
  };

  return (
    <APIProvider apiKey={apiKey} language="en" region="FI" libraries={['marker']}>
      <div className="w-full h-full relative">
        <GoogleMap
          mapId="DEMO_MAP_ID"
          center={camera.center}
          zoom={camera.zoom}
          mapTypeId={mapTypeId}
          minZoom={MIN_ZOOM}
          maxZoom={MAX_ZOOM}
          restriction={{
            latLngBounds: FINLAND_VIEWPORT_BOUNDS,
            strictBounds: true,
          }}
          gestureHandling={drawingMode === 'freehand' ? 'none' : 'greedy'}
          disableDefaultUI={true}
          clickableIcons={false}
          draggableCursor={drawingMode !== 'none' ? 'crosshair' : undefined}
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          onCameraChanged={handleCameraChanged}
          onClick={handleMapClick}
          onMousemove={handleMouseMove}
          onMouseout={handleMouseOut}
          style={{ width: '100%', height: '100%' }}
        >
          <GoogleCameraPlanOverlays
            zoom={camera.zoom}
            areasOfInterest={areasOfInterest}
            selectedAreaId={selectedAreaId}
            visibleCameras={visibleCameras}
            selectedCameraId={selectedCameraId}
            coverageConfig={coverageConfig}
            evaluatedEvents={evaluatedEvents}
            simulatorConfig={simulatorConfig}
            drawingMode={drawingMode}
            drawnPolygon={drawnPolygon}
            draftPolygonVertices={draftPolygonVertices}
            liveFreehandPoints={liveFreehandPoints}
            onSelectCamera={onSelectCamera}
            onSelectArea={onSelectArea}
          />

          {visibleCameras.map((cam) => {
            const isSelected = cam.id === selectedCameraId;
            const tier = getCameraPriorityTier(cam.rankInCity);
            const dotColor = isSelected
              ? 'h-3.5 w-3.5 bg-amber-600 ring-2 ring-amber-400'
              : tier === 'critical'
                ? 'h-2.5 w-2.5 bg-rose-700'
                : tier === 'high'
                  ? 'h-2.5 w-2.5 bg-sky-700'
                  : 'h-2.5 w-2.5 bg-teal-700';
            return (
              <AdvancedMarker
                key={cam.id}
                position={{ lat: cam.lat, lng: cam.lng }}
                onClick={() => onSelectCamera(cam)}
                title={`${cam.id} (${cam.cityName} · ${cam.roadLabel}) — ${cam.historicalAccidents} collisions`}
              >
                <span className={`block rounded-full border border-white ${dotColor}`} />
              </AdvancedMarker>
            );
          })}
        </GoogleMap>

        {drawingMode === 'freehand' && (
          <div
            aria-label="Freehand area drawing surface"
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              freehandActiveRef.current = true;
              const pt = screenEventToLatLng(e);
              freehandPointsRef.current = [pt];
              setLiveFreehandPoints([pt]);
            }}
            onPointerMove={(e) => {
              const pt = screenEventToLatLng(e);
              onCursorMove(pt);
              if (!freehandActiveRef.current) return;
              freehandPointsRef.current.push(pt);
              setLiveFreehandPoints([...freehandPointsRef.current]);
            }}
            onPointerUp={() => {
              freehandActiveRef.current = false;
              const raw = freehandPointsRef.current;
              freehandPointsRef.current = [];
              setLiveFreehandPoints([]);
              if (raw.length >= 3) {
                const simplified = simplifyLatLngRing(raw);
                if (simplified.length >= 3) {
                  onCompletePolygon?.(simplified);
                }
              }
            }}
            className="absolute inset-0 z-10 cursor-crosshair touch-none"
          />
        )}
      </div>
    </APIProvider>
  );
}
