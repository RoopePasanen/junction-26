/**
 * Photo viewer for the "Latest detections" list.
 *
 * - Uploaded photos (real board): the thumbnail the unit sent, with its boxes drawn.
 * - Real camera sightings: no photo, by design (camera pictures never leave the unit).
 * - Simulated detections: an example roadside photo, clearly labelled as an example.
 *
 * Left / right arrows step through the list, Esc closes.
 */
import { useEffect } from 'react';
import { CameraOff, ChevronLeft, ChevronRight, MapPin, X } from 'lucide-react';
import { examplePhoto, type Detection } from '../../utils/pilotSimulation';

export type PhotoKind = 'real' | 'example' | 'none';

export function photoFor(d: Detection): { src: string | null; kind: PhotoKind } {
  if (d.thumb) return { src: d.thumb, kind: 'real' };
  if (d.source === 'simulated') return { src: examplePhoto(d), kind: 'example' };
  return { src: null, kind: 'none' };
}

const CLASS_LABEL: Record<Detection['class'], string> = {
  warn_animal: 'Deer / moose',
  small_animal: 'Small animal',
};

export function DetectionPhotoModal({
  detections,
  index,
  siteName,
  onIndex,
  onClose,
  onShowOnMap,
}: {
  detections: Detection[];
  index: number;
  siteName: (d: Detection) => string;
  onIndex: (i: number) => void;
  onClose: () => void;
  onShowOnMap: (d: Detection) => void;
}) {
  const d = detections[index];
  const hasPrev = index > 0;
  const hasNext = index < detections.length - 1;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft' && hasPrev) onIndex(index - 1);
      else if (e.key === 'ArrowRight' && hasNext) onIndex(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, hasPrev, hasNext, onIndex, onClose]);

  if (!d) return null;
  const { src, kind } = photoFor(d);
  const when = new Date(d.t).toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/70 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Detection photo"
    >
      <div
        className="relative flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-slate-900">
          {src ? (
            <img src={src} alt={`${CLASS_LABEL[d.class]} at ${d.device_id}`} className="max-h-[70vh] w-full object-contain" />
          ) : (
            <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 px-8 text-center text-slate-300">
              <CameraOff className="h-8 w-8" />
              <p className="text-sm font-semibold text-white">No photo for this sighting</p>
              <p className="max-w-sm text-xs">
                Camera pictures never leave the unit: it only sends what it saw. Photos are kept only for pictures
                uploaded to the unit for testing.
              </p>
            </div>
          )}
          {kind === 'example' && (
            <span className="absolute left-3 top-3 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-900">
              Example photo · simulated detection
            </span>
          )}
          {kind === 'real' && (
            <span className="absolute left-3 top-3 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold text-emerald-900">
              Photo from the unit
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-3 top-3 rounded-full bg-white/90 p-1.5 text-slate-700 hover:bg-white"
          >
            <X className="h-4 w-4" />
          </button>
          {hasPrev && (
            <button
              type="button"
              onClick={() => onIndex(index - 1)}
              aria-label="Newer detection"
              className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-1.5 text-slate-700 hover:bg-white"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          )}
          {hasNext && (
            <button
              type="button"
              onClick={() => onIndex(index + 1)}
              aria-label="Older detection"
              className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-white/90 p-1.5 text-slate-700 hover:bg-white"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
              {CLASS_LABEL[d.class]} · {Math.round(d.confidence * 100)}%
              {d.warning && <span className="rounded bg-red-50 px-1 text-[10px] font-bold text-red-700">WARNED</span>}
              {d.source !== 'simulated' && (
                <span className="rounded bg-emerald-50 px-1 text-[10px] font-bold text-emerald-700">REAL</span>
              )}
            </div>
            <div className="truncate text-xs text-slate-500">
              {siteName(d)} · {d.device_id} · {when}
            </div>
          </div>
          <span className="text-[11px] tabular-nums text-slate-400">
            {index + 1} / {detections.length}
          </span>
          <button
            type="button"
            onClick={() => onShowOnMap(d)}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-700 hover:bg-slate-50"
          >
            <MapPin className="h-3.5 w-3.5" /> Show on map
          </button>
        </div>
      </div>
    </div>
  );
}
