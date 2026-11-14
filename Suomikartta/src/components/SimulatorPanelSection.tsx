import React, { useMemo, useRef, useState } from 'react';
import { Download, FileSpreadsheet, Play, Trash2, Upload } from 'lucide-react';
import {
  SECTOR_IDS,
  SECTOR_ROTATION_SCHEDULE,
  type SectorFilter,
} from '../data/finlandWildlifePlan';
import {
  MAX_CAMERA_FOV_DEG,
  MAX_CAMERA_RANGE_M,
  MIN_CAMERA_FOV_DEG,
  MIN_CAMERA_RANGE_M,
  type CameraCoverageConfig,
} from '../utils/cameraPlanGeometry';
import {
  buildEvaluatedResultsWorkbook,
  buildSampleTemplateWorkbook,
  CAMERA_ARRANGEMENTS,
  parseCrossingSpreadsheetBuffer,
  type AnimalSizeCategory,
  type CameraArrangementId,
  type CrossingEvent,
  type EvaluatedCrossingEvent,
  type SimulationSummary,
  type SimulatorConfig,
} from '../utils/crossingSimulator';
import type { CustomAreaPlanResult, PlanScopeMode } from '../types/customAreaPlan';

interface SimulatorPanelSectionProps {
  datasetName: string | null;
  rawEventCount: number;
  evaluatedEvents: EvaluatedCrossingEvent[];
  simulationSummary: SimulationSummary;
  simulatorConfig: SimulatorConfig;
  coverageConfig: CameraCoverageConfig;
  selectedSector: SectorFilter;
  selectedEventId: string | null;
  planScope?: PlanScopeMode;
  customAreaPlan?: CustomAreaPlanResult | null;
  onLoadEvents: (events: CrossingEvent[], sourceLabel: string) => void;
  onLoadDemoDataset: () => void;
  onClearDataset: () => void;
  onSelectSector: (sector: SectorFilter) => void;
  onUpdateSimulatorConfig: (patch: Partial<SimulatorConfig>) => void;
  onUpdateCoverageConfig: (patch: Partial<CameraCoverageConfig>) => void;
  onFocusCrossingEvent: (event: EvaluatedCrossingEvent) => void;
}

export function SimulatorPanelSection({
  datasetName,
  rawEventCount,
  evaluatedEvents,
  simulationSummary,
  simulatorConfig,
  coverageConfig,
  selectedSector,
  selectedEventId,
  planScope = 'top5',
  customAreaPlan = null,
  onLoadEvents,
  onLoadDemoDataset,
  onClearDataset,
  onSelectSector,
  onUpdateSimulatorConfig,
  onUpdateCoverageConfig,
  onFocusCrossingEvent,
}: SimulatorPanelSectionProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [skippedNotice, setSkippedNotice] = useState<number>(0);
  const [eventStatusFilter, setEventStatusFilter] = useState<'all' | 'detected' | 'missed'>('all');
  const [showAllEvents, setShowAllEvents] = useState<boolean>(false);

  const activeArrangement = useMemo(
    () =>
      CAMERA_ARRANGEMENTS.find((a) => a.id === simulatorConfig.arrangementId) ??
      CAMERA_ARRANGEMENTS[0],
    [simulatorConfig.arrangementId]
  );

  const visibleLogEvents = useMemo(() => {
    if (eventStatusFilter === 'detected') {
      return evaluatedEvents.filter((e) => e.detected);
    }
    if (eventStatusFilter === 'missed') {
      return evaluatedEvents.filter((e) => !e.detected);
    }
    return evaluatedEvents;
  }, [evaluatedEvents, eventStatusFilter]);

  const displayedLogRows = useMemo(
    () => (showAllEvents ? visibleLogEvents.slice(0, 200) : visibleLogEvents.slice(0, 25)),
    [visibleLogEvents, showAllEvents]
  );

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const buffer = await file.arrayBuffer();
      const parsed = parseCrossingSpreadsheetBuffer(buffer);
      if (!parsed.valid) {
        setUploadError(parsed.error ?? 'Failed to parse spreadsheet.');
        setSkippedNotice(0);
      } else {
        setUploadError(null);
        setSkippedNotice(parsed.skippedRows);
        setShowAllEvents(false);
        onLoadEvents(parsed.events, file.name);
      }
    } catch {
      setUploadError('Unable to read the selected file. Please try an .xlsx or .csv spreadsheet.');
      setSkippedNotice(0);
    } finally {
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleDownloadTemplate = () => {
    const bytes = buildSampleTemplateWorkbook();
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'wildlife-crossing-template.xlsx';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const isCustomScope = planScope === 'custom';
  const arrangementExportLabel =
    isCustomScope && customAreaPlan
      ? `Custom 100 Road Cameras (${customAreaPlan.label} · ${customAreaPlan.radiusKm} km)`
      : activeArrangement.label;

  const handleExportResults = () => {
    if (evaluatedEvents.length === 0) return;
    const bytes = buildEvaluatedResultsWorkbook(
      evaluatedEvents,
      arrangementExportLabel,
      coverageConfig.rangeMeters,
      coverageConfig.fovDeg
    );
    const blob = new Blob([bytes], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    const yearSuffix =
      simulatorConfig.selectedYear === 'all' ? 'all-years' : String(simulatorConfig.selectedYear);
    const scopeSlug = isCustomScope ? 'custom-radius' : simulatorConfig.arrangementId;
    anchor.download = `crossing-simulation-${yearSuffix}-${scopeSlug}-${coverageConfig.rangeMeters}m.xlsx`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  const totalInCoveredCitiesAllYears =
    rawEventCount - simulationSummary.excludedOutsideCitiesCount;

  return (
    <div className="flex flex-col divide-y divide-slate-200">
      {/* Section 1: Test Dataset Upload & Demo Seed */}
      <section className="p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-950">Crossing Event Dataset</h2>
          {datasetName && (
            <button
              type="button"
              onClick={() => {
                setUploadError(null);
                setSkippedNotice(0);
                onClearDataset();
              }}
              aria-label="Clear loaded crossing dataset"
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-rose-700 whitespace-nowrap"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              <span>Clear</span>
            </button>
          )}
        </div>

        <p className="mt-1 text-xs leading-snug text-slate-600">
          Import Excel (<span className="font-mono">.xlsx</span>) or CSV with{' '}
          <span className="font-mono text-slate-800">event_id</span>,{' '}
          <span className="font-mono text-slate-800">date</span>,{' '}
          <span className="font-mono text-slate-800">latitude</span>,{' '}
          <span className="font-mono text-slate-800">longitude</span>, and{' '}
          <span className="font-mono text-slate-800">animal_size</span> (small / large).
        </p>

        <div className="mt-3 space-y-2">
          <input
            ref={fileInputRef}
            id="crossing-excel-upload"
            type="file"
            accept=".xlsx,.xls,.csv,.tsv"
            onChange={handleFileChange}
            className="sr-only"
          />
          <label
            htmlFor="crossing-excel-upload"
            className="flex min-h-9 w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-sky-800 whitespace-nowrap"
          >
            <Upload className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Upload Excel / CSV Sheet</span>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                setUploadError(null);
                setSkippedNotice(0);
                onLoadDemoDataset();
              }}
              className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 transition-colors hover:bg-slate-50 whitespace-nowrap"
            >
              <Play className="h-3.5 w-3.5 text-sky-800" aria-hidden="true" />
              <span>Load Demo (3 yrs)</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadTemplate}
              className="inline-flex min-h-8 items-center justify-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 whitespace-nowrap"
            >
              <FileSpreadsheet className="h-3.5 w-3.5 text-slate-500" aria-hidden="true" />
              <span>Template (.xlsx)</span>
            </button>
          </div>
        </div>

        {uploadError && (
          <p role="alert" className="mt-2 text-xs leading-snug font-medium text-rose-700">
            {uploadError}
          </p>
        )}

        {datasetName && !uploadError && (
          <div className="mt-2 space-y-0.5 text-[11px] text-slate-600">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium text-slate-800">{datasetName}</span>
              <span
                data-testid="sim-covered-scope"
                className="font-mono tabular-nums text-slate-700 whitespace-nowrap shrink-0"
              >
                {isCustomScope && customAreaPlan
                  ? `${totalInCoveredCitiesAllYears.toLocaleString()} in ${customAreaPlan.radiusKm} km`
                  : `${totalInCoveredCitiesAllYears.toLocaleString()} in 5 cities`}
              </span>
            </div>
            {(simulationSummary.excludedOutsideCitiesCount > 0 || skippedNotice > 0) && (
              <div className="font-mono text-[10.5px] tabular-nums text-slate-500">
                {simulationSummary.excludedOutsideCitiesCount > 0
                  ? isCustomScope
                    ? `${simulationSummary.excludedOutsideCitiesCount.toLocaleString()} outside radius excluded`
                    : `${simulationSummary.excludedOutsideCitiesCount.toLocaleString()} outside camera cities excluded`
                  : ''}
                {simulationSummary.excludedOutsideCitiesCount > 0 && skippedNotice > 0
                  ? ' · '
                  : ''}
                {skippedNotice > 0 ? `${skippedNotice} invalid skipped` : ''}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Section 2: Year Selector, Heatmap Results & Sector Rotation */}
      <section className="p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-950">Detected vs. Missed Heatmap</h2>
          {simulationSummary.totalEvents > 0 && (
            <span
              data-testid="sim-detection-rate"
              className="font-mono text-xs font-bold tabular-nums text-emerald-700 whitespace-nowrap"
            >
              {simulationSummary.detectionRatePct.toFixed(1)}% hit
            </span>
          )}
        </div>

        {isCustomScope && !customAreaPlan ? (
          <p className="mt-1.5 text-xs leading-relaxed text-amber-800">
            Open the Plan tab and click &ldquo;Distribute 100 Cameras&rdquo; to deploy cameras in
            your custom radius before running simulations.
          </p>
        ) : rawEventCount === 0 ? (
          <p className="mt-1.5 text-xs leading-relaxed text-slate-500">
            {isCustomScope && customAreaPlan
              ? `Upload your Excel crossing sheet or load demo events inside ${customAreaPlan.label} (${customAreaPlan.radiusKm} km radius).`
              : 'Upload your Excel crossing sheet or load the 3-year demo dataset above. Each 1-year mapping cycle rotates 100 cameras/city across 5 sectors (73 days per sector).'}
          </p>
        ) : totalInCoveredCitiesAllYears === 0 ? (
          <p role="status" className="mt-2 text-xs leading-relaxed text-amber-800">
            {isCustomScope && customAreaPlan
              ? `0 of ${rawEventCount.toLocaleString()} uploaded events fall within ${customAreaPlan.radiusKm} km of ${customAreaPlan.label}.`
              : `0 of ${rawEventCount.toLocaleString()} uploaded events fall within the 5 camera-covered cities (Salo, Raasepori, Pori, Hämeenlinna, Sastamala).`}
          </p>
        ) : (
          <>
            {/* Year Selector for 1-Year Mapping Cycle */}
            {simulationSummary.availableYears.length > 0 && (
              <div className="mt-2.5">
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="font-medium text-slate-700">Mapping Year (1-yr cycle)</span>
                  <span className="font-mono tabular-nums text-slate-500">
                    {simulationSummary.coveredEventsInSelectedYear.toLocaleString()} area events
                  </span>
                </div>

                {simulationSummary.availableYears.length <= 4 ? (
                  <div
                    role="group"
                    aria-label="Select simulation year"
                    className="mt-1.5 flex items-center gap-1 rounded-lg bg-slate-100 p-1"
                  >
                    {simulationSummary.availableYears.map((yr) => {
                      const isSelected = simulatorConfig.selectedYear === yr;
                      return (
                        <button
                          key={yr}
                          type="button"
                          aria-pressed={isSelected}
                          onClick={() => {
                            onUpdateSimulatorConfig({ selectedYear: yr });
                            setShowAllEvents(false);
                          }}
                          className={`flex-1 min-h-7 rounded-md px-2 py-1 font-mono text-xs font-semibold tabular-nums transition-colors whitespace-nowrap ${
                            isSelected
                              ? 'bg-sky-900 text-white shadow-xs'
                              : 'text-slate-700 hover:text-slate-950'
                          }`}
                        >
                          {yr}
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      aria-pressed={simulatorConfig.selectedYear === 'all'}
                      onClick={() => {
                        onUpdateSimulatorConfig({ selectedYear: 'all' });
                        setShowAllEvents(false);
                      }}
                      className={`flex-1 min-h-7 rounded-md px-2 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                        simulatorConfig.selectedYear === 'all'
                          ? 'bg-slate-900 text-white shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      All
                    </button>
                  </div>
                ) : (
                  <select
                    aria-label="Select simulation year"
                    value={
                      simulatorConfig.selectedYear === 'all'
                        ? 'all'
                        : String(simulatorConfig.selectedYear)
                    }
                    onChange={(e) => {
                      const v = e.target.value;
                      onUpdateSimulatorConfig({
                        selectedYear: v === 'all' ? 'all' : Number(v),
                      });
                      setShowAllEvents(false);
                    }}
                    className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-mono text-xs font-semibold tabular-nums text-slate-900 focus:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-800"
                  >
                    {simulationSummary.availableYears.map((yr) => (
                      <option key={yr} value={String(yr)}>
                        {yr} (1-year mapping cycle)
                      </option>
                    ))}
                    <option value="all">All Years Combined</option>
                  </select>
                )}
              </div>
            )}

            <dl className="mt-3 grid grid-cols-3 gap-3 border-y border-slate-200 py-2.5">
              <div>
                <dt className="text-[11px] text-slate-500">In Scope</dt>
                <dd
                  data-testid="sim-total-events"
                  className="mt-0.5 font-mono text-sm font-bold tabular-nums text-slate-950"
                >
                  {simulationSummary.totalEvents.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-slate-500">Detected</dt>
                <dd
                  data-testid="sim-detected-events"
                  className="mt-0.5 font-mono text-sm font-bold tabular-nums text-emerald-700"
                >
                  {simulationSummary.detectedCount.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-slate-500">Missed</dt>
                <dd
                  data-testid="sim-missed-events"
                  className="mt-0.5 font-mono text-sm font-bold tabular-nums text-rose-700"
                >
                  {simulationSummary.missedCount.toLocaleString()}
                </dd>
              </div>
            </dl>

            <div className="mt-2 space-y-1 text-[11px] font-mono tabular-nums text-slate-600">
              <div className="flex flex-wrap items-center gap-x-2">
                <span>
                  Large: {simulationSummary.largeDetected}/{simulationSummary.largeTotal} (
                  {simulationSummary.largeRatePct.toFixed(0)}%)
                </span>
                <span aria-hidden="true" className="text-slate-300">
                  ·
                </span>
                <span>
                  Small: {simulationSummary.smallDetected}/{simulationSummary.smallTotal} (
                  {simulationSummary.smallRatePct.toFixed(0)}%)
                </span>
              </div>
              {!isCustomScope && activeArrangement.isRotational && (
                <div className="text-[10.5px] text-slate-500">
                  In active 73-d sector: {simulationSummary.inActiveSectorEventsCount} · Other 4
                  sectors: {simulationSummary.outOfWindowEventsCount}
                </div>
              )}
            </div>

            {/* Sector Inspection Filter inside Simulator */}
            {!isCustomScope && activeArrangement.isRotational && (
              <div className="mt-2.5 border-t border-slate-100 pt-2.5">
                <div className="flex items-baseline justify-between gap-2 text-[11px]">
                  <span className="font-medium text-slate-700">Inspect Sector (0.2 yr each)</span>
                  <span className="font-mono tabular-nums text-slate-500">
                    {selectedSector === 'all'
                      ? 'All 5 sectors'
                      : SECTOR_ROTATION_SCHEDULE[selectedSector].shortPeriod}
                  </span>
                </div>
                <div
                  role="group"
                  aria-label="Inspect sector in simulator"
                  className="mt-1.5 grid grid-cols-6 gap-1 rounded-lg bg-slate-100 p-1"
                >
                  <button
                    type="button"
                    aria-pressed={selectedSector === 'all'}
                    onClick={() => onSelectSector('all')}
                    className={`min-h-7 rounded-md px-1 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                      selectedSector === 'all'
                        ? 'bg-white text-slate-950 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    All 5
                  </button>
                  {SECTOR_IDS.map((sId) => {
                    const active = selectedSector === sId;
                    return (
                      <button
                        key={sId}
                        type="button"
                        aria-pressed={active}
                        onClick={() => onSelectSector(active ? 'all' : sId)}
                        className={`min-h-7 rounded-md px-1 py-1 font-mono text-xs font-semibold tabular-nums transition-colors whitespace-nowrap ${
                          active
                            ? 'bg-sky-900 text-white shadow-xs'
                            : 'text-slate-700 hover:text-slate-950'
                        }`}
                      >
                        S{sId}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            <div
              role="group"
              aria-label="Filter crossings by animal size"
              className="mt-2.5 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1"
            >
              {(['all', 'large', 'small'] as const).map((sz) => {
                const active = simulatorConfig.sizeFilter === sz;
                const label = sz === 'all' ? 'All Sizes' : sz === 'large' ? 'Large' : 'Small';
                return (
                  <button
                    key={sz}
                    type="button"
                    aria-pressed={active}
                    onClick={() =>
                      onUpdateSimulatorConfig({
                        sizeFilter: sz as 'all' | AnimalSizeCategory,
                      })
                    }
                    className={`min-h-7 rounded-md px-2 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                      active
                        ? 'bg-white text-slate-950 shadow-xs'
                        : 'text-slate-600 hover:text-slate-900'
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="mt-2.5 space-y-2">
              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                <span>Show detected events heatmap</span>
                <input
                  type="checkbox"
                  checked={simulatorConfig.showDetectedHeatmap}
                  onChange={(e) =>
                    onUpdateSimulatorConfig({ showDetectedHeatmap: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-300 text-emerald-700 focus:ring-emerald-700"
                />
              </label>

              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                <span>Show missed events heatmap</span>
                <input
                  type="checkbox"
                  checked={simulatorConfig.showMissedHeatmap}
                  onChange={(e) =>
                    onUpdateSimulatorConfig({ showMissedHeatmap: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-300 text-rose-700 focus:ring-rose-700"
                />
              </label>

              <label className="flex cursor-pointer items-center justify-between gap-3 text-xs text-slate-700">
                <span>Show individual event pins (zoom ≥ 11x)</span>
                <input
                  type="checkbox"
                  checked={simulatorConfig.showEventPoints}
                  onChange={(e) =>
                    onUpdateSimulatorConfig({ showEventPoints: e.target.checked })
                  }
                  className="h-4 w-4 rounded border-slate-300 text-sky-800 focus:ring-sky-700"
                />
              </label>
            </div>
          </>
        )}
      </section>

      {/* Section 3: Camera Arrangement & Detection Range */}
      <section className="p-4">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-950">Camera Arrangement</h2>
          <span className="font-mono text-xs tabular-nums text-slate-500">
            {isCustomScope ? '100 custom road units' : '100 hw / city'}
          </span>
        </div>

        {isCustomScope ? (
          <p className="mt-2 text-xs leading-relaxed text-slate-600">
            {customAreaPlan
              ? `Testing ${customAreaPlan.cameras.length} Ramboll hotspot-weighted road cameras in ${customAreaPlan.label} (${customAreaPlan.radiusKm} km radius).`
              : 'Distribute 100 cameras in a custom radius under the Plan tab to evaluate custom road deployments.'}
          </p>
        ) : (
          <div
            role="radiogroup"
            aria-label="Select camera arrangement to test"
            className="mt-2.5 space-y-1.5"
          >
            {CAMERA_ARRANGEMENTS.map((arr) => {
              const isSelected = simulatorConfig.arrangementId === arr.id;
              return (
                <button
                  key={arr.id}
                  type="button"
                  role="radio"
                  aria-checked={isSelected}
                  onClick={() =>
                    onUpdateSimulatorConfig({ arrangementId: arr.id as CameraArrangementId })
                  }
                  className={`w-full rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700 ${
                    isSelected
                      ? 'bg-sky-900 text-white'
                      : 'bg-slate-50 text-slate-800 hover:bg-slate-100'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-xs font-semibold whitespace-nowrap">{arr.shortLabel}</span>
                    <span
                      className={`font-mono text-[11px] tabular-nums whitespace-nowrap shrink-0 ${
                        isSelected ? 'text-sky-200' : 'text-slate-500'
                      }`}
                    >
                      {arr.spacingSummary}
                    </span>
                  </div>
                  <p
                    className={`mt-0.5 text-[11px] leading-snug ${
                      isSelected ? 'text-sky-100' : 'text-slate-500'
                    }`}
                  >
                    {arr.description}
                  </p>
                </button>
              );
            })}
          </div>
        )}

        <div className="mt-3.5 space-y-3 border-t border-slate-100 pt-3">
          <div>
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="sim-range-slider" className="font-medium text-slate-700">
                Detection Range
              </label>
              <span className="font-mono tabular-nums text-slate-900">
                {coverageConfig.rangeMeters} m
              </span>
            </div>
            <input
              id="sim-range-slider"
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
              <label htmlFor="sim-fov-slider" className="font-medium text-slate-700">
                Camera Field of View
              </label>
              <span className="font-mono tabular-nums text-slate-900">
                {coverageConfig.fovDeg}°
              </span>
            </div>
            <input
              id="sim-fov-slider"
              type="range"
              min={MIN_CAMERA_FOV_DEG}
              max={MAX_CAMERA_FOV_DEG}
              step={5}
              value={coverageConfig.fovDeg}
              onChange={(e) => onUpdateCoverageConfig({ fovDeg: Number(e.target.value) })}
              className="mt-1.5 h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 accent-sky-800"
            />
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-3 pt-0.5 text-xs text-slate-700">
            <span>Small animal range factor (70%)</span>
            <input
              type="checkbox"
              checked={simulatorConfig.scaleRangeByAnimalSize}
              onChange={(e) =>
                onUpdateSimulatorConfig({ scaleRangeByAnimalSize: e.target.checked })
              }
              className="h-4 w-4 rounded border-slate-300 text-sky-800 focus:ring-sky-700"
            />
          </label>
        </div>
      </section>

      {/* Section 4: Evaluated Event Log & Export */}
      {rawEventCount > 0 && (
        <section className="p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-950 whitespace-nowrap">
              Crossing Log ({visibleLogEvents.length})
            </h2>
            <button
              type="button"
              onClick={handleExportResults}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-50 hover:text-slate-950 whitespace-nowrap shrink-0"
            >
              <Download className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Export (.xlsx)</span>
            </button>
          </div>

          <div
            role="group"
            aria-label="Filter log by detection outcome"
            className="mt-2.5 grid grid-cols-3 gap-1 rounded-lg bg-slate-100 p-1"
          >
            {(['all', 'detected', 'missed'] as const).map((status) => {
              const active = eventStatusFilter === status;
              const label =
                status === 'all' ? 'All' : status === 'detected' ? 'Detected' : 'Missed';
              return (
                <button
                  key={status}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    setEventStatusFilter(status);
                    setShowAllEvents(false);
                  }}
                  className={`min-h-7 rounded-md px-2 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-white text-slate-950 shadow-xs'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {visibleLogEvents.length === 0 ? (
            <p className="mt-3 text-center text-xs text-slate-500">
              No crossing events match the current filter.
            </p>
          ) : (
            <>
              <div className="mt-2.5 divide-y divide-slate-100 border-y border-slate-200">
                {displayedLogRows.map((ev) => {
                  const isSelected = ev.eventId === selectedEventId;
                  return (
                    <button
                      key={ev.eventId}
                      type="button"
                      onClick={() => onFocusCrossingEvent(ev)}
                      className={`flex w-full flex-col gap-0.5 px-2 py-2 text-left transition-colors ${
                        isSelected ? 'bg-amber-50/90 text-slate-950' : 'hover:bg-slate-50'
                      }`}
                    >
                      <div className="flex w-full items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className="font-mono text-xs font-semibold tabular-nums text-slate-900 whitespace-nowrap">
                            {ev.eventId}
                          </span>
                          <span aria-hidden="true" className="text-xs text-slate-300">
                            ·
                          </span>
                          <span className="text-xs text-slate-600 truncate">
                            {ev.cityName} S{ev.eventSpatialSector}
                          </span>
                          <span aria-hidden="true" className="text-xs text-slate-300">
                            ·
                          </span>
                          <span className="text-xs capitalize text-slate-700 whitespace-nowrap">
                            {ev.animalSize}
                          </span>
                        </div>
                        <span
                          className={`font-mono text-xs font-semibold whitespace-nowrap shrink-0 ${
                            ev.detected ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          {ev.detected ? 'Detected' : 'Missed'}
                        </span>
                      </div>

                      <div className="flex w-full items-center justify-between gap-2 text-[11px] text-slate-500">
                        <span className="truncate">
                          {ev.detected
                            ? `Caught by ${ev.detectedByCameraId} (${ev.nearestDistanceM} m)`
                            : !ev.camerasPresentInEventSector
                              ? `Cameras in S${ev.activeRotationSector} · Event in S${ev.eventSpatialSector}`
                              : `S${ev.eventSpatialSector} active · Nearest ${ev.nearestDistanceM.toLocaleString()} m`}
                        </span>
                        <span className="font-mono tabular-nums text-slate-400 whitespace-nowrap shrink-0">
                          {ev.date}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>

              {visibleLogEvents.length > displayedLogRows.length && (
                <button
                  type="button"
                  onClick={() => setShowAllEvents(true)}
                  className="mt-2.5 w-full min-h-9 rounded-md border border-slate-200 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950"
                >
                  Show more events ({Math.min(200, visibleLogEvents.length)} of{' '}
                  {visibleLogEvents.length})
                </button>
              )}
            </>
          )}
        </section>
      )}
    </div>
  );
}
