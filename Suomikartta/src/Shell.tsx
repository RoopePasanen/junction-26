/**
 * App shell: a slim nav rail with the two products views.
 *  - Overview: the customer dashboard (sites, live units, value stats)
 *  - Planner:  where to place units (Into's map and camera planner, App.tsx)
 * Both stay mounted so switching keeps their state. #/planner opens the planner.
 */
import { useEffect, useState } from 'react';
import { LayoutDashboard, Map as MapIcon } from 'lucide-react';
import App from './App';
import { DashboardView } from './components/dashboard/DashboardView';

export const BRAND = 'RiistaVahti'; // working name, change freely

type View = 'overview' | 'planner';
const viewFromHash = (): View => (window.location.hash.includes('planner') ? 'planner' : 'overview');

const NAV: Array<{ id: View; label: string; icon: typeof MapIcon }> = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard },
  { id: 'planner', label: 'Planner', icon: MapIcon },
];

export function Shell() {
  const [view, setView] = useState<View>(viewFromHash);

  useEffect(() => {
    const onHash = () => setView(viewFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = (v: View) => {
    window.location.hash = v === 'planner' ? '/planner' : '/';
    setView(v);
  };

  return (
    <div className="flex h-dvh w-full overflow-hidden bg-slate-50">
      <nav className="flex w-[72px] shrink-0 flex-col items-center gap-1 bg-slate-950 py-3">
        <div
          className="mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500 text-lg font-black text-slate-950"
          title={BRAND}
        >
          🦌
        </div>
        {NAV.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => go(id)}
            aria-current={view === id ? 'page' : undefined}
            className={`flex w-14 flex-col items-center gap-1 rounded-xl py-2 text-[10px] font-semibold transition-colors ${
              view === id ? 'bg-white/10 text-white' : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            }`}
          >
            <Icon className="h-5 w-5" />
            {label}
          </button>
        ))}
        <div className="mt-auto px-1 text-center text-[9px] font-semibold uppercase tracking-wider text-slate-500">
          {BRAND}
        </div>
      </nav>
      <main className="relative min-w-0 flex-1">
        <div className={view === 'overview' ? 'h-full' : 'hidden'}>
          <DashboardView />
        </div>
        <div className={view === 'planner' ? 'h-full [&>div]:!h-full' : 'hidden'}>
          <App />
        </div>
      </main>
    </div>
  );
}
