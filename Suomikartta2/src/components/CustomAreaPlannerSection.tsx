import React, { useMemo } from 'react';
import {
  Check,
  Eraser,
  Lasso,
  Loader2,
  MapPin,
  Pentagon,
  Plus,
  RotateCcw,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import { RAMBOLL_DATA_SOURCE_URL } from '../data/finlandWildlifePlan';
import {
  CUSTOM_FINLAND_LOCATION_PRESETS,
  MAX_PLOTTED_CAMERAS,
  MIN_PLOTTED_CAMERAS,
  type CustomAreaPlanResult,
  type CustomLocationPreset,
  type DrawingToolMode,
} from '../types/customAreaPlan';
import type { CameraCoverageConfig } from '../utils/cameraPlanGeometry';
import type { LatLngPoint } from '../utils/mapMath';
import {
  computePolygonAreaKm2,
  polygonsApproximatelyEqual,
} from '../utils/polygonGeometry';

interface CustomAreaPlannerSectionProps {
  areasOfInterest: CustomAreaPlanResult[];
  selectedAreaId: string | null;
  drawingMode: DrawingToolMode;
  drawnPolygon: LatLngPoint[];
  draftPolygonVertices: LatLngPoint[];
  cameraCountInput: string;
  draftLabel: string;
  selectedPresetId: string;
  coverageConfig: CameraCoverageConfig;
  isLoadingCustomPlan: boolean;
  customPlanError: string | null;
  totalCoveredLabel: string;
  onStartDrawing: (mode: 'freehand' | 'polygon') => void;
  onStartNewArea: () => void;
  onFinishPolygonDraft: () => void;
  onUndoPolygonVertex: () => void;
  onCancelDrawing: () => void;
  onClearDrawnArea: () => void;
  onCameraCountInputChange: (val: string) => void;
  onDraftLabelChange: (label: string) => void;
  onSelectPreset: (preset: CustomLocationPreset) => void;
  onResetDefaultOptics: () => void;
  onPlotCameras: () => void;
  onSelectArea: (area: CustomAreaPlanResult) => void;
  onRemoveArea: (areaId: string) => void;
  onRemoveAllAreas: () => void;
}

export function CustomAreaPlannerSection({
  areasOfInterest,
  selectedAreaId,
  drawingMode,
  drawnPolygon,
  draftPolygonVertices,
  cameraCountInput,
  draftLabel,
  selectedPresetId,
  coverageConfig,
  isLoadingCustomPlan,
  customPlanError,
  totalCoveredLabel,
  onStartDrawing,
  onStartNewArea,
  onFinishPolygonDraft,
  onUndoPolygonVertex,
  onCancelDrawing,
  onClearDrawnArea,
  onCameraCountInputChange,
  onDraftLabelChange,
  onSelectPreset,
  onResetDefaultOptics,
  onPlotCameras,
  onSelectArea,
  onRemoveArea,
  onRemoveAllAreas,
}: CustomAreaPlannerSectionProps) {
  const selectedArea = useMemo(
    () => areasOfInterest.find((a) => a.id === selectedAreaId) ?? null,
    [areasOfInterest, selectedAreaId]
  );

  const effectiveVertices =
    drawingMode === 'polygon' && draftPolygonVertices.length >= 3
      ? draftPolygonVertices
      : drawnPolygon;

  const drawnAreaKm2 = useMemo(
    () => computePolygonAreaKm2(effectiveVertices),
    [effectiveVertices]
  );

  const parsedCameraCount = useMemo(() => {
    const num = Number(cameraCountInput.trim());
    if (!Number.isFinite(num)) return null;
    const rounded = Math.round(num);
    if (rounded < MIN_PLOTTED_CAMERAS || rounded > MAX_PLOTTED_CAMERAS) return null;
    return rounded;
  }, [cameraCountInput]);

  const isEditingExistingArea = useMemo(
    () =>
      Boolean(
        selectedArea &&
          drawingMode === 'none' &&
          drawnPolygon.length >= 3 &&
          polygonsApproximatelyEqual(drawnPolygon, selectedArea.polygon)
      ),
    [drawingMode, drawnPolygon, selectedArea]
  );

  const isDefaultOptics =
    coverageConfig.rangeMeters === 60 && coverageConfig.fovDeg === 30;

  const totalCamerasAcrossAreas = useMemo(
    () => areasOfInterest.reduce((sum, area) => sum + area.cameras.length, 0),
    [areasOfInterest]
  );

  const totalCollisionsAcrossAreas = useMemo(
    () => areasOfInterest.reduce((sum, area) => sum + area.totalAccidentsInRadius, 0),
    [areasOfInterest]
  );

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onPlotCameras();
  };

  const handlePresetSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    const preset = CUSTOM_FINLAND_LOCATION_PRESETS.find((p) => p.id === val);
    if (preset) {
      onSelectPreset(preset);
    }
  };

  const primaryButtonLabel = useMemo(() => {
    const countPart = parsedCameraCount !== null ? `${parsedCameraCount.toLocaleString()} ` : '';
    const noun = parsedCameraCount === 1 ? 'Camera' : 'Cameras';
    if (isEditingExistingArea) {
      return `Update Area (${countPart}${noun})`;
    }
    return `Place ${countPart}${noun}`;
  }, [isEditingExistingArea, parsedCameraCount]);

  return (
    <>
      {/* Section 1: Add or Update Area of Interest */}
      <section className="p-5">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-950">
            {isEditingExistingArea ? 'Edit Area of Interest' : 'Add Area of Interest'}
          </h2>
          {isEditingExistingArea ? (
            <button
              type="button"
              data-testid="new-area-btn"
              onClick={onStartNewArea}
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] font-semibold text-slate-800 transition-colors hover:bg-slate-100 whitespace-nowrap shrink-0"
            >
              <Plus className="h-3 w-3" aria-hidden="true" />
              <span>New Area</span>
            </button>
          ) : (
            <span className="font-mono text-xs tabular-nums text-slate-500">
              {coverageConfig.fovDeg}° · {coverageConfig.rangeMeters} m
            </span>
          )}
        </div>

        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          {isEditingExistingArea
            ? `Adjust camera count or name for ${selectedArea?.label}, or click New Area to draw another area of interest.`
            : 'Draw an area of interest on the map, write how many cameras to add, and plot them along public roads using offline wildlife collision history.'}
        </p>

        <form onSubmit={handleSubmit} noValidate className="mt-3.5 space-y-3.5">
          {/* Step 1: Draw Area on Map */}
          <div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-slate-700">
                1. Outline Area on Map
              </span>
              {drawnPolygon.length >= 3 && drawingMode === 'none' && !isEditingExistingArea && (
                <button
                  type="button"
                  onClick={onClearDrawnArea}
                  className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-500 hover:text-rose-700 whitespace-nowrap"
                >
                  <Eraser className="h-3 w-3" aria-hidden="true" />
                  <span>Clear draft</span>
                </button>
              )}
            </div>

            <div className="mt-1.5 grid grid-cols-2 gap-2">
              <button
                type="button"
                data-testid="draw-freehand-btn"
                aria-pressed={drawingMode === 'freehand'}
                onClick={() =>
                  drawingMode === 'freehand' ? onCancelDrawing() : onStartDrawing('freehand')
                }
                className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  drawingMode === 'freehand'
                    ? 'bg-amber-600 text-white shadow-xs'
                    : 'border border-slate-200 bg-slate-50 text-slate-800 hover:bg-slate-100'
                }`}
              >
                <Lasso className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{drawingMode === 'freehand' ? 'Drawing Lasso…' : 'Draw Freehand'}</span>
              </button>

              <button
                type="button"
                data-testid="draw-polygon-btn"
                aria-pressed={drawingMode === 'polygon'}
                onClick={() =>
                  drawingMode === 'polygon' ? onCancelDrawing() : onStartDrawing('polygon')
                }
                className={`inline-flex min-h-9 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap ${
                  drawingMode === 'polygon'
                    ? 'bg-amber-600 text-white shadow-xs'
                    : 'border border-slate-200 bg-slate-50 text-slate-800 hover:bg-slate-100'
                }`}
              >
                <Pentagon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{drawingMode === 'polygon' ? 'Placing Corners…' : 'Draw Polygon'}</span>
              </button>
            </div>

            {drawingMode === 'freehand' && (
              <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50/80 px-2.5 py-2 text-[11px] text-amber-950">
                <span>Press and drag across the map to outline a new area.</span>
                <button
                  type="button"
                  onClick={onCancelDrawing}
                  className="inline-flex items-center gap-1 font-semibold text-amber-900 hover:underline whitespace-nowrap shrink-0"
                >
                  <X className="h-3 w-3" aria-hidden="true" />
                  <span>Cancel</span>
                </button>
              </div>
            )}

            {drawingMode === 'polygon' && (
              <div className="mt-2 space-y-2 rounded-md border border-amber-200 bg-amber-50/80 px-2.5 py-2 text-[11px] text-amber-950">
                <div className="flex items-center justify-between gap-2">
                  <span>
                    Click map corners ({draftPolygonVertices.length}{' '}
                    {draftPolygonVertices.length === 1 ? 'pt' : 'pts'} placed).
                  </span>
                  <button
                    type="button"
                    onClick={onCancelDrawing}
                    className="inline-flex items-center gap-1 font-semibold text-amber-900 hover:underline whitespace-nowrap shrink-0"
                  >
                    <X className="h-3 w-3" aria-hidden="true" />
                    <span>Cancel</span>
                  </button>
                </div>

                {draftPolygonVertices.length > 0 && (
                  <div className="flex items-center gap-2">
                    {draftPolygonVertices.length >= 3 && (
                      <button
                        type="button"
                        onClick={onFinishPolygonDraft}
                        className="inline-flex min-h-7 flex-1 items-center justify-center gap-1 rounded bg-amber-700 px-2.5 py-1 text-xs font-semibold text-white hover:bg-amber-800 whitespace-nowrap"
                      >
                        <Check className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>Finish Area ({drawnAreaKm2.toFixed(1)} km²)</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={onUndoPolygonVertex}
                      className="inline-flex min-h-7 items-center justify-center gap-1 rounded border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-950 hover:bg-amber-100 whitespace-nowrap"
                    >
                      <Undo2 className="h-3 w-3" aria-hidden="true" />
                      <span>Undo</span>
                    </button>
                  </div>
                )}
              </div>
            )}

            {drawingMode === 'none' && (
              <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-slate-600">
                {drawnPolygon.length >= 3 ? (
                  <span
                    data-testid="drawn-area-readout"
                    className="font-mono font-medium tabular-nums text-slate-800"
                  >
                    {isEditingExistingArea ? 'Selected area' : 'Draft area ready'} ·{' '}
                    {drawnAreaKm2.toFixed(1)} km² · {drawnPolygon.length} vertices
                  </span>
                ) : (
                  <span className="text-slate-500">
                    Draw directly on the map or pick a starter region below
                  </span>
                )}
              </div>
            )}

            <div className="mt-2">
              <label htmlFor="custom-preset-select" className="sr-only">
                Jump to Finland starter area
              </label>
              <select
                id="custom-preset-select"
                value={selectedPresetId}
                onChange={handlePresetSelectChange}
                className="w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-800 focus:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-800"
              >
                <option value="custom">
                  {drawnPolygon.length >= 3
                    ? 'Drawn Map Area'
                    : 'Jump to starter region (optional)…'}
                </option>
                {CUSTOM_FINLAND_LOCATION_PRESETS.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.name} ({preset.region})
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Step 2: Camera Count & Area Name */}
          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label
                htmlFor="camera-count-input"
                className="block text-[11px] font-medium text-slate-700"
              >
                2. Cameras to Add
              </label>
              <input
                id="camera-count-input"
                data-testid="camera-count-input"
                type="number"
                inputMode="numeric"
                min={MIN_PLOTTED_CAMERAS}
                max={MAX_PLOTTED_CAMERAS}
                step={1}
                value={cameraCountInput}
                onChange={(e) => onCameraCountInputChange(e.target.value)}
                placeholder="50"
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs font-semibold tabular-nums text-slate-900 focus:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-800"
              />
            </div>

            <div>
              <label
                htmlFor="custom-label-input"
                className="block text-[11px] font-medium text-slate-700"
              >
                Area Name (optional)
              </label>
              <input
                id="custom-label-input"
                type="text"
                value={draftLabel}
                onChange={(e) => onDraftLabelChange(e.target.value)}
                placeholder="e.g., Area of Interest 1"
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-800"
              />
            </div>
          </div>

          {/* Roadside Optics & Offline Dataset Info */}
          <div className="space-y-1 border-t border-slate-100 pt-2.5 text-[11px] text-slate-600">
            <div className="flex items-center justify-between gap-2">
              <span>
                Roadside · Both directions ·{' '}
                <span className="font-mono font-semibold tabular-nums text-slate-900">
                  2×{coverageConfig.fovDeg}° FOV · {coverageConfig.rangeMeters} m
                </span>
              </span>
              {!isDefaultOptics && (
                <button
                  type="button"
                  onClick={onResetDefaultOptics}
                  className="inline-flex items-center gap-1 font-medium text-sky-800 hover:text-sky-950 whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="h-3 w-3" aria-hidden="true" />
                  <span>60 m / 30°</span>
                </button>
              )}
            </div>
            <div className="font-mono text-[10.5px] tabular-nums text-slate-500">
              Offline Ramboll wildlife data · 67,081 collisions stored locally
            </div>
          </div>

          {customPlanError && (
            <p role="alert" className="text-xs leading-snug font-medium text-rose-700">
              {customPlanError}
            </p>
          )}

          <button
            type="submit"
            data-testid="plot-cameras-btn"
            disabled={
              isLoadingCustomPlan || effectiveVertices.length < 3 || parsedCameraCount === null
            }
            className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-sky-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-sky-800 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-800 whitespace-nowrap"
          >
            {isLoadingCustomPlan ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                <span>Plotting Roadside Cameras…</span>
              </>
            ) : (
              <>
                <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                <span>
                  {effectiveVertices.length < 3
                    ? 'Draw an Area on Map First'
                    : primaryButtonLabel}
                </span>
              </>
            )}
          </button>
        </form>
      </section>

      {/* Section 2: User-Added Areas of Interest List (Removable) */}
      <section className="p-5" data-testid="areas-of-interest-section">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-950">
            Areas of Interest ({areasOfInterest.length})
          </h2>
          {areasOfInterest.length > 0 && (
            <button
              type="button"
              data-testid="remove-all-areas-btn"
              onClick={onRemoveAllAreas}
              className="inline-flex items-center gap-1 text-xs font-medium text-slate-500 transition-colors hover:text-rose-700 whitespace-nowrap shrink-0"
            >
              <Trash2 className="h-3 w-3" aria-hidden="true" />
              <span>{areasOfInterest.length === 1 ? 'Clear Map' : 'Remove All'}</span>
            </button>
          )}
        </div>

        {areasOfInterest.length === 0 ? (
          <p
            data-testid="empty-areas-state"
            className="mt-2 text-xs leading-relaxed text-slate-500"
          >
            The map is empty. Draw an area of interest above, enter a camera count, and place
            cameras along roads. Added areas will appear here and can be removed at any time.
          </p>
        ) : (
          <>
            <dl className="mt-3 grid grid-cols-3 gap-3 border-y border-slate-200 py-3">
              <div>
                <dt className="text-[11px] text-slate-500">Road Units</dt>
                <dd
                  data-testid="total-plotted-cameras"
                  className="mt-0.5 font-mono text-sm font-bold tabular-nums text-slate-950"
                >
                  {totalCamerasAcrossAreas.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-slate-500">Collisions</dt>
                <dd
                  data-testid="total-area-collisions"
                  className="mt-0.5 font-mono text-sm font-bold tabular-nums text-slate-950"
                >
                  {totalCollisionsAcrossAreas.toLocaleString()}
                </dd>
              </div>
              <div>
                <dt className="text-[11px] text-slate-500">Area Covered</dt>
                <dd className="mt-0.5 font-mono text-sm font-bold tabular-nums text-sky-900">
                  {totalCoveredLabel}
                </dd>
              </div>
            </dl>

            <div className="mt-3 divide-y divide-slate-100 border-b border-slate-200">
              {areasOfInterest.map((area) => {
                const isSelected = area.id === selectedAreaId;
                return (
                  <div
                    key={area.id}
                    data-testid={`area-row-${area.id}`}
                    className={`flex items-center justify-between gap-2 py-2.5 px-2 rounded-md transition-colors ${
                      isSelected ? 'bg-sky-50/90' : 'hover:bg-slate-50'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => onSelectArea(area)}
                      className="min-w-0 flex-1 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700"
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className={`text-xs font-semibold truncate ${
                            isSelected ? 'text-sky-950' : 'text-slate-900'
                          }`}
                        >
                          {area.label}
                        </span>
                        <span className="font-mono text-[11px] font-semibold tabular-nums text-slate-800 shrink-0">
                          {area.cameras.length.toLocaleString()} cam
                        </span>
                      </div>
                      <div className="mt-0.5 font-mono text-[11px] tabular-nums text-slate-500 truncate">
                        {area.areaKm2} km² · {area.roadNetworkKm} km roads ·{' '}
                        {area.totalAccidentsInRadius.toLocaleString()} acc
                      </div>
                    </button>

                    <button
                      type="button"
                      data-testid={`remove-area-${area.id}`}
                      onClick={() => onRemoveArea(area.id)}
                      aria-label={`Remove ${area.label}`}
                      title={`Remove ${area.label}`}
                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-700 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-rose-700"
                    >
                      <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                    </button>
                  </div>
                );
              })}
            </div>

            {selectedArea && (
              <div className="mt-3 space-y-1 text-[11px] text-slate-600">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-slate-800 truncate">
                    {selectedArea.label} ({selectedArea.primaryRoads})
                  </span>
                  <span className="font-mono tabular-nums text-slate-500 shrink-0">
                    {selectedArea.dataPeriod}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>Within 500 m of area cameras</span>
                  <span className="font-mono font-semibold tabular-nums text-slate-900">
                    {selectedArea.corridorAccidentsNearCameras.toLocaleString()} collisions
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span>White-tailed · Roe · Moose</span>
                  <span className="font-mono tabular-nums text-slate-800">
                    {selectedArea.speciesTotals.whiteTailedDeer.toLocaleString()} ·{' '}
                    {selectedArea.speciesTotals.roeDeer.toLocaleString()} ·{' '}
                    {selectedArea.speciesTotals.moose.toLocaleString()}
                  </span>
                </div>
                <div className="flex items-center justify-between gap-2 pt-1 text-slate-500">
                  <span className="font-mono tabular-nums">
                    {selectedArea.offlineDatasetRecords.toLocaleString()} local Finland pts
                  </span>
                  <a
                    href={RAMBOLL_DATA_SOURCE_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-sky-800 underline decoration-sky-800/40 underline-offset-2 hover:text-sky-950 whitespace-nowrap"
                  >
                    Source Info
                  </a>
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </>
  );
}
