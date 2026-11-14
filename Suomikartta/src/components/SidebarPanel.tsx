import React, { useMemo, useState } from 'react';
import { Compass, Download, Minus, Plus, Search, X } from 'lucide-react';
import {
  RAMBOLL_DATA_PERIOD,
  RAMBOLL_DATA_SOURCE_URL,
  SECTOR_IDS,
  SECTOR_ROTATION_SCHEDULE,
  TOP_5_WILDLIFE_ACCIDENT_CITIES,
  TOTAL_COVERED_ACCIDENTS,
  TOTAL_TOP5_ACCIDENTS,
  type CityCameraPlan,
  type PlannedCameraNode,
  type SectorFilter,
} from '../data/finlandWildlifePlan';
import {
  buildCameraPlanCsv,
  computeSingleCameraAreaM2,
  filterCamerasByCityAndSearch,
  formatAreaCompact,
  getDominantSpeciesLabel,
  MAX_CAMERA_FOV_DEG,
  MAX_CAMERA_RANGE_M,
  MIN_CAMERA_FOV_DEG,
  MIN_CAMERA_RANGE_M,
  SECTOR_PALETTE,
  type CameraCoverageConfig,
} from '../utils/cameraPlanGeometry';
import {
  isArrangementRotational,
  type CrossingEvent,
  type EvaluatedCrossingEvent,
  type SimulationSummary,
  type SimulatorConfig,
} from '../utils/crossingSimulator';
import {
  calculateGroundResolutionMetersPerPixel,
  FINLAND_REGIONS,
  MAX_ZOOM,
  MIN_ZOOM,
  validateCoordinateInput,
  ZOOM_PRESETS,
  type BaseMapMode,
  type CameraState,
  type LatLngPoint,
  type RegionPreset,
} from '../utils/mapMath';
import type {
  CustomAreaPlanResult,
  CustomLocationPreset,
  PlanScopeMode,
} from '../types/customAreaPlan';
import { CustomAreaPlannerSection } from './CustomAreaPlannerSection';
import { SimulatorPanelSection } from './SimulatorPanelSection';

export type SidebarTabId = 'plan' | 'simulator' | 'map';

interface SidebarPanelProps {
  sidebarTab: SidebarTabId;
  camera: CameraState;
  activeRegionId: string | null;
  mode: BaseMapMode;
  showLabels: boolean;
  showTerrain: boolean;
  showGraticule: boolean;
  showMapLegend: boolean;
  usingGoogleMaps: boolean;
  mobileOpen: boolean;
  selectedCityId: string;
  selectedSector: SectorFilter;
  selectedCameraId: string | null;
  coverageConfig: CameraCoverageConfig;
  allArrangementCameras: PlannedCameraNode[];
  visibleCameras: PlannedCameraNode[];
  datasetName: string | null;
  rawEventCount: number;
  evaluatedEvents: EvaluatedCrossingEvent[];
  simulationSummary: SimulationSummary;
  simulatorConfig: SimulatorConfig;
  selectedCrossingEventId: string | null;
  planScope: PlanScopeMode;
  customAreaPlan: CustomAreaPlanResult | null;
  draftLat: string;
  draftLng: string;
  draftRadiusKm: number;
  draftLabel: string;
  selectedPresetId: string;
  isPickingCustomCenter: boolean;
  isLoadingCustomPlan: boolean;
  customPlanError: string | null;
  onSidebarTabChange: (tab: SidebarTabId) => void;
  onCloseMobile: () => void;
  onModeChange: (mode: BaseMapMode) => void;
  onToggleLabels: () => void;
  onToggleTerrain: () => void;
  onToggleGraticule: () => void;
  onToggleMapLegend: () => void;
  onZoomChange: (zoom: number) => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onSelectRegion: (region: RegionPreset) => void;
  onJumpToCoordinates: (point: LatLngPoint, targetZoom?: number) => void;
  onSelectCityPlan: (city: CityCameraPlan | 'all') => void;
  onSelectSector: (sector: SectorFilter) => void;
  onSelectCamera: (camera: PlannedCameraNode) => void;
  onUpdateCoverageConfig: (patch: Partial<CameraCoverageConfig>) => void;
  onLoadEvents: (events: CrossingEvent[], sourceLabel: string) => void;
  onLoadDemoDataset: () => void;
  onClearDataset: () => void;
  onUpdateSimulatorConfig: (patch: Partial<SimulatorConfig>) => void;
  onFocusCrossingEvent: (event: EvaluatedCrossingEvent) => void;
  onPlanScopeChange: (scope: PlanScopeMode) => void;
  onDraftLatChange: (lat: string) => void;
  onDraftLngChange: (lng: string) => void;
  onDraftRadiusChange: (radiusKm: number) => void;
  onDraftLabelChange: (label: string) => void;
  onSelectCustomPreset: (preset: CustomLocationPreset) => void;
  onTogglePickCustomCenter: () => void;
  onDistributeCustomCameras: () => void;
}

export function SidebarPanel({
  sidebarTab,
  camera,
  activeRegionId,
  mode,
  showLabels,
  showTerrain,
  showGraticule,
  showMapLegend,
  usingGoogleMaps,
  mobileOpen,
  selectedCityId,
  selectedSector,
  selectedCameraId,
  coverageConfig,
  allArrangementCameras,
  visibleCameras,
  datasetName,
  rawEventCount,
  evaluatedEvents,
  simulationSummary,
  simulatorConfig,
  selectedCrossingEventId,
  planScope,
  customAreaPlan,
  draftLat,
  draftLng,
  draftRadiusKm,
  draftLabel,
  selectedPresetId,
  isPickingCustomCenter,
  isLoadingCustomPlan,
  customPlanError,
  onSidebarTabChange,
  onCloseMobile,
  onModeChange,
  onToggleLabels,
  onToggleTerrain,
  onToggleGraticule,
  onToggleMapLegend,
  onZoomChange,
  onZoomIn,
  onZoomOut,
  onSelectRegion,
  onJumpToCoordinates,
  onSelectCityPlan,
  onSelectSector,
  onSelectCamera,
  onUpdateCoverageConfig,
  onLoadEvents,
  onLoadDemoDataset,
  onClearDataset,
  onUpdateSimulatorConfig,
  onFocusCrossingEvent,
  onPlanScopeChange,
  onDraftLatChange,
  onDraftLngChange,
  onDraftRadiusChange,
  onDraftLabelChange,
  onSelectCustomPreset,
  onTogglePickCustomCenter,
  onDistributeCustomCameras,
}: SidebarPanelProps) {
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showAllRows, setShowAllRows] = useState<boolean>(false);

  const [latInput, setLatInput] = useState<string>('60.3700');
  const [lngInput, setLngInput] = useState<string>('23.2100');
  const [coordError, setCoordError] = useState<string | null>(null);

  const isCustomMode = planScope === 'custom';

  const isRotational = useMemo(
    () => !isCustomMode && isArrangementRotational(simulatorConfig.arrangementId),
    [isCustomMode, simulatorConfig.arrangementId]
  );

  const activeCity = useMemo(
    () =>
      isCustomMode
        ? null
        : TOP_5_WILDLIFE_ACCIDENT_CITIES.find((c) => c.id === selectedCityId) ?? null,
    [isCustomMode, selectedCityId]
  );

  const effectiveCityFilter = isCustomMode ? 'all' : selectedCityId;
  const effectiveSectorFilter: SectorFilter = isRotational ? selectedSector : 'all';

  const filteredCameras = useMemo(
    () =>
      filterCamerasByCityAndSearch(
        allArrangementCameras,
        effectiveCityFilter,
        searchQuery,
        effectiveSectorFilter
      ),
    [allArrangementCameras, effectiveCityFilter, effectiveSectorFilter, searchQuery]
  );

  const displayedCameras = useMemo(
    () => (showAllRows ? filteredCameras.slice(0, 250) : filteredCameras.slice(0, 30)),
    [filteredCameras, showAllRows]
  );

  const scopeVisibleCount = useMemo(() => {
    if (isCustomMode) {
      return visibleCameras.length;
    }
    if (!activeCity) {
      return visibleCameras.length;
    }
    return visibleCameras.filter((c) => c.cityId === activeCity.id).length;
  }, [activeCity, isCustomMode, visibleCameras]);

  const scopeAccidents = useMemo(() => {
    if (isCustomMode) {
      return customAreaPlan ? customAreaPlan.totalAccidentsInRadius : 0;
    }
    if (effectiveSectorFilter !== 'all') {
      if (activeCity) {
        const sec = activeCity.sectors.find((s) => s.sectorIndex === effectiveSectorFilter);
        return sec ? sec.historicalAccidents : activeCity.totalAccidents;
      }
      return TOP_5_WILDLIFE_ACCIDENT_CITIES.reduce((sum, city) => {
        const sec = city.sectors.find((s) => s.sectorIndex === effectiveSectorFilter);
        return sum + (sec ? sec.historicalAccidents : 0);
      }, 0);
    }
    return activeCity ? activeCity.totalAccidents : TOTAL_TOP5_ACCIDENTS;
  }, [activeCity, customAreaPlan, effectiveSectorFilter, isCustomMode]);

  const scopeCoveredAccidents = activeCity ? activeCity.coveredAccidents : TOTAL_COVERED_ACCIDENTS;
  const singleAreaM2 = computeSingleCameraAreaM2(
    coverageConfig.rangeMeters,
    coverageConfig.fovDeg
  );
  const singleAreaLabel = formatAreaCompact(singleAreaM2);
  const totalCoveredLabel = formatAreaCompact(scopeVisibleCount * singleAreaM2);

  const groundRes = calculateGroundResolutionMetersPerPixel(camera.center.lat, camera.zoom);
  const formattedGroundRes =
    groundRes >= 1000
      ? `${(groundRes / 1000).toFixed(2)} km/px`
      : `${groundRes.toFixed(1)} m/px`;

  const handleCoordinateSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const result = validateCoordinateInput(latInput, lngInput);
    if (!result.valid || !result.point) {
      setCoordError(result.error ?? 'Invalid coordinates.');
      return;
    }
    setCoordError(null);
    onJumpToCoordinates(result.point, Math.max(camera.zoom, 12));
    onCloseMobile();
  };

  const handleDownloadCsv = () => {
    const scopeCameras = filterCamerasByCityAndSearch(
      allArrangementCameras,
      effectiveCityFilter,
      '',
      effectiveSectorFilter
    );
    const csv = buildCameraPlanCsv(scopeCameras, coverageConfig);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    if (isCustomMode && customAreaPlan) {
      const slug = customAreaPlan.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      anchor.download = `finland-wildlife-cameras-${slug || 'custom'}-${customAreaPlan.radiusKm}km.csv`;
    } else {
      const cityPart = activeCity ? activeCity.id : 'top5-cities';
      const sectorPart =
        effectiveSectorFilter === 'all' ? 'all-5-sectors' : `sector-${effectiveSectorFilter}`;
      anchor.download = `finland-wildlife-cameras-${cityPart}-${sectorPart}.csv`;
    }
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  return (
    <aside
      id="finland-map-sidebar"
      aria-label="Wildlife camera deployment plan and map controls"
      className={`${
        mobileOpen ? 'fixed inset-y-0 left-0 z-30 flex' : 'hidden lg:flex'
      } w-84 max-w-[90vw] shrink-0 flex-col border-r border-slate-200 bg-white overflow-y-auto`}
    >
      {/* Mobile Drawer Close Header */}
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-3.5 lg:hidden">
        <span className="text-sm font-semibold text-slate-900">Plan &amp; Map Controls</span>
        <button
          type="button"
          onClick={onCloseMobile}
          aria-label="Close sidebar"
          className="flex h-9 w-9 items-center justify-center rounded-md text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      {/* Primary Workspace Switcher */}
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-3">
        <div
          role="tablist"
          aria-label="Sidebar view"
          className="grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={sidebarTab === 'plan'}
            onClick={() => onSidebarTabChange('plan')}
            className={`min-h-9 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              sidebarTab === 'plan'
                ? 'bg-white text-slate-950 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Plan
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sidebarTab === 'simulator'}
            onClick={() => onSidebarTabChange('simulator')}
            className={`min-h-9 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              sidebarTab === 'simulator'
                ? 'bg-white text-slate-950 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Simulator
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sidebarTab === 'map'}
            onClick={() => onSidebarTabChange('map')}
            className={`min-h-9 rounded-md px-2 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
              sidebarTab === 'map'
                ? 'bg-white text-slate-950 shadow-xs'
                : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            Map
          </button>
        </div>
      </div>

      {sidebarTab === 'simulator' ? (
        <SimulatorPanelSection
          datasetName={datasetName}
          rawEventCount={rawEventCount}
          evaluatedEvents={evaluatedEvents}
          simulationSummary={simulationSummary}
          simulatorConfig={simulatorConfig}
          coverageConfig={coverageConfig}
          selectedSector={selectedSector}
          selectedEventId={selectedCrossingEventId}
          planScope={planScope}
          customAreaPlan={customAreaPlan}
          onLoadEvents={onLoadEvents}
          onLoadDemoDataset={onLoadDemoDataset}
          onClearDataset={onClearDataset}
          onSelectSector={onSelectSector}
          onUpdateSimulatorConfig={onUpdateSimulatorConfig}
          onUpdateCoverageConfig={onUpdateCoverageConfig}
          onFocusCrossingEvent={(ev) => {
            onFocusCrossingEvent(ev);
            onCloseMobile();
          }}
        />
      ) : sidebarTab === 'plan' ? (
        <div className="flex flex-col divide-y divide-slate-200">
          {/* Plan Scope Switcher: 5-City Rotational Plan vs Custom Location & Radius (100 Cameras) */}
          <div className="px-5 py-3 bg-slate-50/70">
            <div
              role="group"
              aria-label="Deployment plan mode"
              className="grid grid-cols-2 gap-1 rounded-lg bg-slate-200/75 p-1"
            >
              <button
                type="button"
                data-testid="scope-top5-btn"
                aria-pressed={!isCustomMode}
                onClick={() => {
                  onPlanScopeChange('top5');
                  setShowAllRows(false);
                }}
                className={`min-h-8 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  !isCustomMode
                    ? 'bg-white text-slate-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                5-City Plan (5×100)
              </button>
              <button
                type="button"
                data-testid="scope-custom-btn"
                aria-pressed={isCustomMode}
                onClick={() => {
                  onPlanScopeChange('custom');
                  setShowAllRows(false);
                }}
                className={`min-h-8 rounded-md px-2.5 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  isCustomMode
                    ? 'bg-white text-sky-950 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Custom Area (100)
              </button>
            </div>
          </div>

          {isCustomMode ? (
            <CustomAreaPlannerSection
              draftLat={draftLat}
              draftLng={draftLng}
              draftRadiusKm={draftRadiusKm}
              draftLabel={draftLabel}
              selectedPresetId={selectedPresetId}
              isPickingCustomCenter={isPickingCustomCenter}
              isLoadingCustomPlan={isLoadingCustomPlan}
              customPlanError={customPlanError}
              customAreaPlan={customAreaPlan}
              totalCoveredLabel={totalCoveredLabel}
              onDraftLatChange={onDraftLatChange}
              onDraftLngChange={onDraftLngChange}
              onDraftRadiusChange={onDraftRadiusChange}
              onDraftLabelChange={onDraftLabelChange}
              onSelectPreset={onSelectCustomPreset}
              onTogglePickCenter={onTogglePickCustomCenter}
              onDistributeCameras={onDistributeCustomCameras}
            />
          ) : (
            <>
              {/* Section 1: Summary Metrics & Data Source */}
              <section className="p-5">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 className="text-sm font-semibold text-slate-950">
                    {activeCity ? `${activeCity.name} 5-Sector Plan` : 'National 5-Sector Plan'}
                  </h2>
              <span className="font-mono text-xs tabular-nums text-slate-500">
                {RAMBOLL_DATA_PERIOD}
              </span>
            </div>

            <p className="mt-1 text-xs leading-relaxed text-slate-600">
              {!isRotational
                ? 'Static baseline: 100 cameras per city held at fixed hotspots for the full year.'
                : effectiveSectorFilter === 'all'
                  ? activeCity
                    ? `100 cameras placed densely on high-priority stretches in Zone 1, then rotated across Zones 2–5 every 1/5th year (73 days each · 500 sites in ${activeCity.name}).`
                    : '100 cameras per city placed densely on high-priority stretches across 5 compact zones over 1 year (73 days / 0.2 yr each · 2,500 annual sites).'
                  : `Inspecting Sector ${effectiveSectorFilter} (${SECTOR_ROTATION_SCHEDULE[effectiveSectorFilter].shortPeriod} · ${SECTOR_ROTATION_SCHEDULE[effectiveSectorFilter].dayRangeLabel}).`}
            </p>

            <dl className="mt-3.5 grid grid-cols-3 gap-3 border-y border-slate-200 py-3">
              <div>
                <dt className="text-[11px] text-slate-500">
                  {effectiveSectorFilter === 'all' && isRotational ? 'Annual Sites' : 'Active Units'}
                </dt>
                <dd
                  data-testid="plan-camera-count"
                  className="mt-0.5 font-mono text-sm font-bold tabular-nums text-slate-950"
                >
                  {scopeVisibleCount.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-slate-500">Collisions</dt>
                <dd
                  data-testid="plan-accident-count"
                  className="mt-0.5 font-mono text-sm font-bold tabular-nums text-slate-950"
                >
                  {scopeAccidents.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-slate-500">Area Covered</dt>
                <dd
                  data-testid="plan-covered-area"
                  className="mt-0.5 font-mono text-sm font-bold tabular-nums text-sky-900"
                >
                  {totalCoveredLabel}
                </dd>
              </div>
            </dl>

            <div className="mt-2.5 flex items-center justify-between gap-2 text-[11px] text-slate-500">
              <span className="font-mono tabular-nums">
                {activeCity ? '100 hw units' : '500 hw units'} · {scopeCoveredAccidents.toLocaleString()} city hits
              </span>
              <a
                href={RAMBOLL_DATA_SOURCE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="font-medium text-sky-800 underline decoration-sky-800/40 underline-offset-2 hover:text-sky-950 whitespace-nowrap"
              >
                Ramboll Data
              </a>
            </div>
          </section>

          {/* Section 2: 5-Sector Annual Rotation Inspector */}
          <section className="p-5">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-950">5-Sector Annual Rotation</h2>
              <span className="font-mono text-xs tabular-nums text-slate-500">0.2 yr · 73 d</span>
            </div>

            {!isRotational ? (
              <p className="mt-1.5 text-xs text-slate-500">
                Static Year-Round arrangement is active in Simulator. Switch back to 5-Sector
                Maximal to inspect individual 1/5th-year sectors.
              </p>
            ) : (
              <>
                <div
                  role="group"
                  aria-label="Inspect deployment sector"
                  className="mt-2.5 grid grid-cols-6 gap-1 rounded-lg bg-slate-100 p-1"
                >
                  <button
                    type="button"
                    aria-pressed={selectedSector === 'all'}
                    onClick={() => {
                      onSelectSector('all');
                      setShowAllRows(false);
                    }}
                    className={`min-h-8 rounded-md px-1.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                      selectedSector === 'all'
                        ? 'bg-white text-slate-950 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    All 5
                  </button>
                  {SECTOR_IDS.map((sId) => {
                    const isSelected = selectedSector === sId;
                    return (
                      <button
                        key={sId}
                        type="button"
                        aria-pressed={isSelected}
                        onClick={() => {
                          onSelectSector(isSelected ? 'all' : sId);
                          setShowAllRows(false);
                        }}
                        className={`min-h-8 rounded-md px-1.5 py-1 font-mono text-xs font-semibold tabular-nums transition-colors whitespace-nowrap ${
                          isSelected
                            ? 'bg-sky-900 text-white shadow-xs'
                            : 'text-slate-700 hover:text-slate-950'
                        }`}
                      >
                        S{sId}
                      </button>
                    );
                  })}
                </div>

                {activeCity ? (
                  <div className="mt-3 divide-y divide-slate-100 border-y border-slate-200">
                    {activeCity.sectors.map((sec) => {
                      const isCurrent = selectedSector === sec.sectorIndex;
                      const style = SECTOR_PALETTE[sec.sectorIndex];
                      return (
                        <button
                          key={sec.code}
                          type="button"
                          onClick={() => {
                            onSelectSector(isCurrent ? 'all' : sec.sectorIndex);
                            setShowAllRows(false);
                          }}
                          className={`flex w-full items-center justify-between gap-2 px-2 py-2 text-left transition-colors ${
                            isCurrent ? 'bg-sky-50/90 text-slate-950' : 'hover:bg-slate-50'
                          }`}
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5">
                              <span
                                aria-hidden="true"
                                style={{ backgroundColor: style.hex }}
                                className="inline-block h-2.5 w-2.5 shrink-0 rounded-xs"
                              />
                              <span className="text-xs font-semibold text-slate-900 truncate">
                                S{sec.sectorIndex} · {sec.directionLabel}
                              </span>
                            </div>
                            <div className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-500">
                              {sec.shortPeriod}
                            </div>
                          </div>

                          <div className="text-right font-mono text-[11px] tabular-nums shrink-0">
                            <div className="font-semibold text-slate-900">100 cam</div>
                            <div className="text-slate-500">{sec.historicalAccidents} acc</div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                ) : (
                  <div className="mt-2.5 text-[11px] leading-relaxed text-slate-600">
                    {selectedSector === 'all' ? (
                      <span>
                        Showing all <span className="font-mono font-semibold text-slate-900">5</span>{' '}
                        sectors per city (<span className="font-mono">Jan 1 – Dec 31</span> · 1 full
                        year). Select <span className="font-mono">S1–S5</span> above or pick a city
                        below to inspect each fifth of the year separately.
                      </span>
                    ) : (
                      <div className="flex items-center justify-between gap-2 font-mono tabular-nums text-slate-700">
                        <span>
                          S{selectedSector}: {SECTOR_ROTATION_SCHEDULE[selectedSector].shortPeriod}
                        </span>
                        <span className="text-slate-500">
                          {SECTOR_ROTATION_SCHEDULE[selectedSector].dayRangeLabel}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </section>

          {/* Section 3: Top 5 Wildlife Accident Cities */}
          <section className="p-5">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-950">Top 5 Accident Cities</h2>
              <span className="text-xs text-slate-500">5 sectors / city</span>
            </div>

            <div className="mt-3 space-y-1.5">
              <button
                type="button"
                onClick={() => {
                  onSelectCityPlan('all');
                  onCloseMobile();
                }}
                className={`w-full rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700 ${
                  selectedCityId === 'all'
                    ? 'bg-slate-900 text-white'
                    : 'bg-slate-50 text-slate-800 hover:bg-slate-100'
                }`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-xs font-semibold">All 5 Cities Overview</span>
                  <span
                    className={`font-mono text-[11px] tabular-nums ${
                      selectedCityId === 'all' ? 'text-slate-300' : 'text-slate-600'
                    }`}
                  >
                    5×500 · 9,663 acc
                  </span>
                </div>
              </button>

              {TOP_5_WILDLIFE_ACCIDENT_CITIES.map((city) => {
                const isSelected = selectedCityId === city.id;
                const cityIndex = String(city.rank).padStart(2, '0');
                return (
                  <button
                    key={city.id}
                    type="button"
                    onClick={() => {
                      onSelectCityPlan(city);
                      onCloseMobile();
                    }}
                    className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700 ${
                      isSelected
                        ? 'bg-sky-900 text-white'
                        : 'text-slate-800 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold truncate">
                        {cityIndex}. {city.name}
                      </span>
                      <span
                        className={`font-mono text-[11px] font-semibold tabular-nums shrink-0 ${
                          isSelected ? 'text-sky-100' : 'text-slate-700'
                        }`}
                      >
                        {city.totalAccidents.toLocaleString()} acc · 5×100
                      </span>
                    </div>
                    <div
                      className={`mt-0.5 text-[11px] truncate ${
                        isSelected ? 'text-sky-200' : 'text-slate-500'
                      }`}
                    >
                      {city.region} · {city.primaryRoads}
                    </div>
                  </button>
                );
                })}
              </div>
            </section>
            </>
          )}

          {/* Section 4: Coverage Area Optics & Overlays */}
          <section className="p-5">
            <div className="flex items-baseline justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-950">Camera Coverage Display</h2>
              <span className="font-mono text-xs tabular-nums text-slate-600">
                {singleAreaLabel}/cam
              </span>
            </div>

            <div className="mt-3 space-y-2.5">
              {!isCustomMode && (
                <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                  <span>Show 5 deployment sectors</span>
                  <input
                    type="checkbox"
                    checked={coverageConfig.showDeploymentSectors}
                    onChange={(e) =>
                      onUpdateCoverageConfig({ showDeploymentSectors: e.target.checked })
                    }
                    className="h-4 w-4 rounded border-slate-300 text-sky-800 focus:ring-sky-700"
                  />
                </label>
              )}

              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                <span>Show camera coverage areas</span>
                <input
                  type="checkbox"
                  checked={coverageConfig.showCoverageAreas}
                  onChange={(e) =>
                    onUpdateCoverageConfig({ showCoverageAreas: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-300 text-sky-800 focus:ring-sky-700"
                />
              </label>

              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                <span>Show 2021–2025 accident hotspots</span>
                <input
                  type="checkbox"
                  checked={coverageConfig.showAccidentHotspots}
                  onChange={(e) =>
                    onUpdateCoverageConfig({ showAccidentHotspots: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-300 text-sky-800 focus:ring-sky-700"
                />
              </label>

              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                <span>{isCustomMode ? 'Show study radius fill' : 'Show municipal boundaries'}</span>
                <input
                  type="checkbox"
                  checked={coverageConfig.showCityBoundaries}
                  onChange={(e) =>
                    onUpdateCoverageConfig({ showCityBoundaries: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-300 text-sky-800 focus:ring-sky-700"
                />
              </label>

              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                <span>Show bottom-left map legend</span>
                <input
                  type="checkbox"
                  checked={showMapLegend}
                  onChange={onToggleMapLegend}
                  className="h-4 w-4 rounded border-slate-300 text-sky-800 focus:ring-sky-700"
                />
              </label>
            </div>

            <div className="mt-4 space-y-3 border-t border-slate-100 pt-3.5">
              <div>
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="camera-range-slider" className="font-medium text-slate-700">
                    Detection Range
                  </label>
                  <span className="font-mono tabular-nums text-slate-900">
                    {coverageConfig.rangeMeters} m
                  </span>
                </div>
                <input
                  id="camera-range-slider"
                  type="range"
                  min={MIN_CAMERA_RANGE_M}
                  max={MAX_CAMERA_RANGE_M}
                  step={1}
                  value={coverageConfig.rangeMeters}
                  onChange={(e) =>
                    onUpdateCoverageConfig({ rangeMeters: Number(e.target.value) })
                  }
                  className="mt-1.5 h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 accent-sky-800"
                />
              </div>

              <div>
                <div className="flex items-center justify-between text-xs">
                  <label htmlFor="camera-fov-slider" className="font-medium text-slate-700">
                    Camera Field of View
                  </label>
                  <span className="font-mono tabular-nums text-slate-900">
                    {coverageConfig.fovDeg}°
                  </span>
                </div>
                <input
                  id="camera-fov-slider"
                  type="range"
                  min={MIN_CAMERA_FOV_DEG}
                  max={MAX_CAMERA_FOV_DEG}
                  step={5}
                  value={coverageConfig.fovDeg}
                  onChange={(e) =>
                    onUpdateCoverageConfig({ fovDeg: Number(e.target.value) })
                  }
                  className="mt-1.5 h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 accent-sky-800"
                />
              </div>
            </div>
          </section>

          {/* Section 5: Planned Camera Locations Table & CSV Export */}
          <section className="p-5">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-semibold text-slate-950 whitespace-nowrap">
                Planned Sites ({filteredCameras.length.toLocaleString()})
              </h2>
              <button
                type="button"
                onClick={handleDownloadCsv}
                className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-950 whitespace-nowrap shrink-0"
              >
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Download CSV</span>
              </button>
            </div>

            <div className="relative mt-3">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400"
                aria-hidden="true"
              />
              <input
                type="search"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowAllRows(false);
                }}
                aria-label="Filter planned cameras by ID, sector, road, city, or species"
                placeholder="Filter by ID, S1–S5, road, or species..."
                className="w-full rounded-md border border-slate-300 py-2 pl-8 pr-3 text-xs text-slate-900 placeholder:text-slate-400 focus:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-800"
              />
            </div>

            {filteredCameras.length === 0 ? (
              <div className="mt-3 rounded-lg border border-slate-200 p-4 text-center">
                <p className="text-xs text-slate-600">
                  No planned camera sites match &ldquo;{searchQuery}&rdquo;.
                </p>
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="mt-2 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                >
                  Clear Filter
                </button>
              </div>
            ) : (
              <>
                <div className="mt-3 divide-y divide-slate-100 border-y border-slate-200">
                  {displayedCameras.map((cam) => {
                    const isSelected = cam.id === selectedCameraId;
                    return (
                      <button
                        key={cam.id}
                        type="button"
                        onClick={() => {
                          onSelectCamera(cam);
                          onCloseMobile();
                        }}
                        className={`flex w-full items-center justify-between gap-2 px-2 py-2 text-left transition-colors ${
                          isSelected ? 'bg-amber-50/90 text-slate-950' : 'hover:bg-slate-50'
                        }`}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-mono text-xs font-semibold tabular-nums text-slate-900 whitespace-nowrap">
                              {cam.id}
                            </span>
                            <span aria-hidden="true" className="text-xs text-slate-300">
                              ·
                            </span>
                            <span className="text-xs text-slate-600 truncate">
                              {isCustomMode ? cam.roadLabel : `S${cam.sectorIndex} · ${cam.roadLabel}`}
                            </span>
                          </div>
                          <div className="mt-0.5 text-[11px] text-slate-500 truncate">
                            {cam.cityName} · {cam.sectorPeriod} · {cam.bearingDeg}°
                          </div>
                        </div>

                        <div className="text-right shrink-0">
                          <div className="font-mono text-xs font-semibold tabular-nums text-slate-900">
                            {cam.historicalAccidents} acc
                          </div>
                          <div className="font-mono text-[10px] tabular-nums text-slate-500">
                            {getDominantSpeciesLabel(cam)}
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>

                {filteredCameras.length > displayedCameras.length && (
                  <button
                    type="button"
                    onClick={() => setShowAllRows(true)}
                    className="mt-2.5 w-full min-h-9 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950"
                  >
                    Show more sites ({Math.min(250, filteredCameras.length)} of{' '}
                    {filteredCameras.length.toLocaleString()})
                  </button>
                )}
              </>
            )}
          </section>
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-slate-200">
          {/* Map Layer Mode */}
          <section className="p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Map Layer Mode</h2>
              <span className="text-xs text-slate-500">
                {mode === 'satellite' ? 'Aerial Imagery' : 'Cartographic Base'}
              </span>
            </div>

            <div
              role="group"
              aria-label="Select base map or satellite mode"
              className="mt-3 grid grid-cols-2 gap-1.5 rounded-lg bg-slate-100 p-1"
            >
              <button
                type="button"
                onClick={() => onModeChange('base')}
                aria-pressed={mode === 'base'}
                className={`min-h-10 rounded-md px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                  mode === 'base'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Base Map
              </button>
              <button
                type="button"
                onClick={() => onModeChange('satellite')}
                aria-pressed={mode === 'satellite'}
                className={`min-h-10 rounded-md px-3 py-2 text-xs font-semibold transition-colors whitespace-nowrap ${
                  mode === 'satellite'
                    ? 'bg-white text-sky-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Satellite
              </button>
            </div>

            <div className="mt-3.5 space-y-2.5">
              {mode === 'satellite' ? (
                <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                  <span>Overlay road &amp; place labels</span>
                  <input
                    type="checkbox"
                    checked={showLabels}
                    onChange={onToggleLabels}
                    className="h-4 w-4 rounded border-slate-300 text-sky-800 focus:ring-sky-700"
                  />
                </label>
              ) : (
                <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                  <span>Show topographic terrain relief</span>
                  <input
                    type="checkbox"
                    checked={showTerrain}
                    onChange={onToggleTerrain}
                    className="h-4 w-4 rounded border-slate-300 text-sky-800 focus:ring-sky-700"
                  />
                </label>
              )}

              {!usingGoogleMaps && (
                <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                  <span>Lat/Lng grid &amp; Arctic Circle</span>
                  <input
                    type="checkbox"
                    checked={showGraticule}
                    onChange={onToggleGraticule}
                    className="h-4 w-4 rounded border-slate-300 text-sky-800 focus:ring-sky-700"
                  />
                </label>
              )}

              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                <span>Show bottom-left map legend</span>
                <input
                  type="checkbox"
                  checked={showMapLegend}
                  onChange={onToggleMapLegend}
                  className="h-4 w-4 rounded border-slate-300 text-sky-800 focus:ring-sky-700"
                />
              </label>
            </div>
          </section>

          {/* Precision Zoom */}
          <section className="p-5">
            <div className="flex items-baseline justify-between">
              <label htmlFor="finland-zoom-slider" className="text-sm font-semibold text-slate-900">
                Zoom &amp; Scale
              </label>
              <span
                data-testid="sidebar-zoom-value"
                className="font-mono text-xs font-medium tabular-nums text-slate-700"
              >
                {camera.zoom.toFixed(1)}x · {formattedGroundRes}
              </span>
            </div>

            <div className="mt-3 flex items-center gap-2.5">
              <button
                type="button"
                onClick={onZoomOut}
                disabled={camera.zoom <= MIN_ZOOM}
                aria-label="Decrease zoom level"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Minus className="h-4 w-4" aria-hidden="true" />
              </button>

              <input
                id="finland-zoom-slider"
                type="range"
                min={MIN_ZOOM}
                max={MAX_ZOOM}
                step={0.1}
                value={camera.zoom}
                onChange={(e) => onZoomChange(Number(e.target.value))}
                className="h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 accent-sky-800"
              />

              <button
                type="button"
                onClick={onZoomIn}
                disabled={camera.zoom >= MAX_ZOOM}
                aria-label="Increase zoom level"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-700 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Plus className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            <div className="mt-3 grid grid-cols-2 gap-1.5">
              {ZOOM_PRESETS.map((preset) => {
                const isCurrent = Math.abs(camera.zoom - preset.zoom) < 0.25;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => onZoomChange(preset.zoom)}
                    className={`min-h-9 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap truncate ${
                      isCurrent
                        ? 'border-sky-800 bg-sky-50 text-sky-900'
                        : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50 hover:text-slate-900'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </section>

          {/* Regional Viewports */}
          <section className="p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-semibold text-slate-900">Regional Viewports</h2>
              <span className="text-xs text-slate-500">Finland Only</span>
            </div>

            <div className="mt-3 space-y-1">
              {FINLAND_REGIONS.map((region) => {
                const isSelected = activeRegionId === region.id;
                return (
                  <button
                    key={region.id}
                    type="button"
                    onClick={() => {
                      onSelectRegion(region);
                      onCloseMobile();
                    }}
                    className={`w-full rounded-lg px-3 py-2.5 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700 ${
                      isSelected
                        ? 'bg-slate-900 text-white'
                        : 'text-slate-800 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="text-xs font-semibold truncate">{region.name}</span>
                      <span
                        className={`font-mono text-[11px] tabular-nums shrink-0 ${
                          isSelected ? 'text-slate-300' : 'text-slate-500'
                        }`}
                      >
                        {region.zoom.toFixed(1)}x
                      </span>
                    </div>
                    <p
                      className={`mt-0.5 text-[11px] leading-snug ${
                        isSelected ? 'text-slate-300' : 'text-slate-500'
                      }`}
                    >
                      {region.summary}
                    </p>
                  </button>
                );
              })}
            </div>
          </section>

          {/* Validated Coordinate Jump */}
          <section className="p-5">
            <div className="flex items-center gap-2">
              <Compass className="h-4 w-4 text-slate-600" aria-hidden="true" />
              <h2 className="text-sm font-semibold text-slate-900">Go to Coordinates</h2>
            </div>
            <p className="mt-1 text-xs text-slate-500">
              Jump directly to any decimal latitude and longitude within Finland.
            </p>

            <form onSubmit={handleCoordinateSubmit} noValidate className="mt-3 space-y-3">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label
                    htmlFor="coord-lat-input"
                    className="block text-[11px] font-medium text-slate-700"
                  >
                    Latitude (°N)
                  </label>
                  <input
                    id="coord-lat-input"
                    type="text"
                    inputMode="decimal"
                    value={latInput}
                    onChange={(e) => {
                      setLatInput(e.target.value);
                      if (coordError) setCoordError(null);
                    }}
                    placeholder="60.3700"
                    className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-800"
                  />
                </div>

                <div>
                  <label
                    htmlFor="coord-lng-input"
                    className="block text-[11px] font-medium text-slate-700"
                  >
                    Longitude (°E)
                  </label>
                  <input
                    id="coord-lng-input"
                    type="text"
                    inputMode="decimal"
                    value={lngInput}
                    onChange={(e) => {
                      setLngInput(e.target.value);
                      if (coordError) setCoordError(null);
                    }}
                    placeholder="23.2100"
                    className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-2 font-mono text-xs tabular-nums text-slate-900 focus:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-800"
                  />
                </div>
              </div>

              {coordError && (
                <p role="alert" className="text-xs font-medium text-red-600">
                  {coordError}
                </p>
              )}

              <button
                type="submit"
                className="w-full min-h-10 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-800 whitespace-nowrap"
              >
                Zoom to Coordinates
              </button>
            </form>
          </section>
        </div>
      )}
    </aside>
  );
}
