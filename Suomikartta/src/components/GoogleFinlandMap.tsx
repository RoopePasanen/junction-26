import { useCallback, useEffect, useRef } from 'react';
import {
  AdvancedMarker,
  APIProvider,
  Map as GoogleMap,
  useMap,
  useMapsLibrary,
  type MapCameraChangedEvent,
  type MapMouseEvent,
} from '@vis.gl/react-google-maps';
import {
  TOP_5_WILDLIFE_ACCIDENT_CITIES,
  type CityCameraPlan,
  type PlannedCameraNode,
  type SectorFilter,
} from '../data/finlandWildlifePlan';
import {
  buildCameraCoveragePolygon,
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
  clampCamera,
  FINLAND_VIEWPORT_BOUNDS,
  isPointWithinFinlandBounds,
  MAX_ZOOM,
  MIN_ZOOM,
  type CameraState,
  type GoogleMapTypeId,
  type LatLngPoint,
} from '../utils/mapMath';

interface GoogleFinlandMapProps {
  apiKey: string;
  camera: CameraState;
  mapTypeId: GoogleMapTypeId;
  selectedCityId: string;
  selectedSector: SectorFilter;
  selectedCameraId: string | null;
  coverageConfig: CameraCoverageConfig;
  visibleCameras: PlannedCameraNode[];
  evaluatedEvents: EvaluatedCrossingEvent[];
  simulatorConfig: SimulatorConfig;
  planScope?: PlanScopeMode;
  customAreaPlan?: CustomAreaPlanResult | null;
  customDraftArea?: { center: LatLngPoint; radiusKm: number; label: string } | null;
  isPickingCustomCenter?: boolean;
  onCameraChange: (next: CameraState) => void;
  onCursorMove: (point: LatLngPoint | null) => void;
  onSelectCamera: (camera: PlannedCameraNode | null) => void;
  onSelectCity: (city: CityCameraPlan) => void;
  onSelectSector: (sector: SectorFilter) => void;
  onPickCustomCenter?: (point: LatLngPoint) => void;
  onAuthError: () => void;
}

interface GoogleCameraPlanOverlaysProps {
  zoom: number;
  visibleCities: CityCameraPlan[];
  visibleCameras: PlannedCameraNode[];
  selectedCityId: string;
  selectedSector: SectorFilter;
  selectedCameraId: string | null;
  coverageConfig: CameraCoverageConfig;
  evaluatedEvents: EvaluatedCrossingEvent[];
  simulatorConfig: SimulatorConfig;
  planScope: PlanScopeMode;
  customAreaPlan: CustomAreaPlanResult | null;
  customDraftArea: { center: LatLngPoint; radiusKm: number; label: string } | null;
  isPickingCustomCenter: boolean;
  onSelectCamera: (camera: PlannedCameraNode) => void;
  onSelectSector: (sector: SectorFilter) => void;
}

interface DetachableMapOverlay {
  setMap: (map: null) => void;
}

function GoogleCameraPlanOverlays({
  zoom,
  visibleCities,
  visibleCameras,
  selectedCityId,
  selectedSector,
  selectedCameraId,
  coverageConfig,
  evaluatedEvents,
  simulatorConfig,
  planScope,
  customAreaPlan,
  customDraftArea,
  isPickingCustomCenter,
  onSelectCamera,
  onSelectSector,
}: GoogleCameraPlanOverlaysProps) {
  const map = useMap();
  const mapsLib = useMapsLibrary('maps');
  const borderPolylinesRef = useRef<DetachableMapOverlay[]>([]);
  const customAreaCirclesRef = useRef<DetachableMapOverlay[]>([]);
  const sectorPolygonsRef = useRef<DetachableMapOverlay[]>([]);
  const hotspotCirclesRef = useRef<DetachableMapOverlay[]>([]);
  const simHeatCirclesRef = useRef<DetachableMapOverlay[]>([]);
  const polygonsRef = useRef<DetachableMapOverlay[]>([]);

  useEffect(() => {
    customAreaCirclesRef.current.forEach((c: DetachableMapOverlay) => c.setMap(null));
    customAreaCirclesRef.current = [];
    if (!map || !mapsLib || (planScope !== 'custom' && !isPickingCustomCenter)) {
      return;
    }
    const created: DetachableMapOverlay[] = [];
    if (customAreaPlan) {
      created.push(
        new mapsLib.Circle({
          map,
          center: customAreaPlan.center,
          radius: customAreaPlan.radiusKm * 1000,
          fillColor: '#0284c7',
          fillOpacity: coverageConfig.showCityBoundaries ? 0.06 : 0,
          strokeColor: '#0284c7',
          strokeOpacity: 0.9,
          strokeWeight: 2,
          clickable: false,
        })
      );
    }
    if (
      customDraftArea &&
      (!customAreaPlan ||
        Math.abs(customDraftArea.center.lat - customAreaPlan.center.lat) > 0.0004 ||
        Math.abs(customDraftArea.center.lng - customAreaPlan.center.lng) > 0.0004 ||
        Math.abs(customDraftArea.radiusKm - customAreaPlan.radiusKm) > 0.05 ||
        isPickingCustomCenter)
    ) {
      created.push(
        new mapsLib.Circle({
          map,
          center: customDraftArea.center,
          radius: customDraftArea.radiusKm * 1000,
          fillColor: '#d97706',
          fillOpacity: 0.06,
          strokeColor: '#b45309',
          strokeOpacity: 0.85,
          strokeWeight: 1.8,
          clickable: false,
        })
      );
    }
    customAreaCirclesRef.current = created;
    return () => {
      created.forEach((c: DetachableMapOverlay) => c.setMap(null));
    };
  }, [
    coverageConfig.showCityBoundaries,
    customAreaPlan,
    customDraftArea,
    isPickingCustomCenter,
    map,
    mapsLib,
    planScope,
  ]);

  useEffect(() => {
    sectorPolygonsRef.current.forEach((p: DetachableMapOverlay) => p.setMap(null));
    sectorPolygonsRef.current = [];

    if (!map || !mapsLib || !coverageConfig.showDeploymentSectors) {
      return;
    }

    const created: DetachableMapOverlay[] = [];
    for (const city of visibleCities) {
      for (const sec of city.sectors) {
        if (sec.voronoiRing.length < 3) continue;
        const style = SECTOR_PALETTE[sec.sectorIndex];
        const isFocused = selectedSector === sec.sectorIndex;
        const isDimmed = selectedSector !== 'all' && !isFocused;
        const polygon = new mapsLib.Polygon({
          map,
          paths: sec.voronoiRing.map(([lng, lat]) => ({ lat, lng })),
          fillColor: isDimmed ? '#94a3b8' : style.hex,
          fillOpacity: isDimmed ? 0.04 : isFocused ? 0.22 : 0.11,
          strokeColor: isDimmed ? '#94a3b8' : style.hex,
          strokeOpacity: isDimmed ? 0.35 : 0.78,
          strokeWeight: isFocused ? 2.2 : 1.3,
          clickable: true,
        });
        polygon.addListener('click', () => {
          onSelectSector(selectedSector === sec.sectorIndex ? 'all' : sec.sectorIndex);
        });
        created.push(polygon);
      }
    }
    sectorPolygonsRef.current = created;

    return () => {
      created.forEach((p: DetachableMapOverlay) => p.setMap(null));
    };
  }, [
    coverageConfig.showDeploymentSectors,
    map,
    mapsLib,
    onSelectSector,
    selectedSector,
    visibleCities,
  ]);

  useEffect(() => {
    borderPolylinesRef.current.forEach((p: DetachableMapOverlay) => p.setMap(null));
    borderPolylinesRef.current = [];

    if (!map || !mapsLib || !coverageConfig.showCityBoundaries) {
      return;
    }

    const created: DetachableMapOverlay[] = [];
    for (const city of visibleCities) {
      for (const ring of city.borderLines) {
        const poly = new mapsLib.Polyline({
          map,
          path: ring.map(([lng, lat]) => ({ lat, lng })),
          strokeColor: '#0284c7',
          strokeOpacity: 0.85,
          strokeWeight: selectedCityId === city.id ? 2.2 : 1.6,
          clickable: false,
        });
        created.push(poly);
      }
    }
    borderPolylinesRef.current = created;

    return () => {
      created.forEach((p: DetachableMapOverlay) => p.setMap(null));
    };
  }, [coverageConfig.showCityBoundaries, map, mapsLib, selectedCityId, visibleCities]);

  useEffect(() => {
    hotspotCirclesRef.current.forEach((c: DetachableMapOverlay) => c.setMap(null));
    hotspotCirclesRef.current = [];

    if (!map || !mapsLib || !coverageConfig.showAccidentHotspots) {
      return;
    }

    const created: DetachableMapOverlay[] = [];
    const hotspotLists =
      planScope === 'custom'
        ? customAreaPlan
          ? [customAreaPlan.hotspots]
          : []
        : visibleCities.map((c) => c.hotspots);

    for (const hList of hotspotLists) {
      for (const [lng, lat, count] of hList) {
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
  }, [coverageConfig.showAccidentHotspots, customAreaPlan, map, mapsLib, planScope, visibleCities]);

  useEffect(() => {
    polygonsRef.current.forEach((p: DetachableMapOverlay) => p.setMap(null));
    polygonsRef.current = [];

    if (!map || !mapsLib || !coverageConfig.showCoverageAreas) {
      return;
    }

    const created: DetachableMapOverlay[] = [];
    for (const cam of visibleCameras) {
      const isSelected = cam.id === selectedCameraId;
      const path = buildCameraCoveragePolygon(
        { lat: cam.lat, lng: cam.lng },
        cam.bearingDeg,
        coverageConfig.rangeMeters,
        coverageConfig.fovDeg,
        12
      );
      const polygon = new mapsLib.Polygon({
        map,
        paths: path,
        fillColor: isSelected ? '#d97706' : '#0891b2',
        fillOpacity: isSelected ? 0.36 : 0.25,
        strokeColor: isSelected ? '#b45309' : '#0e7490',
        strokeOpacity: 0.85,
        strokeWeight: isSelected ? 2 : 1.2,
        clickable: true,
      });
      polygon.addListener('click', () => {
        onSelectCamera(cam);
      });
      created.push(polygon);
    }
    polygonsRef.current = created;

    return () => {
      created.forEach((p: DetachableMapOverlay) => p.setMap(null));
    };
  }, [
    coverageConfig.fovDeg,
    coverageConfig.rangeMeters,
    coverageConfig.showCoverageAreas,
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
      (!simulatorConfig.showDetectedHeatmap && !simulatorConfig.showMissedHeatmap)
    ) {
      return;
    }

    const created: DetachableMapOverlay[] = [];
    for (const ev of evaluatedEvents) {
      if (ev.detected && !simulatorConfig.showDetectedHeatmap) continue;
      if (!ev.detected && !simulatorConfig.showMissedHeatmap) continue;
      const circle = new mapsLib.Circle({
        map,
        center: { lat: ev.lat, lng: ev.lng },
        radius: ev.animalSize === 'large' ? 420 : 310,
        fillColor: ev.detected ? '#10b981' : '#e11d48',
        fillOpacity: 0.28,
        strokeWeight: 0,
        clickable: false,
      });
      created.push(circle);
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
    simulatorConfig.showMissedHeatmap,
  ]);

  return null;
}

export function GoogleFinlandMap({
  apiKey,
  camera,
  mapTypeId,
  selectedCityId,
  selectedSector,
  selectedCameraId,
  coverageConfig,
  visibleCameras,
  evaluatedEvents,
  simulatorConfig,
  planScope = 'top5',
  customAreaPlan = null,
  customDraftArea = null,
  isPickingCustomCenter = false,
  onCameraChange,
  onCursorMove,
  onSelectCamera,
  onSelectCity,
  onSelectSector,
  onPickCustomCenter,
  onAuthError,
}: GoogleFinlandMapProps) {
  const visibleCities = planScope === 'custom' ? [] : TOP_5_WILDLIFE_ACCIDENT_CITIES;
  const isRotationalPlan =
    planScope !== 'custom' && isArrangementRotational(simulatorConfig.arrangementId);

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
      if (!isPickingCustomCenter || !onPickCustomCenter || !ev.detail.latLng) return;
      if (isPointWithinFinlandBounds(ev.detail.latLng)) {
        onPickCustomCenter({
          lat: Number(ev.detail.latLng.lat.toFixed(4)),
          lng: Number(ev.detail.latLng.lng.toFixed(4)),
        });
      }
    },
    [isPickingCustomCenter, onPickCustomCenter]
  );

  const showIndividualMarkers = planScope === 'custom' || camera.zoom >= 8.5;

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
          gestureHandling="greedy"
          disableDefaultUI={true}
          clickableIcons={false}
          draggableCursor={isPickingCustomCenter ? 'crosshair' : undefined}
          internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
          onCameraChanged={handleCameraChanged}
          onClick={handleMapClick}
          onMousemove={handleMouseMove}
          onMouseout={handleMouseOut}
          style={{ width: '100%', height: '100%' }}
        >
          <GoogleCameraPlanOverlays
            zoom={camera.zoom}
            visibleCities={visibleCities}
            visibleCameras={visibleCameras}
            selectedCityId={selectedCityId}
            selectedSector={selectedSector}
            selectedCameraId={selectedCameraId}
            coverageConfig={coverageConfig}
            evaluatedEvents={evaluatedEvents}
            simulatorConfig={simulatorConfig}
            planScope={planScope}
            customAreaPlan={customAreaPlan}
            customDraftArea={customDraftArea}
            isPickingCustomCenter={isPickingCustomCenter}
            onSelectCamera={onSelectCamera}
            onSelectSector={onSelectSector}
          />

          {!showIndividualMarkers
            ? visibleCities.map((city) => (
                <AdvancedMarker
                  key={city.id}
                  position={city.center}
                  onClick={() => onSelectCity(city)}
                  title={`${city.name}: ${city.totalAccidents.toLocaleString('en-US')} wildlife collisions · 5 sectors × 100 cameras`}
                >
                  <button
                    type="button"
                    onClick={() => onSelectCity(city)}
                    className="rounded-md border border-slate-300 bg-white/95 px-2 py-1 text-[11px] font-semibold text-slate-900 shadow-xs whitespace-nowrap"
                  >
                    #{city.rank} {city.name} · {city.totalAccidents.toLocaleString('en-US')}
                  </button>
                </AdvancedMarker>
              ))
            : visibleCameras.map((cam) => {
                const isSelected = cam.id === selectedCameraId;
                const tier = getCameraPriorityTier(cam.rankInSector);
                const secColor = SECTOR_PALETTE[cam.sectorIndex].hex;
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
                    title={`${cam.id} (${cam.cityName} · S${cam.sectorIndex} ${cam.sectorPeriod}) — ${cam.historicalAccidents} collisions`}
                  >
                    {isRotationalPlan && selectedSector === 'all' && !isSelected ? (
                      <span
                        className="block h-2.5 w-2.5 rounded-full border border-white"
                        style={{ backgroundColor: secColor }}
                      />
                    ) : (
                      <span className={`block rounded-full border border-white ${dotColor}`} />
                    )}
                  </AdvancedMarker>
                );
              })}
        </GoogleMap>
      </div>
    </APIProvider>
  );
}
