import React from 'react';
import { Crosshair, Loader2, MapPin } from 'lucide-react';
import { RAMBOLL_DATA_SOURCE_URL } from '../data/finlandWildlifePlan';
import {
  CUSTOM_FINLAND_LOCATION_PRESETS,
  MAX_CUSTOM_RADIUS_KM,
  MIN_CUSTOM_RADIUS_KM,
  type CustomAreaPlanResult,
  type CustomLocationPreset,
} from '../types/customAreaPlan';

interface CustomAreaPlannerSectionProps {
  draftLat: string;
  draftLng: string;
  draftRadiusKm: number;
  draftLabel: string;
  selectedPresetId: string;
  isPickingCustomCenter: boolean;
  isLoadingCustomPlan: boolean;
  customPlanError: string | null;
  customAreaPlan: CustomAreaPlanResult | null;
  totalCoveredLabel: string;
  onDraftLatChange: (val: string) => void;
  onDraftLngChange: (val: string) => void;
  onDraftRadiusChange: (radiusKm: number) => void;
  onDraftLabelChange: (label: string) => void;
  onSelectPreset: (preset: CustomLocationPreset) => void;
  onTogglePickCenter: () => void;
  onDistributeCameras: () => void;
}

export function CustomAreaPlannerSection({
  draftLat,
  draftLng,
  draftRadiusKm,
  draftLabel,
  selectedPresetId,
  isPickingCustomCenter,
  isLoadingCustomPlan,
  customPlanError,
  customAreaPlan,
  totalCoveredLabel,
  onDraftLatChange,
  onDraftLngChange,
  onDraftRadiusChange,
  onDraftLabelChange,
  onSelectPreset,
  onTogglePickCenter,
  onDistributeCameras,
}: CustomAreaPlannerSectionProps) {
  const draftCircleAreaKm2 = Math.round(Math.PI * draftRadiusKm * draftRadiusKm);

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onDistributeCameras();
  };

  const handlePresetSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    const preset = CUSTOM_FINLAND_LOCATION_PRESETS.find((p) => p.id === val);
    if (preset) {
      onSelectPreset(preset);
    }
  };

  return (
    <>
      <section className="p-5">
        <div className="flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-slate-950">Custom Location &amp; Radius</h2>
          <span className="font-mono text-xs tabular-nums text-slate-500">100 Cameras</span>
        </div>

        <p className="mt-1 text-xs leading-relaxed text-slate-600">
          Pick any center and radius in Finland to pack 100 road-aligned cameras densely on
          high-priority 2021–2025 Ramboll collision stretches.
        </p>

        <form onSubmit={handleSubmit} noValidate className="mt-3.5 space-y-3">
          <div>
            <div className="flex items-center justify-between gap-2">
              <label
                htmlFor="custom-preset-select"
                className="text-[11px] font-medium text-slate-700"
              >
                Study Center
              </label>
              <button
                type="button"
                data-testid="pick-map-center-btn"
                aria-pressed={isPickingCustomCenter}
                onClick={onTogglePickCenter}
                className={`inline-flex min-h-7 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors whitespace-nowrap ${
                  isPickingCustomCenter
                    ? 'bg-amber-600 text-white shadow-xs'
                    : 'border border-slate-200 bg-slate-50 text-slate-800 hover:bg-slate-100'
                }`}
              >
                <Crosshair className="h-3.5 w-3.5" aria-hidden="true" />
                <span>{isPickingCustomCenter ? 'Click Map Now…' : 'Pick on Map'}</span>
              </button>
            </div>

            <select
              id="custom-preset-select"
              value={selectedPresetId}
              onChange={handlePresetSelectChange}
              className="mt-1.5 w-full rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-900 focus:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-800"
            >
              <option value="custom">Custom Map Coordinates</option>
              {CUSTOM_FINLAND_LOCATION_PRESETS.map((preset) => (
                <option key={preset.id} value={preset.id}>
                  {preset.name} ({preset.region})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2.5">
            <div>
              <label
                htmlFor="custom-lat-input"
                className="block text-[11px] font-medium text-slate-700"
              >
                Latitude (°N)
              </label>
              <input
                id="custom-lat-input"
                data-testid="custom-lat-input"
                type="text"
                inputMode="decimal"
                value={draftLat}
                onChange={(e) => onDraftLatChange(e.target.value)}
                placeholder="60.2486"
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-800"
              />
            </div>

            <div>
              <label
                htmlFor="custom-lng-input"
                className="block text-[11px] font-medium text-slate-700"
              >
                Longitude (°E)
              </label>
              <input
                id="custom-lng-input"
                data-testid="custom-lng-input"
                type="text"
                inputMode="decimal"
                value={draftLng}
                onChange={(e) => onDraftLngChange(e.target.value)}
                placeholder="24.0653"
                className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-xs tabular-nums text-slate-900 focus:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-800"
              />
            </div>
          </div>

          <div>
            <label
              htmlFor="custom-label-input"
              className="block text-[11px] font-medium text-slate-700"
            >
              Area Label (optional)
            </label>
            <input
              id="custom-label-input"
              type="text"
              value={draftLabel}
              onChange={(e) => onDraftLabelChange(e.target.value)}
              placeholder="e.g., Lohja Vt 1 Corridor"
              className="mt-1 w-full rounded-md border border-slate-300 px-2.5 py-1.5 text-xs text-slate-900 placeholder:text-slate-400 focus:border-sky-800 focus:outline-none focus:ring-1 focus:ring-sky-800"
            />
          </div>

          <div>
            <div className="flex items-center justify-between text-xs">
              <label htmlFor="custom-radius-slider" className="font-medium text-slate-700">
                Deployment Radius
              </label>
              <span
                data-testid="custom-radius-value"
                className="font-mono font-semibold tabular-nums text-slate-900"
              >
                {draftRadiusKm} km · {draftCircleAreaKm2.toLocaleString()} km²
              </span>
            </div>
            <input
              id="custom-radius-slider"
              data-testid="custom-radius-slider"
              type="range"
              min={MIN_CUSTOM_RADIUS_KM}
              max={MAX_CUSTOM_RADIUS_KM}
              step={1}
              value={draftRadiusKm}
              onChange={(e) => onDraftRadiusChange(Number(e.target.value))}
              className="mt-1.5 h-2 w-full cursor-pointer appearance-none rounded-lg bg-slate-200 accent-sky-800"
            />
            <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-slate-400">
              <span>{MIN_CUSTOM_RADIUS_KM} km</span>
              <span>25 km</span>
              <span>{MAX_CUSTOM_RADIUS_KM} km</span>
            </div>
          </div>

          {customPlanError && (
            <p role="alert" className="text-xs leading-snug font-medium text-rose-700">
              {customPlanError}
            </p>
          )}

          <button
            type="submit"
            data-testid="distribute-custom-cameras-btn"
            disabled={isLoadingCustomPlan}
            className="flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-sky-900 px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-sky-800 disabled:cursor-wait disabled:opacity-75 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-800 whitespace-nowrap"
          >
            {isLoadingCustomPlan ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                <span>Fetching Ramboll Data &amp; Roads…</span>
              </>
            ) : (
              <>
                <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Distribute 100 Cameras</span>
              </>
            )}
          </button>
        </form>
      </section>

      {customAreaPlan && (
        <section className="p-5" data-testid="custom-plan-summary">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-slate-950 truncate">
              {customAreaPlan.label} ({customAreaPlan.radiusKm} km)
            </h2>
            <span className="font-mono text-xs tabular-nums text-slate-500 shrink-0">
              {customAreaPlan.dataPeriod}
            </span>
          </div>

          <p className="mt-1 text-xs leading-relaxed text-slate-600">
            {customAreaPlan.cameras.length} cameras snapped onto {customAreaPlan.roadNetworkKm} km
            of public motor roads ({customAreaPlan.primaryRoads}).
          </p>

          <dl className="mt-3.5 grid grid-cols-3 gap-3 border-y border-slate-200 py-3">
            <div>
              <dt className="text-[11px] text-slate-500">Road Units</dt>
              <dd
                data-testid="custom-camera-count"
                className="mt-0.5 font-mono text-sm font-bold tabular-nums text-slate-950"
              >
                {customAreaPlan.cameras.length}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-slate-500">Collisions</dt>
              <dd
                data-testid="custom-accident-count"
                className="mt-0.5 font-mono text-sm font-bold tabular-nums text-slate-950"
              >
                {customAreaPlan.totalAccidentsInRadius.toLocaleString()}
              </dd>
            </div>
            <div>
              <dt className="text-[11px] text-slate-500">Area Covered</dt>
              <dd className="mt-0.5 font-mono text-sm font-bold tabular-nums text-sky-900">
                {totalCoveredLabel}
              </dd>
            </div>
          </dl>

          <div className="mt-2.5 space-y-1 text-[11px] text-slate-600">
            <div className="flex items-center justify-between gap-2">
              <span>Within 500 m of 100 cameras</span>
              <span className="font-mono font-semibold tabular-nums text-slate-900">
                {customAreaPlan.corridorAccidentsNearCameras.toLocaleString()} collisions
              </span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span>White-tailed · Roe · Moose</span>
              <span className="font-mono tabular-nums text-slate-800">
                {customAreaPlan.speciesTotals.whiteTailedDeer.toLocaleString()} ·{' '}
                {customAreaPlan.speciesTotals.roeDeer.toLocaleString()} ·{' '}
                {customAreaPlan.speciesTotals.moose.toLocaleString()}
              </span>
            </div>
            {(customAreaPlan.speciesTotals.fallowDeer > 0 ||
              customAreaPlan.speciesTotals.forestReindeer > 0) && (
              <div className="flex items-center justify-between gap-2">
                <span>Fallow deer · Forest reindeer</span>
                <span className="font-mono tabular-nums text-slate-800">
                  {customAreaPlan.speciesTotals.fallowDeer.toLocaleString()} ·{' '}
                  {customAreaPlan.speciesTotals.forestReindeer.toLocaleString()}
                </span>
              </div>
            )}
          </div>

          <div className="mt-2.5 flex items-center justify-between gap-2 border-t border-slate-100 pt-2 text-[11px] text-slate-500">
            <span className="font-mono tabular-nums">
              {customAreaPlan.areaKm2.toLocaleString()} km² circle
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
      )}
    </>
  );
}
