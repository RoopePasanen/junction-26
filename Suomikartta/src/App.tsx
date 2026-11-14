/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { CanvasFinlandMap } from './components/CanvasFinlandMap';
import { GoogleFinlandMap } from './components/GoogleFinlandMap';
import { MapControlsOverlay } from './components/MapControlsOverlay';
import { SidebarPanel, type SidebarTabId } from './components/SidebarPanel';
import {
  TOP_5_WILDLIFE_ACCIDENT_CITIES,
  type CityCameraPlan,
  type PlannedCameraNode,
  type SectorFilter,
} from './data/finlandWildlifePlan';
import {
  CUSTOM_FINLAND_LOCATION_PRESETS,
  recommendedZoomForRadiusKm,
  type CustomAreaPlanResult,
  type CustomLocationPreset,
  type PlanScopeMode,
} from './types/customAreaPlan';
import {
  clampCoverageConfig,
  DEFAULT_COVERAGE_CONFIG,
  resolveCityIdOnCameraSelect,
  type CameraCoverageConfig,
} from './utils/cameraPlanGeometry';
import {
  DEFAULT_SIMULATOR_CONFIG,
  evaluateCrossingEvents,
  extractAvailableYears,
  filterEventsInCoveredCities,
  generateCustomAreaDemoCrossings,
  getCamerasForArrangement,
  getDemoSyntheticEvents,
  isArrangementRotational,
  type CrossingEvent,
  type CustomAreaSimulationScope,
  type EvaluatedCrossingEvent,
  type SimulatorConfig,
} from './utils/crossingSimulator';
import {
  clampCamera,
  DEFAULT_FINLAND_CAMERA,
  resolveGoogleMapTypeId,
  validateCoordinateInput,
  ZOOM_STEP,
  type BaseMapMode,
  type CameraState,
  type LatLngPoint,
  type RegionPreset,
} from './utils/mapMath';

const INITIAL_PRESET = CUSTOM_FINLAND_LOCATION_PRESETS[0];

export default function App() {
  const configuredApiKey = (import.meta.env.VITE_GOOGLE_MAPS_API_KEY ?? '').trim();
  const [googleAuthFailed, setGoogleAuthFailed] = useState(false);

  const [sidebarTab, setSidebarTab] = useState<SidebarTabId>('plan');
  const [camera, setCamera] = useState<CameraState>(DEFAULT_FINLAND_CAMERA);
  const [cursorPoint, setCursorPoint] = useState<LatLngPoint | null>(null);
  const [activeRegionId, setActiveRegionId] = useState<string | null>('overview');

  const [planScope, setPlanScope] = useState<PlanScopeMode>('top5');
  const [customAreaPlan, setCustomAreaPlan] = useState<CustomAreaPlanResult | null>(null);
  const [selectedPresetId, setSelectedPresetId] = useState<string>(INITIAL_PRESET.id);
  const [draftLat, setDraftLat] = useState<string>(INITIAL_PRESET.lat.toFixed(4));
  const [draftLng, setDraftLng] = useState<string>(INITIAL_PRESET.lng.toFixed(4));
  const [draftRadiusKm, setDraftRadiusKm] = useState<number>(INITIAL_PRESET.defaultRadiusKm);
  const [draftLabel, setDraftLabel] = useState<string>(INITIAL_PRESET.name);
  const [isPickingCustomCenter, setIsPickingCustomCenter] = useState<boolean>(false);
  const [isLoadingCustomPlan, setIsLoadingCustomPlan] = useState<boolean>(false);
  const [customPlanError, setCustomPlanError] = useState<string | null>(null);

  const [selectedCityId, setSelectedCityId] = useState<string>('all');
  const [selectedSector, setSelectedSector] = useState<SectorFilter>('all');
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

  useEffect(() => {
    if (!isPickingCustomCenter) return;
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsPickingCustomCenter(false);
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [isPickingCustomCenter]);

  const usingGoogleMaps = Boolean(configuredApiKey) && !googleAuthFailed;

  const googleMapTypeId = useMemo(
    () => resolveGoogleMapTypeId(mode, { showLabels, showTerrain }),
    [mode, showLabels, showTerrain]
  );

  const customDraftArea = useMemo(() => {
    const validated = validateCoordinateInput(draftLat, draftLng);
    if (!validated.valid || !validated.point) return null;
    return {
      center: validated.point,
      radiusKm: draftRadiusKm,
      label: draftLabel.trim() || 'Custom Area',
    };
  }, [draftLabel, draftLat, draftLng, draftRadiusKm]);

  const isRotational = useMemo(
    () => planScope !== 'custom' && isArrangementRotational(simulatorConfig.arrangementId),
    [planScope, simulatorConfig.arrangementId]
  );

  const allArrangementCameras = useMemo(() => {
    if (planScope === 'custom') {
      return customAreaPlan ? customAreaPlan.cameras : [];
    }
    return getCamerasForArrangement(simulatorConfig.arrangementId);
  }, [customAreaPlan, planScope, simulatorConfig.arrangementId]);

  const visibleCameras = useMemo(() => {
    if (planScope === 'custom') {
      return allArrangementCameras;
    }
    if (!isRotational || selectedSector === 'all') {
      return allArrangementCameras;
    }
    return allArrangementCameras.filter((cam) => cam.sectorIndex === selectedSector);
  }, [allArrangementCameras, isRotational, planScope, selectedSector]);

  const activeCustomSimScope = useMemo<CustomAreaSimulationScope | null>(() => {
    if (planScope !== 'custom' || !customAreaPlan) return null;
    return {
      center: customAreaPlan.center,
      radiusKm: customAreaPlan.radiusKm,
      label: customAreaPlan.label,
    };
  }, [customAreaPlan, planScope]);

  const { evaluated: evaluatedEvents, summary: simulationSummary } = useMemo(
    () =>
      evaluateCrossingEvents(
        crossingEvents,
        allArrangementCameras,
        coverageConfig,
        simulatorConfig,
        isRotational ? selectedSector : 'all',
        activeCustomSimScope
      ),
    [
      activeCustomSimScope,
      allArrangementCameras,
      coverageConfig,
      crossingEvents,
      isRotational,
      selectedSector,
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
    setPlanScope('top5');
    setIsPickingCustomCenter(false);
    setCamera(DEFAULT_FINLAND_CAMERA);
    setSelectedCityId('all');
    setSelectedSector('all');
    setSelectedCameraId(null);
    setSelectedCrossingEventId(null);
    setActiveRegionId('overview');
  }, []);

  const handlePlanScopeChange = useCallback(
    (nextScope: PlanScopeMode) => {
      setPlanScope(nextScope);
      setIsPickingCustomCenter(false);
      setSelectedCameraId(null);
      setCustomPlanError(null);
      if (nextScope === 'custom') {
        if (customAreaPlan) {
          setCamera(
            clampCamera({
              center: customAreaPlan.center,
              zoom: recommendedZoomForRadiusKm(customAreaPlan.radiusKm),
            })
          );
          setActiveRegionId(null);
        } else {
          const validated = validateCoordinateInput(draftLat, draftLng);
          if (validated.valid && validated.point) {
            setCamera(
              clampCamera({
                center: validated.point,
                zoom: recommendedZoomForRadiusKm(draftRadiusKm),
              })
            );
            setActiveRegionId(null);
          }
        }
      } else {
        if (selectedCityId !== 'all') {
          const city = TOP_5_WILDLIFE_ACCIDENT_CITIES.find((c) => c.id === selectedCityId);
          if (city) {
            setCamera(clampCamera({ center: city.center, zoom: city.zoom }));
            return;
          }
        }
        setCamera(DEFAULT_FINLAND_CAMERA);
        setActiveRegionId('overview');
      }
    },
    [customAreaPlan, draftLat, draftLng, draftRadiusKm, selectedCityId]
  );

  const handleSelectCustomPreset = useCallback((preset: CustomLocationPreset) => {
    setSelectedPresetId(preset.id);
    setDraftLat(preset.lat.toFixed(4));
    setDraftLng(preset.lng.toFixed(4));
    setDraftRadiusKm(preset.defaultRadiusKm);
    setDraftLabel(preset.name);
    setCustomPlanError(null);
    setIsPickingCustomCenter(false);
    setCamera(
      clampCamera({
        center: { lat: preset.lat, lng: preset.lng },
        zoom: recommendedZoomForRadiusKm(preset.defaultRadiusKm),
      })
    );
    setActiveRegionId(null);
  }, []);

  const handlePickCustomCenterOnMap = useCallback(
    (point: LatLngPoint) => {
      setPlanScope('custom');
      setSelectedPresetId('custom');
      setDraftLat(point.lat.toFixed(4));
      setDraftLng(point.lng.toFixed(4));
      const matchedPreset = CUSTOM_FINLAND_LOCATION_PRESETS.some(
        (p) => p.name.toLowerCase() === draftLabel.trim().toLowerCase()
      );
      if (matchedPreset || !draftLabel.trim()) {
        setDraftLabel(`Study Area (${point.lat.toFixed(2)}°N, ${point.lng.toFixed(2)}°E)`);
      }
      setCustomPlanError(null);
      setIsPickingCustomCenter(false);
      setCamera((prev) =>
        clampCamera({
          center: point,
          zoom: Math.max(prev.zoom, recommendedZoomForRadiusKm(draftRadiusKm)),
        })
      );
      setActiveRegionId(null);
    },
    [draftLabel, draftRadiusKm]
  );

  const handleDistributeCustomCameras = useCallback(async () => {
    const validated = validateCoordinateInput(draftLat, draftLng);
    if (!validated.valid || !validated.point) {
      setCustomPlanError(validated.error ?? 'Enter valid latitude and longitude within Finland.');
      return;
    }

    setIsLoadingCustomPlan(true);
    setCustomPlanError(null);
    setIsPickingCustomCenter(false);

    try {
      const qs = new URLSearchParams({
        lat: String(validated.point.lat),
        lng: String(validated.point.lng),
        radiusKm: String(draftRadiusKm),
      });
      if (draftLabel.trim()) {
        qs.set('label', draftLabel.trim());
      }

      const res = await fetch(`/api/custom-area-plan?${qs.toString()}`);
      const payload = (await res.json()) as CustomAreaPlanResult & { error?: string };
      if (!res.ok || payload.error) {
        throw new Error(payload.error || 'Failed to compute 100-camera deployment plan.');
      }

      setCustomAreaPlan(payload);
      setPlanScope('custom');
      setSelectedCameraId(null);
      setCamera(
        clampCamera({
          center: payload.center,
          zoom: recommendedZoomForRadiusKm(payload.radiusKm),
        })
      );
      setActiveRegionId(null);
      setMobilePanelOpen(false);
    } catch (err) {
      setCustomPlanError(
        err instanceof Error
          ? err.message
          : 'Unable to fetch Ramboll collision data and road network.'
      );
    } finally {
      setIsLoadingCustomPlan(false);
    }
  }, [draftLabel, draftLat, draftLng, draftRadiusKm]);

  const handleSelectCityPlan = useCallback(
    (cityOrAll: CityCameraPlan | 'all') => {
      setPlanScope('top5');
      setIsPickingCustomCenter(false);
      if (cityOrAll === 'all') {
        setSelectedCityId('all');
        setSelectedCameraId(null);
        setCamera(DEFAULT_FINLAND_CAMERA);
        setActiveRegionId('overview');
        return;
      }
      setSelectedCityId(cityOrAll.id);
      setSelectedCameraId(null);
      if (selectedSector !== 'all') {
        const sec = cityOrAll.sectors.find((s) => s.sectorIndex === selectedSector);
        if (sec) {
          setCamera(clampCamera({ center: sec.center, zoom: sec.zoom }));
          setActiveRegionId(null);
          return;
        }
      }
      setCamera(clampCamera({ center: cityOrAll.center, zoom: cityOrAll.zoom }));
      setActiveRegionId(null);
    },
    [selectedSector]
  );

  const handleSelectSector = useCallback(
    (nextSector: SectorFilter) => {
      setSelectedSector(nextSector);
      if (selectedCameraId) {
        const currentCam = allArrangementCameras.find((c) => c.id === selectedCameraId);
        if (currentCam && nextSector !== 'all' && currentCam.sectorIndex !== nextSector) {
          setSelectedCameraId(null);
        }
      }
      if (planScope === 'top5' && selectedCityId !== 'all') {
        const city = TOP_5_WILDLIFE_ACCIDENT_CITIES.find((c) => c.id === selectedCityId);
        if (city) {
          if (nextSector === 'all') {
            setCamera(clampCamera({ center: city.center, zoom: city.zoom }));
          } else {
            const sec = city.sectors.find((s) => s.sectorIndex === nextSector);
            if (sec) {
              setCamera((prev) =>
                clampCamera({
                  center: sec.center,
                  zoom: Math.max(prev.zoom, sec.zoom),
                })
              );
            }
          }
          setActiveRegionId(null);
        }
      }
    },
    [allArrangementCameras, planScope, selectedCameraId, selectedCityId]
  );

  const handleSelectCamera = useCallback(
    (cam: PlannedCameraNode | null) => {
      if (!cam) {
        setSelectedCameraId(null);
        return;
      }
      setSelectedCameraId(cam.id);
      if (planScope === 'top5') {
        setSelectedCityId((prev) => resolveCityIdOnCameraSelect(prev, cam));
      }
      setCamera((prev) =>
        clampCamera({
          center: { lat: cam.lat, lng: cam.lng },
          zoom: Math.max(prev.zoom, 13.0),
        })
      );
      setActiveRegionId(null);
    },
    [planScope]
  );

  const handleZoomToCamera = useCallback(
    (cam: PlannedCameraNode) => {
      const r = coverageConfig.rangeMeters;
      const targetZoom = r <= 15 ? 17.2 : r <= 40 ? 16.2 : r <= 75 ? 15.6 : 15.0;
      setSelectedCameraId(cam.id);
      if (planScope === 'top5') {
        setSelectedCityId((prev) => resolveCityIdOnCameraSelect(prev, cam));
      }
      setCamera(
        clampCamera({
          center: { lat: cam.lat, lng: cam.lng },
          zoom: targetZoom,
        })
      );
      setActiveRegionId(null);
    },
    [coverageConfig.rangeMeters, planScope]
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
              : 11.4;
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
        activeCustomSimScope
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
    [activeCustomSimScope, allArrangementCameras, frameLoadedEventsOnMap]
  );

  const handleLoadDemoDataset = useCallback(() => {
    if (planScope === 'custom' && customAreaPlan) {
      const customDemo = generateCustomAreaDemoCrossings(customAreaPlan);
      handleLoadEvents(customDemo, `Synthetic Crossings — ${customAreaPlan.label} (2024–2026)`);
      return;
    }
    const demo = getDemoSyntheticEvents();
    handleLoadEvents(demo, 'Synthetic Crossings (2024–2026)');
  }, [customAreaPlan, handleLoadEvents, planScope]);

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
    setCamera((prev) =>
      clampCamera({
        center: { lat: ev.lat, lng: ev.lng },
        zoom: Math.max(prev.zoom, 14.6),
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
          aria-label="Top 5 wildlife accident cities"
          className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600"
        >
          {TOP_5_WILDLIFE_ACCIDENT_CITIES.map((city) => {
            const isCurrent = planScope === 'top5' && selectedCityId === city.id;
            return (
              <button
                key={city.id}
                type="button"
                onClick={() =>
                  isCurrent ? handleSelectCityPlan('all') : handleSelectCityPlan(city)
                }
                className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 ${
                  isCurrent
                    ? 'border-sky-800 text-slate-950 font-semibold'
                    : 'border-transparent hover:text-slate-950 hover:border-slate-300'
                }`}
              >
                {city.name}
              </button>
            );
          })}
        </nav>

        <div className="flex items-center shrink-0">
          <button
            type="button"
            onClick={handleResetFinlandView}
            className="min-h-9 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-800 whitespace-nowrap shrink-0"
          >
            Reset Finland View
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
          selectedCityId={selectedCityId}
          selectedSector={selectedSector}
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
          planScope={planScope}
          customAreaPlan={customAreaPlan}
          draftLat={draftLat}
          draftLng={draftLng}
          draftRadiusKm={draftRadiusKm}
          draftLabel={draftLabel}
          selectedPresetId={selectedPresetId}
          isPickingCustomCenter={isPickingCustomCenter}
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
          onSelectCityPlan={handleSelectCityPlan}
          onSelectSector={handleSelectSector}
          onSelectCamera={handleSelectCamera}
          onUpdateCoverageConfig={handleUpdateCoverageConfig}
          onLoadEvents={handleLoadEvents}
          onLoadDemoDataset={handleLoadDemoDataset}
          onClearDataset={handleClearDataset}
          onUpdateSimulatorConfig={handleUpdateSimulatorConfig}
          onFocusCrossingEvent={handleFocusCrossingEvent}
          onPlanScopeChange={handlePlanScopeChange}
          onDraftLatChange={(val) => {
            setDraftLat(val);
            setSelectedPresetId('custom');
            setCustomPlanError(null);
          }}
          onDraftLngChange={(val) => {
            setDraftLng(val);
            setSelectedPresetId('custom');
            setCustomPlanError(null);
          }}
          onDraftRadiusChange={(r) => {
            setDraftRadiusKm(r);
            setCustomPlanError(null);
          }}
          onDraftLabelChange={(lbl) => setDraftLabel(lbl)}
          onSelectCustomPreset={handleSelectCustomPreset}
          onTogglePickCustomCenter={() => setIsPickingCustomCenter((prev) => !prev)}
          onDistributeCustomCameras={handleDistributeCustomCameras}
        />

        <main className="relative flex-1 min-w-0 h-full bg-slate-100">
          {usingGoogleMaps ? (
            <GoogleFinlandMap
              apiKey={configuredApiKey}
              camera={camera}
              mapTypeId={googleMapTypeId}
              selectedCityId={selectedCityId}
              selectedSector={selectedSector}
              selectedCameraId={selectedCameraId}
              coverageConfig={coverageConfig}
              visibleCameras={visibleCameras}
              evaluatedEvents={evaluatedEvents}
              simulatorConfig={simulatorConfig}
              planScope={planScope}
              customAreaPlan={customAreaPlan}
              customDraftArea={customDraftArea}
              isPickingCustomCenter={isPickingCustomCenter}
              onCameraChange={handleCameraChange}
              onCursorMove={setCursorPoint}
              onSelectCamera={handleSelectCamera}
              onSelectCity={handleSelectCityPlan}
              onSelectSector={handleSelectSector}
              onPickCustomCenter={handlePickCustomCenterOnMap}
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
              selectedCityId={selectedCityId}
              selectedSector={selectedSector}
              selectedCameraId={selectedCameraId}
              coverageConfig={coverageConfig}
              visibleCameras={visibleCameras}
              evaluatedEvents={evaluatedEvents}
              simulatorConfig={simulatorConfig}
              selectedCrossingEventId={selectedCrossingEventId}
              planScope={planScope}
              customAreaPlan={customAreaPlan}
              customDraftArea={customDraftArea}
              isPickingCustomCenter={isPickingCustomCenter}
              onCameraChange={handleCameraChange}
              onCursorMove={setCursorPoint}
              onSelectCamera={handleSelectCamera}
              onSelectCity={handleSelectCityPlan}
              onSelectSector={handleSelectSector}
              onSelectCrossingEvent={handleFocusCrossingEvent}
              onPickCustomCenter={handlePickCustomCenterOnMap}
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
            selectedSector={selectedSector}
            selectedCamera={selectedCamera}
            coverageConfig={coverageConfig}
            visibleCameraCount={visibleCameras.length}
            simulationSummary={simulationSummary}
            simulatorConfig={simulatorConfig}
            planScope={planScope}
            customAreaPlan={customAreaPlan}
            isPickingCustomCenter={isPickingCustomCenter}
            onModeChange={setMode}
            onToggleLabels={() => setShowLabels((prev) => !prev)}
            onToggleTerrain={() => setShowTerrain((prev) => !prev)}
            onToggleMapLegend={() => setShowMapLegend((prev) => !prev)}
            onZoomIn={handleZoomIn}
            onZoomOut={handleZoomOut}
            onResetFinlandView={handleResetFinlandView}
            onToggleMobilePanel={() => setMobilePanelOpen((prev) => !prev)}
            onZoomToCamera={handleZoomToCamera}
            onCloseCameraCard={() => setSelectedCameraId(null)}
            onCancelPickCustomCenter={() => setIsPickingCustomCenter(false)}
          />
        </main>
      </div>
    </div>
  );
}
