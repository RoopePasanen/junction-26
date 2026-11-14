import {
  Check,
  Eye,
  EyeOff,
  Lasso,
  Layers,
  LocateFixed,
  Map as MapIcon,
  Minus,
  Pentagon,
  Plus,
  SlidersHorizontal,
  Undo2,
  X,
} from 'lucide-react';
import type { PlannedCameraNode } from '../data/finlandWildlifePlan';
import type { CameraCoverageConfig } from '../utils/cameraPlanGeometry';
import type { SimulationSummary, SimulatorConfig } from '../utils/crossingSimulator';
import {
  calculateScaleBar,
  formatLat,
  formatLng,
  MAX_ZOOM,
  MIN_ZOOM,
  type BaseMapMode,
  type CameraState,
  type LatLngPoint,
} from '../utils/mapMath';
import type {
  CustomAreaPlanResult,
  DrawingToolMode,
} from '../types/customAreaPlan';
import { computePolygonAreaKm2 } from '../utils/polygonGeometry';
import { CameraSitePlanCard } from './CameraSitePlanCard';

interface MapControlsOverlayProps {
  camera: CameraState;
  cursorPoint: LatLngPoint | null;
  mode: BaseMapMode;
  showLabels: boolean;
  showTerrain: boolean;
  showMapLegend: boolean;
  usingGoogleMaps: boolean;
  mobilePanelOpen: boolean;
  selectedCamera: PlannedCameraNode | null;
  coverageConfig: CameraCoverageConfig;
  visibleCameraCount: number;
  simulationSummary: SimulationSummary;
  simulatorConfig: SimulatorConfig;
  areasOfInterest: CustomAreaPlanResult[];
  drawingMode?: DrawingToolMode;
  drawnPolygon?: LatLngPoint[];
  draftPolygonVertices?: LatLngPoint[];
  onModeChange: (mode: BaseMapMode) => void;
  onToggleLabels: () => void;
  onToggleTerrain: () => void;
  onToggleMapLegend: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onResetFinlandView: () => void;
  onToggleMobilePanel: () => void;
  onZoomToCamera: (camera: PlannedCameraNode) => void;
  onRemoveArea?: (areaId: string) => void;
  onCloseCameraCard: () => void;
  onSwitchDrawingMode?: (mode: 'freehand' | 'polygon') => void;
  onFinishPolygonDraft?: () => void;
  onUndoPolygonVertex?: () => void;
  onCancelDrawing?: () => void;
}

export function MapControlsOverlay({
  camera,
  cursorPoint,
  mode,
  showLabels,
  showTerrain,
  showMapLegend,
  usingGoogleMaps,
  mobilePanelOpen,
  selectedCamera,
  coverageConfig,
  visibleCameraCount,
  simulationSummary,
  simulatorConfig,
  areasOfInterest,
  drawingMode = 'none',
  drawnPolygon = [],
  draftPolygonVertices = [],
  onModeChange,
  onToggleLabels,
  onToggleTerrain,
  onToggleMapLegend,
  onZoomIn,
  onZoomOut,
  onResetFinlandView,
  onToggleMobilePanel,
  onZoomToCamera,
  onRemoveArea,
  onCloseCameraCard,
  onSwitchDrawingMode,
  onFinishPolygonDraft,
  onUndoPolygonVertex,
  onCancelDrawing,
}: MapControlsOverlayProps) {
  const scaleBar = calculateScaleBar(camera.center.lat, camera.zoom, 116);
  const activeCoord = cursorPoint ?? camera.center;
  const isSatellite = mode === 'satellite';

  const drawnAreaKm2 = computePolygonAreaKm2(drawnPolygon);

  const selectedCameraAreaCount = selectedCamera
    ? areasOfInterest.find((a) => a.id === selectedCamera.cityId)?.cameras.length
    : undefined;

  const cameraLegendSummary =
    areasOfInterest.length > 0
      ? `${visibleCameraCount.toLocaleString()} road cameras across ${areasOfInterest.length} ${
          areasOfInterest.length === 1 ? 'area' : 'areas'
        }`
      : drawnPolygon.length >= 3
        ? `Draft area (${drawnAreaKm2.toFixed(1)} km²) — enter camera count & place`
        : 'Empty map — draw an area of interest to plot cameras';

  const yearTag =
    simulationSummary.selectedYear === 'all'
      ? 'All yrs'
      : String(simulationSummary.selectedYear);

  return (
    <div className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between p-3 sm:p-4">
      {/* Top Row: Mobile Drawer Trigger / Selected Camera Card (left) + Active Drawing Banner + Floating Mode Switcher (right) */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col items-start gap-2.5">
          <div className="pointer-events-auto lg:hidden">
            <button
              type="button"
              onClick={onToggleMobilePanel}
              aria-expanded={mobilePanelOpen}
              aria-controls="finland-map-sidebar"
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white/95 px-3.5 py-2 text-xs font-semibold text-slate-800 shadow-sm backdrop-blur transition-colors hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 whitespace-nowrap shrink-0"
            >
              <SlidersHorizontal className="h-4 w-4 text-slate-600" aria-hidden="true" />
              <span>Plan &amp; Map Controls</span>
            </button>
          </div>

          {selectedCamera && (
            <CameraSitePlanCard
              camera={selectedCamera}
              areaTotalCameras={selectedCameraAreaCount}
              coverageConfig={coverageConfig}
              onZoomToCamera={onZoomToCamera}
              onRemoveArea={onRemoveArea}
              onClose={onCloseCameraCard}
            />
          )}
        </div>

        {drawingMode !== 'none' && (
          <div
            role="status"
            data-testid="drawing-mode-banner"
            className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg border border-amber-300 bg-amber-50/96 px-3.5 py-2 text-xs font-medium text-amber-950 shadow-sm backdrop-blur"
          >
            {drawingMode === 'freehand' ? (
              <>
                <Lasso className="h-4 w-4 shrink-0 text-amber-800" aria-hidden="true" />
                <span>Drag on map to outline area of interest</span>
                {onSwitchDrawingMode && (
                  <button
                    type="button"
                    onClick={() => onSwitchDrawingMode('polygon')}
                    className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-950 hover:bg-amber-100 whitespace-nowrap"
                  >
                    Polygon Corners
                  </button>
                )}
              </>
            ) : (
              <>
                <Pentagon className="h-4 w-4 shrink-0 text-amber-800" aria-hidden="true" />
                <span>
                  Click map to place corners ({draftPolygonVertices.length}{' '}
                  {draftPolygonVertices.length === 1 ? 'pt' : 'pts'})
                </span>
                {draftPolygonVertices.length >= 3 && onFinishPolygonDraft && (
                  <button
                    type="button"
                    onClick={onFinishPolygonDraft}
                    className="inline-flex items-center gap-1 rounded bg-amber-700 px-2 py-0.5 text-[11px] font-semibold text-white hover:bg-amber-800 whitespace-nowrap"
                  >
                    <Check className="h-3 w-3" aria-hidden="true" />
                    <span>Finish Area</span>
                  </button>
                )}
                {draftPolygonVertices.length >= 1 && onUndoPolygonVertex && (
                  <button
                    type="button"
                    onClick={onUndoPolygonVertex}
                    className="inline-flex items-center gap-1 rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-950 hover:bg-amber-100 whitespace-nowrap"
                  >
                    <Undo2 className="h-3 w-3" aria-hidden="true" />
                    <span>Undo</span>
                  </button>
                )}
                {onSwitchDrawingMode && (
                  <button
                    type="button"
                    onClick={() => onSwitchDrawingMode('freehand')}
                    className="rounded border border-amber-300 bg-white px-2 py-0.5 text-[11px] font-semibold text-amber-950 hover:bg-amber-100 whitespace-nowrap"
                  >
                    Freehand
                  </button>
                )}
              </>
            )}

            {onCancelDrawing && (
              <button
                type="button"
                onClick={onCancelDrawing}
                aria-label="Cancel area drawing"
                className="ml-0.5 inline-flex h-6 w-6 items-center justify-center rounded text-amber-900 hover:bg-amber-200/70"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>
        )}

        <div className="pointer-events-auto flex items-center gap-2 rounded-lg border border-slate-200/90 bg-white/95 p-1 shadow-sm backdrop-blur">
          <div role="group" aria-label="Map display mode" className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onModeChange('base')}
              aria-pressed={!isSatellite}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700 ${
                !isSatellite
                  ? 'bg-slate-900 text-white shadow-xs'
                  : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <MapIcon className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Base Map</span>
            </button>

            <button
              type="button"
              onClick={() => onModeChange('satellite')}
              aria-pressed={isSatellite}
              className={`inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700 ${
                isSatellite
                  ? 'bg-sky-800 text-white shadow-xs'
                  : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              <Layers className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Satellite</span>
            </button>
          </div>

          <div className="hidden sm:block h-5 w-px bg-slate-200" aria-hidden="true" />

          {isSatellite ? (
            <button
              type="button"
              onClick={onToggleLabels}
              aria-pressed={showLabels}
              className={`hidden sm:inline-flex min-h-9 items-center rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700 ${
                showLabels
                  ? 'bg-sky-50 text-sky-900 ring-1 ring-inset ring-sky-200'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              Labels {showLabels ? 'On' : 'Off'}
            </button>
          ) : (
            <button
              type="button"
              onClick={onToggleTerrain}
              aria-pressed={showTerrain}
              className={`hidden sm:inline-flex min-h-9 items-center rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors whitespace-nowrap shrink-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700 ${
                showTerrain
                  ? 'bg-sky-50 text-sky-900 ring-1 ring-inset ring-sky-200'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'
              }`}
            >
              Terrain {showTerrain ? 'On' : 'Off'}
            </button>
          )}
        </div>
      </div>

      {/* Bottom Row: Scale, Legend & Coordinates (left) + Tactile Zoom Stack (right) */}
      <div className="flex items-end justify-between gap-3">
        {showMapLegend ? (
          <div
            data-testid="map-bottom-legend"
            className="pointer-events-auto rounded-lg border border-slate-200/90 bg-white/95 px-3 py-2 shadow-sm backdrop-blur"
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 pb-1.5 mb-1.5">
              <div className="hidden sm:flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
                <span className="font-mono font-semibold tabular-nums text-slate-800">
                  {cameraLegendSummary}
                </span>
                {visibleCameraCount > 0 && coverageConfig.showCoverageAreas && (
                  <>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2.5 w-3.5 rounded-xs border border-sky-700 bg-sky-500/25"
                      />
                      <span>
                        Cones ({coverageConfig.rangeMeters} m · 2×{coverageConfig.fovDeg}°)
                      </span>
                    </span>
                  </>
                )}
                {areasOfInterest.length > 0 && coverageConfig.showAccidentHotspots && (
                  <>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2.5 w-2.5 rounded-full bg-red-600/45"
                      />
                      <span>2021–2025 hotspot</span>
                    </span>
                  </>
                )}
                {simulationSummary.totalEvents > 0 && simulatorConfig.showDetectedHeatmap && (
                  <>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="inline-flex items-center gap-1.5 font-medium text-emerald-800">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2.5 w-2.5 rotate-45 bg-emerald-500 ring-2 ring-emerald-500/30"
                      />
                      <span className="font-mono tabular-nums">
                        {yearTag} · Detected ({simulationSummary.detectedCount.toLocaleString()} ·{' '}
                        {simulationSummary.detectionRatePct.toFixed(1)}%)
                      </span>
                    </span>
                  </>
                )}
                {simulationSummary.totalEvents > 0 && simulatorConfig.showMissedHeatmap && (
                  <>
                    <span aria-hidden="true" className="text-slate-300">
                      ·
                    </span>
                    <span className="inline-flex items-center gap-1.5 font-medium text-rose-800">
                      <span
                        aria-hidden="true"
                        className="inline-block h-2.5 w-2.5 rotate-45 bg-rose-500 ring-2 ring-rose-500/30"
                      />
                      <span className="font-mono tabular-nums">
                        Missed ({simulationSummary.missedCount.toLocaleString()})
                      </span>
                    </span>
                  </>
                )}
              </div>

              <span className="sm:hidden font-mono text-[11px] font-semibold tabular-nums text-slate-800">
                {visibleCameraCount.toLocaleString()} cameras · {areasOfInterest.length} areas
              </span>

              <button
                type="button"
                onClick={onToggleMapLegend}
                aria-label="Hide map legend"
                title="Hide bottom-left legend"
                className="inline-flex min-h-6 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700 whitespace-nowrap shrink-0"
              >
                <EyeOff className="h-3 w-3" aria-hidden="true" />
                <span>Hide legend</span>
              </button>
            </div>

            <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] font-mono tabular-nums text-slate-700">
              <span>{cursorPoint ? 'Cursor' : 'Center'}</span>
              <span aria-hidden="true" className="text-slate-300">
                ·
              </span>
              <span>{formatLat(activeCoord.lat)}</span>
              <span aria-hidden="true" className="text-slate-300">
                ·
              </span>
              <span>{formatLng(activeCoord.lng)}</span>
            </div>

            <div className="mt-1.5 flex items-center gap-2.5">
              <div className="flex flex-col">
                <div
                  style={{ width: `${scaleBar.pixelWidth}px` }}
                  className="h-1.5 border-x-2 border-b-2 border-slate-800 transition-all duration-150"
                  aria-hidden="true"
                />
              </div>
              <span
                data-testid="scale-bar-label"
                className="text-[11px] font-mono font-medium tabular-nums text-slate-800 whitespace-nowrap"
              >
                {scaleBar.label}
              </span>
              {!usingGoogleMaps && (
                <>
                  <span aria-hidden="true" className="text-slate-300 text-[11px]">
                    ·
                  </span>
                  <span className="hidden md:inline text-[10px] text-slate-500 whitespace-nowrap">
                    Tiles © Esri · OpenStreetMap · Collisions © Riistakeskus / Ramboll (local)
                  </span>
                </>
              )}
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={onToggleMapLegend}
            aria-label="Show map legend"
            className="pointer-events-auto inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-200/90 bg-white/95 px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm backdrop-blur transition-colors hover:bg-slate-50 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 whitespace-nowrap shrink-0"
          >
            <Eye className="h-3.5 w-3.5 text-slate-600" aria-hidden="true" />
            <span>Show legend</span>
          </button>
        )}

        {/* Tactile Zoom Stack */}
        <div
          role="group"
          aria-label="Map zoom controls"
          className="pointer-events-auto flex flex-col items-center overflow-hidden rounded-lg border border-slate-200/90 bg-white/95 shadow-sm backdrop-blur"
        >
          <button
            type="button"
            onClick={onZoomIn}
            disabled={camera.zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            className="flex h-10 w-10 items-center justify-center text-slate-800 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-sky-700"
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
          </button>

          <div
            aria-live="polite"
            data-testid="hud-zoom-readout"
            className="w-10 border-y border-slate-200 py-1 text-center font-mono text-[11px] font-semibold tabular-nums text-slate-700 select-none"
          >
            {camera.zoom.toFixed(1)}
          </div>

          <button
            type="button"
            onClick={onZoomOut}
            disabled={camera.zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            className="flex h-10 w-10 items-center justify-center text-slate-800 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-sky-700"
          >
            <Minus className="h-4 w-4" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={onResetFinlandView}
            aria-label="Fit entire Finland map"
            title="Fit entire Finland map"
            className="flex h-10 w-10 items-center justify-center border-t border-slate-200 text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-950 focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-sky-700"
          >
            <LocateFixed className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
