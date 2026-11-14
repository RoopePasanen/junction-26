/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CanvasFinlandMap } from './components/CanvasFinlandMap';
import { GoogleFinlandMap } from './components/GoogleFinlandMap';
import { MapControlsOverlay } from './components/MapControlsOverlay';
import { SidebarPanel, type SidebarTabId } from './components/SidebarPanel';
import type { PlannedCameraNode } from './data/finlandWildlifePlan';
import {
  DEFAULT_PLOTTED_CAMERAS,
  MAX_PLOTTED_CAMERAS,
  MIN_PLOTTED_CAMERAS,
  type CustomAreaPlanResult,
  type CustomLocationPreset,
  type DrawingToolMode,
} from './types/customAreaPlan';
import {
  buildGeographicCircleRing,
  clampCoverageConfig,
  DEFAULT_COVERAGE_CONFIG,
  type CameraCoverageConfig,
} from './utils/cameraPlanGeometry';
import {
  DEFAULT_SIMULATOR_CONFIG,
  evaluateCrossingEvents,
  extractAvailableYears,
  filterEventsInCoveredCities,
  generateAreasDemoCrossings,
  type CrossingEvent,
  type CustomAreaSimulationScope,
  type EvaluatedCrossingEvent,
  type SimulatorConfig,
} from './utils/crossingSimulator';
import {
  clampCamera,
  DEFAULT_FINLAND_CAMERA,
  FINLAND_REGIONS,
  resolveGoogleMapTypeId,
  ZOOM_STEP,
  type BaseMapMode,
  type CameraState,
  type LatLngPoint,
  type RegionPreset,
} from './utils/mapMath';
import {
  computePolygonBBox,
  polygonsApproximatelyEqual,
  recommendedZoomForPolygon,
} from './utils/polygonGeometry';

export default function App() {
  const configuredApiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '').trim();
  const [googleAuthFailed, setGoogleAuthFailed] = useState(false);

  const [sidebarTab, setSidebarTab] = useState<SidebarTabId>('plan');
  const [camera, setCamera] = useState<CameraState>(DEFAULT_FINLAND_CAMERA);
  const [cursorPoint, setCursorPoint] = useState<LatLngPoint | null>(null);
  const [activeRegionId, setActiveRegionId] = useState<string | null>('overview');

  // Empty map initial state: zero preloaded cities, user adds & removes Areas of Interest freely
  const [areasOfInterest, setAreasOfInterest] = useState<CustomAreaPlanResult[]>([]);
  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const nextAreaSeqRef = useRef<number>(1);

  const [drawingMode, setDrawingMode] = useState<DrawingToolMode>('none');
  const [drawnPolygon, setDrawnPolygon] = useState<LatLngPoint[]>([]);
  const [draftPolygonVertices, setDraftPolygonVertices] = useState<LatLngPoint[]>([]);
  const [cameraCountInput, setCameraCountInput] = useState<string>(
    String(DEFAULT_PLOTTED_CAMERAS)
  );
  const [selectedPresetId, setSelectedPresetId] = useState<string>('custom');
  const [draftLabel, setDraftLabel] = useState<string>('');
  const [isLoadingCustomPlan, setIsLoadingCustomPlan] = useState<boolean>(false);
  const [customPlanError, setCustomPlanError] = useState<string | null>(null);

  const [selectedCameraId, setSelectedCameraId] = useState<string | null>(null);
  const [coverageConfig, setCoverageConfig] = useState<CameraCoverageConfig>(
    DEFAULT_COVERAGE_CONFIG
  );

  const [crossingEvents, setCrossingEvents] = useState<CrossingEvent[]>([]);
  const [datasetName, setDatasetName] = useState<string | null>(null);
  const [simulatorConfig, setSimulatorConfig] = useState<SimulatorConfig>(
    DEFAULT_SIMULATOR_CONFIG
  );
  const [selectedCrossingEventId, setSelectedCrossingEventId] = useState<string | null>(null);

  const [mode, setMode] = useState<BaseMapMode>('base');
  const [showLabels, setShowLabels] = useState<boolean>(true);
  const [showTerrain, setShowTerrain] = useState<boolean>(false);
  const [showGraticule, setShowGraticule] = useState<boolean>(true);
  const [showMapLegend, setShowMapLegend] = useState<boolean>(true);
  const [mobilePanelOpen, setMobilePanelOpen] = useState<boolean>(false);

  const handleCompletePolygon = useCallback(
    (polygon: LatLngPoint[]) => {
      if (polygon.length < 3) return;
      setDrawnPolygon(polygon);
      setDraftPolygonVertices([]);
      setDrawingMode('none');
      setSelectedPresetId('custom');
      setCustomPlanError(null);

      const currentlySelectedArea = areasOfInterest.find((a) => a.id === selectedAreaId) ?? null;
      const isSameAsSelected =
        currentlySelectedArea !== null &&
        polygonsApproximatelyEqual(polygon, currentlySelectedArea.polygon);

      if (!isSameAsSelected) {
        setSelectedAreaId(null);
        const bbox = computePolygonBBox(polygon);
        const seqNum = nextAreaSeqRef.current;
        setDraftLabel((prev) => {
          const trimmed = prev.trim();
          const wasPreviousSelectedLabel =
            currentlySelectedArea !== null && trimmed === currentlySelectedArea.label;
          if (
            !trimmed ||
            wasPreviousSelectedLabel ||
            trimmed.startsWith('Area of Interest ') ||
            trimmed.startsWith('Drawn Area (')
          ) {
            return `Area of Interest ${seqNum} (${bbox.centerLat.toFixed(2)}°N, ${bbox.centerLng.toFixed(2)}°E)`;
          }
          return prev;
        });
      }
    },
    [areasOfInterest, selectedAreaId]
  );

  useEffect(() => {
    if (drawingMode === 'none') return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDrawingMode('none');
        setDraftPolygonVertices([]);
      } else if (
        e.key === 'Enter' &&
        drawingMode === 'polygon' &&
        draftPolygonVertices.length >= 3
      ) {
        e.preventDefault();
        handleCompletePolygon(draftPolygonVertices);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [draftPolygonVertices, drawingMode, handleCompletePolygon]);

  const usingGoogleMaps = Boolean(configuredApiKey) && !googleAuthFailed;

  const googleMapTypeId = useMemo(
    () => resolveGoogleMapTypeId(mode, { showLabels, showTerrain }),
    [mode, showLabels, showTerrain]
  );

  const allArrangementCameras = useMemo(
    () => areasOfInterest.flatMap((area) => area.cameras),
    [areasOfInterest]
  );

  const visibleCameras = allArrangementCameras;

  const activeSimScopes = useMemo<CustomAreaSimulationScope[]>(
    () =>
      areasOfInterest.map((area) => ({
        id: area.id,
        center: area.center,
        radiusKm: area.radiusKm,
        label: area.label,
        polygon: area.polygon,
        roadPolylines: area.roadPolylines,
      })),
    [areasOfInterest]
  );

  const { evaluated: evaluatedEvents, summary: simulationSummary } = useMemo(
    () =>
      evaluateCrossingEvents(
        crossingEvents,
        allArrangementCameras,
        coverageConfig,
        simulatorConfig,
        activeSimScopes
      ),
    [
      activeSimScopes,
      allArrangementCameras,
      coverageConfig,
      crossingEvents,
      simulatorConfig,
    ]
  );

  const selectedCamera = useMemo(
    () => allArrangementCameras.find((cam) => cam.id === selectedCameraId) ?? null,
    [allArrangementCameras, selectedCameraId]
  );

  const handleCameraChange = useCallback((next: CameraState) => {
    setCamera(clampCamera(next));
    setActiveRegionId(null);
  }, []);

  const handleZoomChange = useCallback((nextZoom: number) => {
    setCamera((prev) => clampCamera({ center: prev.center, zoom: nextZoom }));
    setActiveRegionId(null);
  }, []);

  const handleZoomIn = useCallback(() => {
    setCamera((prev) => clampCamera({ center: prev.center, zoom: prev.zoom + ZOOM_STEP }));
    setActiveRegionId(null);
  }, []);

  const handleZoomOut = useCallback(() => {
    setCamera((prev) => clampCamera({ center: prev.center, zoom: prev.zoom - ZOOM_STEP }));
    setActiveRegionId(null);
  }, []);

  const handleResetFinlandView = useCallback(() => {
    setDrawingMode('none');
    setDraftPolygonVertices([]);
    setCamera(DEFAULT_FINLAND_CAMERA);
    setSelectedCameraId(null);
    setSelectedCrossingEventId(null);
    setActiveRegionId('overview');
  }, []);

  const handleStartNewArea = useCallback(() => {
    setSidebarTab('plan');
    setSelectedAreaId(null);
    setSelectedCameraId(null);
    setDrawnPolygon([]);
    setDraftPolygonVertices([]);
    setSelectedPresetId('custom');
    setDraftLabel('');
    setCustomPlanError(null);
    setDrawingMode('freehand');
  }, []);

  const handleStartDrawing = useCallback((nextMode: 'freehand' | 'polygon') => {
    setSidebarTab('plan');
    setDrawingMode(nextMode);
    setDraftPolygonVertices([]);
    setCustomPlanError(null);
  }, []);

  const handleAddDraftVertex = useCallback((point: LatLngPoint) => {
    setDraftPolygonVertices((prev) => [...prev, point]);
  }, []);

  const handleUndoPolygonVertex = useCallback(() => {
    setDraftPolygonVertices((prev) => prev.slice(0, -1));
  }, []);

  const handleFinishPolygonDraft = useCallback(() => {
    if (draftPolygonVertices.length >= 3) {
      handleCompletePolygon(draftPolygonVertices);
    }
  }, [draftPolygonVertices, handleCompletePolygon]);

  const handleCancelDrawing = useCallback(() => {
    setDrawingMode('none');
    setDraftPolygonVertices([]);
  }, []);

  const handleClearDrawnArea = useCallback(() => {
    setDrawnPolygon([]);
    setDraftPolygonVertices([]);
    setSelectedAreaId(null);
    setSelectedPresetId('custom');
    setDraftLabel('');
    setCustomPlanError(null);
  }, []);

  const handleSelectCustomPreset = useCallback((preset: CustomLocationPreset) => {
    setSelectedPresetId(preset.id);
    setSelectedAreaId(null);
    setDraftLabel(preset.name);
    setCustomPlanError(null);
    setDrawingMode('none');
    setDraftPolygonVertices([]);

    const starterPolygon = buildGeographicCircleRing(
      { lat: preset.lat, lng: preset.lng },
      Math.min(8, preset.defaultRadiusKm) * 1000,
      20
    )
      .slice(0, -1)
      .map((p) => ({
        lat: Number(p.lat.toFixed(5)),
        lng: Number(p.lng.toFixed(5)),
      }));

    setDrawnPolygon(starterPolygon);
    setCamera(
      clampCamera({
        center: { lat: preset.lat, lng: preset.lng },
        zoom: recommendedZoomForPolygon(starterPolygon),
      })
    );
    setActiveRegionId(null);
  }, []);

  const handleResetDefaultOptics = useCallback(() => {
    setCoverageConfig((prev) =>
      clampCoverageConfig({
        ...prev,
        rangeMeters: DEFAULT_COVERAGE_CONFIG.rangeMeters,
        fovDeg: DEFAULT_COVERAGE_CONFIG.fovDeg,
      })
    );
  }, []);

  const handlePlotCameras = useCallback(async () => {
    const polygonToPlot =
      drawingMode === 'polygon' && draftPolygonVertices.length >= 3
        ? draftPolygonVertices
        : drawnPolygon;

    if (polygonToPlot.length < 3) {
      setCustomPlanError('Draw a closed area on the map before placing cameras.');
      return;
    }

    const parsedCount = Math.round(Number(cameraCountInput.trim()));
    if (
      !Number.isFinite(parsedCount) ||
      parsedCount < MIN_PLOTTED_CAMERAS ||
      parsedCount > MAX_PLOTTED_CAMERAS
    ) {
      setCustomPlanError(
        `Enter a camera count between ${MIN_PLOTTED_CAMERAS} and ${MAX_PLOTTED_CAMERAS.toLocaleString()}.`
      );
      return;
    }

    if (drawingMode === 'polygon' && draftPolygonVertices.length >= 3) {
      setDrawnPolygon(draftPolygonVertices);
      setDraftPolygonVertices([]);
      setDrawingMode('none');
    }

    const existingSelectedArea = areasOfInterest.find((a) => a.id === selectedAreaId) ?? null;
    const isUpdatingSelected =
      existingSelectedArea !== null &&
      polygonsApproximatelyEqual(polygonToPlot, existingSelectedArea.polygon);

    const seqNum = nextAreaSeqRef.current;
    const targetAreaId = isUpdatingSelected ? existingSelectedArea.id : `area-${seqNum}`;
    const targetCameraPrefix = isUpdatingSelected
      ? existingSelectedArea.cameras[0]?.id.split('-')[0] || `A${String(seqNum).padStart(2, '0')}`
      : `A${String(seqNum).padStart(2, '0')}`;
    const resolvedLabel =
      draftLabel.trim() ||
      (isUpdatingSelected ? existingSelectedArea.label : `Area of Interest ${seqNum}`);

    setIsLoadingCustomPlan(true);
    setCustomPlanError(null);

    try {
      const res = await fetch('/api/plot-cameras', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          polygon: polygonToPlot,
          cameraCount: parsedCount,
          rangeMeters: coverageConfig.rangeMeters,
          fovDeg: coverageConfig.fovDeg,
          label: resolvedLabel,
          areaId: targetAreaId,
          cameraPrefix: targetCameraPrefix,
        }),
      });

      const payload = (await res.json()) as CustomAreaPlanResult & { error?: string };
      if (!res.ok || payload.error) {
        throw new Error(payload.error || 'Failed to plot cameras inside the drawn area.');
      }

      if (isUpdatingSelected) {
        setAreasOfInterest((prev) =>
          prev.map((a) => (a.id === payload.id ? payload : a))
        );
      } else {
        nextAreaSeqRef.current = seqNum + 1;
        setAreasOfInterest((prev) => [...prev, payload]);
      }

      setSelectedAreaId(payload.id);
      setDrawnPolygon(payload.polygon);
      setDraftLabel(payload.label);
      setSelectedCameraId(null);

      const bbox = computePolygonBBox(payload.polygon);
      setCamera((prev) =>
        clampCamera({
          center: { lat: bbox.centerLat, lng: bbox.centerLng },
          zoom: Math.max(prev.zoom, recommendedZoomForPolygon(payload.polygon)),
        })
      );
      setActiveRegionId(null);
      setMobilePanelOpen(false);
    } catch (err) {
      setCustomPlanError(
        err instanceof Error
          ? err.message
          : 'Unable to plot roadside cameras inside the drawn area.'
      );
    } finally {
      setIsLoadingCustomPlan(false);
    }
  }, [
    areasOfInterest,
    cameraCountInput,
    coverageConfig.fovDeg,
    coverageConfig.rangeMeters,
    draftLabel,
    draftPolygonVertices,
    drawingMode,
    drawnPolygon,
    selectedAreaId,
  ]);

  const handleSelectArea = useCallback((area: CustomAreaPlanResult) => {
    setSelectedAreaId(area.id);
    setDrawnPolygon(area.polygon);
    setCameraCountInput(String(area.cameras.length));
    setDraftLabel(area.label);
    setSelectedPresetId('custom');
    setDrawingMode('none');
    setDraftPolygonVertices([]);
    setCustomPlanError(null);
    setSelectedCameraId(null);

    const bbox = computePolygonBBox(area.polygon);
    setCamera(
      clampCamera({
        center: { lat: bbox.centerLat, lng: bbox.centerLng },
        zoom: recommendedZoomForPolygon(area.polygon),
      })
    );
    setActiveRegionId(null);
  }, []);

  const handleRemoveArea = useCallback(
    (areaId: string) => {
      setAreasOfInterest((prev) => prev.filter((a) => a.id !== areaId));
      setSelectedCrossingEventId(null);
      if (selectedCamera?.cityId === areaId) {
        setSelectedCameraId(null);
      }
      if (selectedAreaId === areaId) {
        setSelectedAreaId(null);
        setDrawnPolygon([]);
        setDraftLabel('');
        setSelectedPresetId('custom');
        setCustomPlanError(null);
      }
    },
    [selectedAreaId, selectedCamera]
  );

  const handleRemoveAllAreas = useCallback(() => {
    setAreasOfInterest([]);
    setSelectedAreaId(null);
    setSelectedCameraId(null);
    setSelectedCrossingEventId(null);
    setDrawnPolygon([]);
    setDraftPolygonVertices([]);
    setDrawingMode('none');
    setDraftLabel('');
    setSelectedPresetId('custom');
    setCustomPlanError(null);
  }, []);

  const handleSelectCamera = useCallback(
    (cam: PlannedCameraNode | null) => {
      if (!cam) {
        setSelectedCameraId(null);
        return;
      }
      setSelectedCameraId(cam.id);
      const parentArea = areasOfInterest.find((a) => a.id === cam.cityId);
      if (parentArea) {
        setSelectedAreaId(parentArea.id);
        setDrawnPolygon(parentArea.polygon);
        setCameraCountInput(String(parentArea.cameras.length));
        setDraftLabel(parentArea.label);
      }
      setCamera((prev) =>
        clampCamera({
          center: { lat: cam.lat, lng: cam.lng },
          zoom: Math.max(prev.zoom, 13.0),
        })
      );
      setActiveRegionId(null);
    },
    [areasOfInterest]
  );

  const handleZoomToCamera = useCallback(
    (cam: PlannedCameraNode) => {
      const r = coverageConfig.rangeMeters;
      const targetZoom = r <= 15 ? 17.2 : r <= 40 ? 16.2 : r <= 75 ? 15.6 : 15.0;
      setSelectedCameraId(cam.id);
      setCamera(
        clampCamera({
          center: { lat: cam.lat, lng: cam.lng },
          zoom: targetZoom,
        })
      );
      setActiveRegionId(null);
    },
    [coverageConfig.rangeMeters]
  );

  const handleUpdateCoverageConfig = useCallback((patch: Partial<CameraCoverageConfig>) => {
    setCoverageConfig((prev) => clampCoverageConfig({ ...prev, ...patch }));
  }, []);

  const frameLoadedEventsOnMap = useCallback((events: CrossingEvent[]) => {
    if (events.length === 0) return;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLng = Infinity;
    let maxLng = -Infinity;
    for (const ev of events) {
      if (ev.lat < minLat) minLat = ev.lat;
      if (ev.lat > maxLat) maxLat = ev.lat;
      if (ev.lng < minLng) minLng = ev.lng;
      if (ev.lng > maxLng) maxLng = ev.lng;
    }
    const latSpan = maxLat - minLat;
    const lngSpan = maxLng - minLng;
    const maxSpan = Math.max(latSpan * 1.35, lngSpan * 0.72);
    const targetZoom =
      maxSpan > 4.5
        ? 5.8
        : maxSpan > 2.2
          ? 7.4
          : maxSpan > 0.9
            ? 8.4
            : maxSpan > 0.35
              ? 9.8
              : maxSpan > 0.14
                ? 11.8
                : 12.6;
    setCamera(
      clampCamera({
        center: { lat: (minLat + maxLat) / 2, lng: (minLng + maxLng) / 2 },
        zoom: targetZoom,
      })
    );
    setActiveRegionId(null);
  }, []);

  const handleLoadEvents = useCallback(
    (events: CrossingEvent[], sourceLabel: string) => {
      const coveredEvents = filterEventsInCoveredCities(
        events,
        allArrangementCameras,
        activeSimScopes
      );
      const years = extractAvailableYears(coveredEvents.length > 0 ? coveredEvents : events);
      const defaultMappingYear: number | 'all' =
        years.length > 0 ? years[years.length - 1] : 'all';

      setCrossingEvents(events);
      setDatasetName(sourceLabel);
      setSelectedCrossingEventId(null);
      setSimulatorConfig((prev) => ({
        ...prev,
        selectedYear: defaultMappingYear,
      }));
      setCoverageConfig((prev) => ({ ...prev, showAccidentHotspots: false }));
      frameLoadedEventsOnMap(coveredEvents.length > 0 ? coveredEvents : events);
    },
    [activeSimScopes, allArrangementCameras, frameLoadedEventsOnMap]
  );

  const handleLoadDemoDataset = useCallback(() => {
    if (areasOfInterest.length === 0) return;
    const demoEvents = generateAreasDemoCrossings(areasOfInterest);
    const scopeTitle =
      areasOfInterest.length === 1
        ? areasOfInterest[0].label
        : `${areasOfInterest.length} Areas of Interest`;
    handleLoadEvents(demoEvents, `Synthetic Crossings — ${scopeTitle} (2024–2026)`);
  }, [areasOfInterest, handleLoadEvents]);

  const handleClearDataset = useCallback(() => {
    setCrossingEvents([]);
    setDatasetName(null);
    setSelectedCrossingEventId(null);
    setCoverageConfig((prev) => ({ ...prev, showAccidentHotspots: true }));
  }, []);

  const handleUpdateSimulatorConfig = useCallback((patch: Partial<SimulatorConfig>) => {
    setSimulatorConfig((prev) => ({ ...prev, ...patch }));
  }, []);

  const handleFocusCrossingEvent = useCallback((ev: EvaluatedCrossingEvent) => {
    setSelectedCrossingEventId(ev.eventId);
    const focusLat = ev.hasRoadCrossingLine ? ev.roadLat : ev.lat;
    const focusLng = ev.hasRoadCrossingLine ? ev.roadLng : ev.lng;
    setCamera((prev) =>
      clampCamera({
        center: { lat: focusLat, lng: focusLng },
        zoom: Math.max(prev.zoom, 15.2),
      })
    );
    setActiveRegionId(null);
  }, []);

  const handleSelectRegion = useCallback((region: RegionPreset) => {
    setCamera(clampCamera({ center: region.center, zoom: region.zoom }));
    setActiveRegionId(region.id);
  }, []);

  const handleJumpToCoordinates = useCallback((point: LatLngPoint, targetZoom?: number) => {
    setCamera((prev) =>
      clampCamera({
        center: point,
        zoom: targetZoom ?? prev.zoom,
      })
    );
    setActiveRegionId(null);
  }, []);

  const handleGoogleAuthError = useCallback(() => {
    setGoogleAuthFailed(true);
  }, []);

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-slate-50 text-slate-900">
      {/* Strict 3-Zone Top Bar Contract */}
      <header className="z-20 flex h-14 shrink-0 items-center justify-between gap-8 border-b border-slate-200 bg-white px-4 sm:px-6">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            handleResetFinlandView();
          }}
          className="text-base font-bold tracking-tight text-slate-950 whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-800"
        >
          SuomiKartta
        </a>

        <nav
          aria-label="Finland regional viewports"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
        >
          {FINLAND_REGIONS.map((region) => {
            const isCurrent = activeRegionId === region.id;
            return (
              <button
                key={region.id}
                type="button"
                onClick={() => handleSelectRegion(region)}
                className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                  isCurrent
                    ? 'border-sky-800 text-slate-950 font-semibold'
                    : 'border-transparent hover:text-slate-950 hover:border-slate-300'
                }`}
              >
                {region.shortLabel}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            data-testid="header-draw-area-btn"
            onClick={handleStartNewArea}
            className="min-h-9 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-800 whitespace-nowrap shrink-0"
          >
            Draw Area of Interest
          </button>
        </div>
      </header>

      {/* Main Workspace */}
      <div className="relative flex flex-1 min-h-0 overflow-hidden">
        {mobilePanelOpen && (
          <div
            aria-hidden="true"
            onClick={() => setMobilePanelOpen(false)}
            className="fixed inset-0 z-20 bg-slate-950/35 backdrop-blur-[1px] lg:hidden"
          />
        )}

        <SidebarPanel
          sidebarTab={sidebarTab}
          camera={camera}
          activeRegionId={activeRegionId}
          mode={mode}
          showLabels={showLabels}
          showTerrain={showTerrain}
          showGraticule={showGraticule}
          showMapLegend={showMapLegend}
          usingGoogleMaps={usingGoogleMaps}
          mobileOpen={mobilePanelOpen}
          areasOfInterest={areasOfInterest}
          selectedAreaId={selectedAreaId}
          selectedCameraId={selectedCameraId}
          coverageConfig={coverageConfig}
          allArrangementCameras={allArrangementCameras}
          visibleCameras={visibleCameras}
          datasetName={datasetName}
          rawEventCount={crossingEvents.length}
          evaluatedEvents={evaluatedEvents}
          simulationSummary={simulationSummary}
          simulatorConfig={simulatorConfig}
          selectedCrossingEventId={selectedCrossingEventId}
          drawingMode={drawingMode}
          drawnPolygon={drawnPolygon}
          draftPolygonVertices={draftPolygonVertices}
          cameraCountInput={cameraCountInput}
          draftLabel={draftLabel}
          selectedPresetId={selectedPresetId}
          isLoadingCustomPlan={isLoadingCustomPlan}
          customPlanError={customPlanError}
          onSidebarTabChange={setSidebarTab}
          onCloseMobile={() => setMobilePanelOpen(false)}
          onModeChange={setMode}
          onToggleLabels={() => setShowLabels((prev) => !prev)}
          onToggleTerrain={() => setShowTerrain((prev) => !prev)}
          onToggleGraticule={() => setShowGraticule((prev) => !prev)}
          onToggleMapLegend={() => setShowMapLegend((prev) => !prev)}
          onZoomChange={handleZoomChange}
          onZoomIn={handleZoomIn}
          onZoomOut={handleZoomOut}
          onSelectRegion={handleSelectRegion}
          onJumpToCoordinates={handleJumpToCoordinates}
          onSelectCamera={handleSelectCamera}
          onUpdateCoverageConfig={handleUpdateCoverageConfig}
          onLoadEvents={handleLoadEvents}
          onLoadDemoDataset={handleLoadDemoDataset}
          onClearDataset={handleClearDataset}
          onUpdateSimulatorConfig={handleUpdateSimulatorConfig}
          onFocusCrossingEvent={handleFocusCrossingEvent}
          onStartDrawing={handleStartDrawing}
          onStartNewArea={handleStartNewArea}
          onFinishPolygonDraft={handleFinishPolygonDraft}
          onUndoPolygonVertex={handleUndoPolygonVertex}
          onCancelDrawing={handleCancelDrawing}
          onClearDrawnArea={handleClearDrawnArea}
          onCameraCountInputChange={(val) => {
            setCameraCountInput(val);
            setCustomPlanError(null);
          }}
          onDraftLabelChange={(lbl) => setDraftLabel(lbl)}
          onSelectCustomPreset={handleSelectCustomPreset}
          onResetDefaultOptics={handleResetDefaultOptics}
          onPlotCameras={handlePlotCameras}
          onSelectArea={handleSelectArea}
          onRemoveArea={handleRemoveArea}
          onRemoveAllAreas={handleRemoveAllAreas}
        />

        <main className="relative flex-1 min-w-0 h-full bg-slate-100">
          {usingGoogleMaps ? (
            <GoogleFinlandMap
              apiKey={configuredApiKey}
              camera={camera}
              mapTypeId={googleMapTypeId}
              areasOfInterest={areasOfInterest}
              selectedAreaId={selectedAreaId}
              selectedCameraId={selectedCameraId}
              coverageConfig={coverageConfig}
              visibleCameras={visibleCameras}
              evaluatedEvents={evaluatedEvents}
              simulatorConfig={simulatorConfig}
              drawingMode={drawingMode}
              drawnPolygon={drawnPolygon}
              draftPolygonVertices={draftPolygonVertices}
              onCameraChange={handleCameraChange}
              onCursorMove={setCursorPoint}
              onSelectCamera={handleSelectCamera}
              onSelectArea={handleSelectArea}
              onCompletePolygon={handleCompletePolygon}
              onAddDraftVertex={handleAddDraftVertex}
              onAuthError={handleGoogleAuthError}
            />
          ) : (
            <CanvasFinlandMap
              camera={camera}
              mode={mode}
              mapTypeId={googleMapTypeId}
              showLabels={showLabels}
              showTerrain={showTerrain}
              showGraticule={showGraticule}
              areasOfInterest={areasOfInterest}
              selectedAreaId={selectedAreaId}
              selectedCameraId={selectedCameraId}
              coverageConfig={coverageConfig}
              visibleCameras={visibleCameras}
              evaluatedEvents={evaluatedEvents}
              simulatorConfig={simulatorConfig}
              selectedCrossingEventId={selectedCrossingEventId}
              drawingMode={drawingMode}
              drawnPolygon={drawnPolygon}
              draftPolygonVertices={draftPolygonVertices}
              onCameraChange={handleCameraChange}
              onCursorMove={setCursorPoint}
              onSelectCamera={handleSelectCamera}
              onSelectArea={handleSelectArea}
              onSelectCrossingEvent={handleFocusCrossingEvent}
              onCompletePolygon={handleCompletePolygon}
              onAddDraftVertex={handleAddDraftVertex}
            />
          )}

          <MapControlsOverlay
            camera={camera}
            cursorPoint={cursorPoint}
            mode={mode}
            showLabels={showLabels}
            showTerrain={showTerrain}
            showMapLegend={showMapLegend}
            usingGoogleMaps={usingGoogleMaps}
            mobilePanelOpen={mobilePanelOpen}
            selectedCamera={selectedCamera}
            coverageConfig={coverageConfig}
            visibleCameraCount={visibleCameras.length}
            simulationSummary={simulationSummary}
            simulatorConfig={simulatorConfig}
            areasOfInterest={areasOfInterest}
            drawingMode={drawingMode}
            drawnPolygon={drawnPolygon}
            draftPolygonVertices={draftPolygonVertices}
            onModeChange={setMode}
            onToggleLabels={() => setShowLabels((prev) => !prev)}
            onToggleTerrain={() => setShowTerrain((prev) => !prev)}
            onToggleMapLegend={() => setShowMapLegend((prev) => !prev)}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onResetFinlandView={handleResetFinlandView}
            onToggleMobilePanel={() => setMobilePanelOpen((prev) => !prev)}
            onZoomToCamera={handleZoomToCamera}
            onRemoveArea={handleRemoveArea}
            onCloseCameraCard={() => setSelectedCameraId(null)}
            onSwitchDrawingMode={handleStartDrawing}
            onFinishPolygonDraft={handleFinishPolygonDraft}
            onUndoPolygonVertex={handleUndoPolygonVertex}
            onCancelDrawing={handleCancelDrawing}
          />
        </main>
      </div>
    </div>
  );
}
