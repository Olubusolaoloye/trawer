/**
 * Storefront building blocks (design v3, "Fresh Market"): a coloured header band with a content
 * sheet overlapping it, round-button steppers, pill tabs, the phone tab bar, bottom sheets and the
 * order timeline. Everything reads the shop's theme tokens, so it works in every store theme.
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router';
import { Check, ChevronLeft, Home, Minus, Plus, ReceiptText, Search, ShoppingBag, Trash2, User, X } from 'lucide-react';
import { cx } from '../lib/format';
import { useStoreLocation } from '../lib/store-context';
import { t } from '../i18n';
import { useStore } from './StoreLayout';

/** True when the shop uses a coloured header (inner pages then get the band + sheet look). */
export function useBand(): boolean {
  return useStore().data?.design.header === 'brand';
}

/** Round back button, for bands and photo headers. */
export function BackButton({ to, onBrand, className }: { to?: string; onBrand?: boolean; className?: string }) {
  const navigate = useNavigate();
  const { href } = useStoreLocation();
  return (
    <button type="button" aria-label={t('common.back')}
      onClick={() => (to ? navigate(to) : history.length > 1 ? navigate(-1) : navigate(href('/')))}
      className={cx('press flex size-11 shrink-0 items-center justify-center rounded-full',
        onBrand ? 'bg-white/15 ring-1 ring-white/30 hover:bg-white/25' : 'border border-line bg-surface shadow-card hover:bg-line-soft', className)}>
      <ChevronLeft className="size-6" aria-hidden />
    </button>
  );
}

/**
 * Inner-page header: back button, centred title, optional action, optional extra row (e.g. a search
 * field). With a coloured shop header it is a band the page's <Sheet> slides up over.
 */
export function AppBar({ title, back, right, children }: { title: string; back?: string; right?: ReactNode; children?: ReactNode }) {
  const band = useBand();
  return (
    <header className={cx('px-4 pt-3', band ? 'bg-brand pb-10 text-brand-ink glow-brand' : 'pb-3 text-ink')}>
      <div className="mx-auto flex max-w-xl items-center gap-3">
        <BackButton to={back} onBrand={band} />
        <h1 className="min-w-0 flex-1 truncate text-center font-display text-xl font-extrabold tracking-tight">{title}</h1>
        <div className="flex size-11 shrink-0 items-center justify-center">{right}</div>
      </div>
      {children && <div className="mx-auto mt-3.5 max-w-xl">{children}</div>}
    </header>
  );
}

/** The page body under an <AppBar>: a rounded sheet that overlaps the band. */
export function Sheet({ children, className }: { children: ReactNode; className?: string }) {
  const band = useBand();
  return (
    <div className={cx('relative flex-1 bg-paper', band && '-mt-6 rounded-t-[28px] pt-5 shadow-[0_-12px_30px_-24px_rgb(0_0_0/0.5)]')}>
      <div className={cx('mx-auto w-full max-w-xl', className)}>{children}</div>
    </div>
  );
}

/** Quantity stepper: outlined minus, filled plus. At the minimum, minus becomes "remove" when allowed. */
export function Stepper({ value, onChange, min = 1, max, label, unit, size = 'md', removable }: {
  value: number; onChange: (n: number) => void; min?: number; max?: number; label: string; unit?: string; size?: 'sm' | 'md'; removable?: boolean;
}) {
  const btn = size === 'sm' ? 'size-9' : 'size-11';
  const atMin = value <= min;
  const remove = removable && atMin;
  return (
    <div className="inline-flex items-center gap-1.5 rounded-full bg-line-soft p-1" role="group" aria-label={label}>
      <button type="button" disabled={atMin && !remove} onClick={() => onChange(remove ? 0 : value - 1)}
        aria-label={remove ? t('cart.remove') : t('store.less')}
        className={cx('press flex items-center justify-center rounded-full bg-surface text-ink shadow-sm disabled:opacity-40', btn, remove && 'text-red-ink')}>
        {remove ? <Trash2 className="size-4" aria-hidden /> : <Minus className="size-4" aria-hidden />}
      </button>
      <span className={cx('num min-w-9 text-center font-bold', size === 'sm' ? 'text-sm' : 'text-base')} aria-live="polite">
        {value}{unit ? <span className="ml-1 text-xs font-semibold text-muted">{unit}</span> : null}
      </span>
      <button type="button" disabled={max !== undefined && value >= max} onClick={() => onChange(value + 1)} aria-label={t('store.more')}
        className={cx('press flex items-center justify-center rounded-full bg-ink text-paper disabled:opacity-40', btn)}>
        <Plus className="size-4" aria-hidden />
      </button>
    </div>
  );
}

/** One-of-many pill tabs (filters, units). */
export function PillTabs<T extends string>({ options, value, onChange, label, className }: {
  options: { value: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string; className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cx('no-scrollbar -mx-4 flex gap-2 overflow-x-auto px-4 pb-1', className)}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
          className={cx('press min-h-11 shrink-0 rounded-full px-4 text-sm transition-colors',
            value === o.value ? 'bg-ink font-bold text-paper shadow-[0_8px_18px_-10px_rgb(0_0_0/0.6)]' : 'border border-line bg-surface font-semibold text-ink hover:bg-line-soft')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Phone tab bar for the storefront (desktop uses the header icons). */
export function StoreTabBar({ count }: { count: number }) {
  const { href } = useStoreLocation();
  const items = [
    { to: href('/'), label: t('store.home'), icon: Home, end: true },
    { to: href('/search'), label: t('common.search'), icon: Search },
    { to: href('/orders'), label: t('store.orders'), icon: ReceiptText },
    { to: href('/account'), label: t('store.account'), icon: User },
  ];
  return (
    <nav aria-label={t('store.menu')} className="fixed inset-x-3 bottom-3 z-40 mx-auto max-w-md sm:hidden">
      <ul className="glass-ink flex items-center justify-between rounded-[26px] px-2 py-1.5 text-paper shadow-float">
        {items.map(({ to, label, icon: Icon, end }) => (
          <li key={to} className="flex-1">
            <NavLink to={to} end={end} viewTransition
              className={({ isActive }) => cx('flex min-h-13 flex-col items-center justify-center gap-0.5 rounded-2xl text-[11px] font-semibold', isActive ? 'text-paper' : 'text-paper/70')}>
              {({ isActive }) => (
                <>
                  <span className={cx('flex h-7 w-12 items-center justify-center rounded-full transition-colors', isActive && 'bg-accent text-accent-ink')}><Icon className="size-5" aria-hidden /></span>
                  {label}
                </>
              )}
            </NavLink>
          </li>
        ))}
        <li className="flex-1">
          <NavLink to={href('/cart')} viewTransition
            className={({ isActive }) => cx('flex min-h-13 flex-col items-center justify-center gap-0.5 text-[11px] font-semibold', isActive ? 'text-paper' : 'text-paper/70')}>
            <span className="relative flex h-7 w-12 items-center justify-center">
              <ShoppingBag className="size-5" aria-hidden />
              {count > 0 && <span aria-hidden className="absolute -top-1 right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-extrabold text-accent-ink">{count}</span>}
            </span>
            <span>{t('store.cart')}<span className="sr-only"> ({count})</span></span>
          </NavLink>
        </li>
      </ul>
    </nav>
  );
}

/** Bottom sheet on phones, centred card on larger screens (native modal dialog: focus trap + Esc). */
export function BottomSheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-label={title}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
      className="sheet-dialog m-0 mt-auto w-full max-w-none bg-transparent p-0 text-ink backdrop:bg-black/45 sm:m-auto sm:max-w-md">
      {open && (
        <div className="max-h-[88dvh] overflow-y-auto rounded-t-[28px] bg-paper px-4 pb-6 pt-2 shadow-float sm:rounded-[28px]">
          <div className="mx-auto mb-2 h-1.5 w-11 rounded-full bg-line sm:hidden" aria-hidden />
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="font-display text-xl font-extrabold">{title}</h2>
            <button type="button" onClick={onClose} aria-label={t('common.close')} className="press flex size-10 items-center justify-center rounded-full bg-line-soft"><X className="size-5" aria-hidden /></button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}

export interface TimelineStep { title: string; detail?: string; at?: string | null; state: 'done' | 'current' | 'todo' | 'failed' }

/** Vertical timeline: time on the left, status dot + line, title and detail on the right. */
export function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <ol>
      {steps.map((s, i) => (
        <li key={i} className="grid grid-cols-[3.75rem_1.75rem_1fr] gap-x-3">
          <span className="num pt-1 text-right text-xs font-semibold text-muted">{s.at ?? ''}</span>
          <div className="flex flex-col items-center">
            <span className={cx('flex size-7 items-center justify-center rounded-full',
              s.state === 'done' ? 'bg-ink text-paper' : s.state === 'failed' ? 'bg-red text-white' : s.state === 'current' ? 'border-[3px] border-accent bg-surface' : 'border-2 border-line bg-surface')}>
              {s.state === 'done' && <Check className="size-3.5" strokeWidth={3.4} aria-hidden />}
              {s.state === 'failed' && <X className="size-3.5" strokeWidth={3.4} aria-hidden />}
            </span>
            {i < steps.length - 1 && <span className={cx('my-1 min-h-6 w-0.5 flex-1 rounded-full', s.state === 'done' ? 'bg-ink' : 'bg-line')} />}
          </div>
          <div className="pb-5">
            <p className={cx('font-bold', s.state === 'todo' && 'text-muted', s.state === 'current' && 'text-accent-text')}>
              {s.title}<span className="sr-only"> — {t(`timeline.${s.state}` as never)}</span>
            </p>
            {s.detail && <p className="text-sm text-body">{s.detail}</p>}
          </div>
        </li>
      ))}
    </ol>
  );
}
