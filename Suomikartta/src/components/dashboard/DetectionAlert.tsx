/**
 * Full-screen pop-up shown the moment a unit turns its beacon on (deer or moose in view).
 * Made to be impossible to miss in a demo: flashing amber frame, big headline, the
 * photo the unit sent (uploaded photos only), where and when, and a short chime.
 *
 * Closes by itself after `showMs`, on Esc, or with the buttons.
 */
import { useEffect, useState } from 'react';
import { Clock, Gauge, MapPin, Radio, X } from 'lucide-react';
import type { LiveEvent } from '../LiveUnitsLayer';

const SOURCE_LABEL: Record<string, string> = {
  camera: 'Camera',
  upload: 'Uploaded photo',
  knob: 'Test button',
  simulated: 'Simulated',
};

/** Two short beeps. Browsers only allow sound after the page was clicked once. */
function chime() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new Ctx();
    void ctx.resume();
    [0, 0.22].forEach((at, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = i === 0 ? 880 : 1175;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + at);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + 0.2);
    });
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    // no audio: the pop-up still shows
  }
}

export function DetectionAlert({
  event,
  siteName,
  showMs,
  onShowOnMap,
  onClose,
}: {
  event: LiveEvent;
  siteName: string;
  showMs: number;
  onShowOnMap: () => void;
  onClose: () => void;
}) {
  const [shownAt] = useState(() => Date.now());
  const [now, setNow] = useState(shownAt);

  useEffect(() => {
    chime();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearInterval(id);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const seen = new Date(event.ts);
  const time = Number.isNaN(seen.getTime())
    ? event.ts
    : seen.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const agoS = Math.max(0, Math.round((now - shownAt) / 1000));

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-slate-950/75 p-4 backdrop-blur-sm"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="detection-alert-title"
      onClick={onClose}
    >
      <style>{`
        @keyframes da-flash { 0%, 49% { border-color: #f59e0b; box-shadow: 0 0 0 6px rgba(245,158,11,.35), 0 25px 60px rgba(0,0,0,.5); }
                              50%, 100% { border-color: #dc2626; box-shadow: 0 0 0 14px rgba(220,38,38,.25), 0 25px 60px rgba(0,0,0,.5); } }
        @keyframes da-in { from { opacity: 0; transform: scale(.85) translateY(20px); } to { opacity: 1; transform: none; } }
        @keyframes da-sign { 0%, 49% { transform: scale(1); } 50%, 100% { transform: scale(1.06); } }
        @keyframes da-bar { from { transform: scaleX(1); } to { transform: scaleX(0); } }
        @media (prefers-reduced-motion: reduce) { .da-motion { animation: none !important; } }
      `}</style>

      <div
        className="da-motion relative w-full max-w-3xl overflow-hidden rounded-3xl border-[6px] bg-white"
        style={{ animation: 'da-in 280ms ease-out, da-flash 1s infinite' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Top band */}
        <div className="flex items-center justify-between gap-3 bg-red-600 px-5 py-2.5 text-white">
          <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.18em]">
            <span className="relative flex h-3 w-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300 opacity-75" />
              <span className="relative inline-flex h-3 w-3 rounded-full bg-amber-300" />
            </span>
            Live · beacon on
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-white/80 hover:bg-white/15 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="grid gap-5 p-5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] sm:p-7">
          {/* Picture: the unit's photo, or a warning sign */}
          <div className="flex items-center justify-center overflow-hidden rounded-2xl bg-amber-50">
            {event.thumb ? (
              <img src={event.thumb} alt="Photo the unit sent, with the detected animal boxed" className="h-full w-full object-contain" />
            ) : (
              <div className="da-motion py-6" style={{ animation: 'da-sign 1s infinite' }} aria-hidden="true">
                <svg viewBox="0 0 200 180" className="h-44 w-48 sm:h-52 sm:w-56">
                  <path d="M100 10 L190 168 L10 168 Z" fill="#facc15" stroke="#dc2626" strokeWidth="14" strokeLinejoin="round" />
                  <text x="100" y="140" textAnchor="middle" fontSize="88">
                    🦌
                  </text>
                </svg>
              </div>
            )}
          </div>

          {/* Text */}
          <div className="flex min-w-0 flex-col">
            <div className="text-sm font-semibold uppercase tracking-wider text-red-600">Wildlife on the road</div>
            <h2 id="detection-alert-title" className="mt-1 text-4xl font-black leading-[1.05] tracking-tight text-slate-950 sm:text-5xl">
              Deer detected
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              A deer or moose is in front of <b className="text-slate-900">{event.device_id}</b>. The warning sign is
              flashing and drivers are being warned now.
            </p>

            <dl className="mt-5 grid grid-cols-2 gap-3 text-sm">
              <div className="col-span-2 rounded-xl bg-slate-50 px-3 py-2.5">
                <dt className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <MapPin className="h-3.5 w-3.5" /> Where
                </dt>
                <dd className="mt-0.5 text-lg font-bold text-slate-950">{siteName}</dd>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                <dt className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <Clock className="h-3.5 w-3.5" /> Seen at
                </dt>
                <dd className="mt-0.5 text-lg font-bold tabular-nums text-slate-950">{time}</dd>
                <dd className="text-[11px] text-slate-500">{agoS < 5 ? 'just now' : `${agoS} s ago`}</dd>
              </div>
              <div className="rounded-xl bg-slate-50 px-3 py-2.5">
                <dt className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  <Gauge className="h-3.5 w-3.5" /> Confidence
                </dt>
                <dd className="mt-0.5 text-lg font-bold tabular-nums text-slate-950">{Math.round(event.confidence * 100)}%</dd>
                <dd className="text-[11px] text-slate-500">{SOURCE_LABEL[event.source] ?? event.source} · on-device AI</dd>
              </div>
            </dl>

            <div className="mt-auto flex flex-wrap gap-2 pt-5">
              <button
                type="button"
                onClick={onShowOnMap}
                className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700"
              >
                <MapPin className="h-4 w-4" /> Show on map
              </button>
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                <Radio className="h-4 w-4" /> Dismiss
              </button>
            </div>
          </div>
        </div>

        {/* Time left before it closes by itself */}
        <div className="h-1.5 bg-slate-100">
          <div
            className="da-motion h-full origin-left bg-red-600"
            style={{ animation: `da-bar ${showMs}ms linear forwards` }}
          />
        </div>
      </div>
    </div>
  );
}
