import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ChevronDown, RotateCcw } from 'lucide-react';
import { resetDemo } from './mock';

/** Slim strip above the app (in the page flow, so it never covers anything): what this is and how to sign in. */
export default function DemoBar() {
  const [open, setOpen] = useState(() => { try { return sessionStorage.getItem('trawer-demo:bar') !== 'closed'; } catch { return true; } });
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const on = (e: Event) => { setToast((e as CustomEvent<string>).detail); clearTimeout(timer); timer = setTimeout(() => setToast(null), 3200); };
    window.addEventListener('trawer-demo:toast', on);
    return () => { window.removeEventListener('trawer-demo:toast', on); clearTimeout(timer); };
  }, []);
  const toggle = () => { setOpen(!open); try { sessionStorage.setItem('trawer-demo:bar', open ? 'closed' : 'open'); } catch { /* private mode */ } };
  const chip = 'inline-flex min-h-8 items-center gap-1 rounded-lg px-2.5 font-bold';

  return (
    <>
      {toast && (
        <div role="status" className="fixed inset-x-0 top-3 z-[60] mx-auto w-fit max-w-[calc(100vw-2rem)] rounded-2xl bg-ink px-4 py-2 text-center text-sm font-semibold text-white shadow-lg">{toast}</div>
      )}
      <aside aria-label="About this demo" className="bg-ink px-4 py-2 text-[13px] leading-snug text-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1.5">
          <button type="button" onClick={toggle} aria-expanded={open} className="inline-flex items-center gap-1 font-bold">
            <span className="rounded bg-gold px-1.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wider text-ink">Demo</span>
            Sample shop · nothing is saved
            <ChevronDown className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
          </button>
          {open && (
            <>
              <p className="w-full sm:w-auto">
                Owner <b className="num">0803 000 0001</b> · Buyer <b className="num">0809 000 0001</b> · Code <b className="num">000000</b>
              </p>
              <div className="flex gap-1.5 sm:ml-auto">
                <Link to="/s/balogun" className={`${chip} bg-green`}>Store</Link>
                <Link to="/dashboard" className={`${chip} bg-white/15`}>Dashboard</Link>
                <button type="button" onClick={resetDemo} className={`${chip} bg-white/15`}><RotateCcw className="size-3.5" aria-hidden />Start over</button>
              </div>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
