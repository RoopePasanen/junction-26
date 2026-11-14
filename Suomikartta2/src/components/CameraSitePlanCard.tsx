import { Focus, Trash2, X } from 'lucide-react';
import type { PlannedCameraNode } from '../data/finlandWildlifePlan';
import {
  calculateSingleCameraAreaSqMeters,
  getCameraBearings,
  getCameraPriorityTier,
  getDominantSpeciesLabel,
  type CameraCoverageConfig,
} from '../utils/cameraPlanGeometry';
import { formatLat, formatLng } from '../utils/mapMath';

interface CameraSitePlanCardProps {
  camera: PlannedCameraNode;
  areaTotalCameras?: number;
  coverageConfig: CameraCoverageConfig;
  onZoomToCamera: (camera: PlannedCameraNode) => void;
  onRemoveArea?: (areaId: string) => void;
  onClose: () => void;
}

const PRIORITY_LABELS = {
  critical: 'Critical Hotspot Tier',
  high: 'High Prevalence Tier',
  elevated: 'Prominent Corridor Tier',
} as const;

export function CameraSitePlanCard({
  camera,
  areaTotalCameras,
  coverageConfig,
  onZoomToCamera,
  onRemoveArea,
  onClose,
}: CameraSitePlanCardProps) {
  const areaSqM = calculateSingleCameraAreaSqMeters(
    coverageConfig.rangeMeters,
    coverageConfig.fovDeg
  );
  const areaHa = areaSqM / 10_000;
  const tier = getCameraPriorityTier(camera.rankInCity);
  const dominantSpecies = getDominantSpeciesLabel(camera);
  const [primaryBearing, reverseBearing] = getCameraBearings(camera);

  const unitLabel =
    areaTotalCameras && areaTotalCameras > 0
      ? `Unit #${camera.unitNumber}/${areaTotalCameras}`
      : `Unit #${camera.unitNumber}`;

  return (
    <section
      aria-label={`Planned camera ${camera.id} details`}
      className="pointer-events-auto w-76 sm:w-80 rounded-lg border border-slate-200/95 bg-white/96 p-4 shadow-sm backdrop-blur"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[11px] text-slate-500 whitespace-nowrap">
            <span className="font-semibold text-slate-700 truncate max-w-32">
              {camera.cityName}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono tabular-nums">{unitLabel}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate">{PRIORITY_LABELS[tier]}</span>
          </div>
          <h3 className="mt-0.5 font-mono text-sm font-bold tabular-nums text-slate-950">
            {camera.id}
          </h3>
          <p className="mt-0.5 text-[11px] font-medium text-sky-900 truncate">
            {camera.clusterLabel}
          </p>
        </div>

        <button
          type="button"
          onClick={onClose}
          aria-label="Close camera site details"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-sky-700"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2.5 border-y border-slate-200 py-3 text-xs">
        <div>
          <dt className="text-[11px] text-slate-500">Covered Area</dt>
          <dd className="mt-0.5 font-mono font-semibold tabular-nums text-slate-900">
            {areaSqM < 100
              ? `${areaSqM.toFixed(1)} m²`
              : `${Math.round(areaSqM).toLocaleString('en-US')} m²`}{' '}
            ({areaHa >= 0.01 ? `${areaHa.toFixed(2)} ha` : `${areaHa.toFixed(4)} ha`})
          </dd>
        </div>

        <div>
          <dt className="text-[11px] text-slate-500">Optics &amp; Bearings</dt>
          <dd className="mt-0.5 font-mono font-semibold tabular-nums text-slate-900">
            {coverageConfig.rangeMeters} m · 2×{coverageConfig.fovDeg}° · {primaryBearing}°/{reverseBearing}°
          </dd>
        </div>

        <div>
          <dt className="text-[11px] text-slate-500">2021–2025 Collisions</dt>
          <dd className="mt-0.5 font-mono font-semibold tabular-nums text-rose-700">
            {camera.historicalAccidents} in corridor
          </dd>
        </div>

        <div>
          <dt className="text-[11px] text-slate-500">Dominant Species</dt>
          <dd className="mt-0.5 font-medium text-slate-900 truncate">{dominantSpecies}</dd>
        </div>
      </dl>

      <div className="mt-2.5 space-y-1 text-[11px] text-slate-600">
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500">Mounting</span>
          <span className="font-mono tabular-nums text-slate-800">Roadside · Both road directions</span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500">Species Mix</span>
          <span className="font-mono tabular-nums text-slate-800">
            WTD {camera.whiteTailedDeer} · Roe {camera.roeDeer} · Moose {camera.moose}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-slate-500">Coordinates</span>
          <span className="font-mono tabular-nums text-slate-800">
            {formatLat(camera.lat)} · {formatLng(camera.lng)}
          </span>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onZoomToCamera(camera)}
          className="inline-flex flex-1 min-h-9 items-center justify-center gap-1.5 rounded-md bg-slate-900 px-3 py-2 text-xs font-semibold text-white transition-colors hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-700 whitespace-nowrap"
        >
          <Focus className="h-3.5 w-3.5" aria-hidden="true" />
          <span>Zoom to Site</span>
        </button>

        {onRemoveArea && (
          <button
            type="button"
            onClick={() => onRemoveArea(camera.cityId)}
            title={`Remove ${camera.cityName}`}
            className="inline-flex min-h-9 items-center justify-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-xs font-medium text-rose-700 transition-colors hover:border-rose-200 hover:bg-rose-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-rose-700 whitespace-nowrap shrink-0"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Remove Area</span>
          </button>
        )}
      </div>
    </section>
  );
}
