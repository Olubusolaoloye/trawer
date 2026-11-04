import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cx } from '../lib/format';
import { errorText } from '../i18n';
import type { ApiError } from '../lib/api';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ink' | 'brand' | 'wholesale' | 'gold';
const variants: Record<Variant, string> = {
  primary: 'bg-green text-white shadow-[0_10px_22px_-12px_rgb(11_122_75/0.8)] hover:bg-green-ink disabled:opacity-60 disabled:shadow-none',
  brand: 'bg-brand text-brand-ink shadow-[0_10px_22px_-12px_var(--color-brand)] hover:brightness-110 disabled:opacity-60',
  ink: 'bg-ink text-paper hover:bg-ink-2 disabled:opacity-60',
  wholesale: 'bg-indigo text-white shadow-[0_10px_22px_-12px_rgb(35_48_140/0.8)] hover:brightness-110 disabled:opacity-60',
  gold: 'bg-gold text-ink hover:brightness-105 disabled:opacity-60',
  secondary: 'bg-surface text-ink border-[1.5px] border-ink/85 hover:bg-paper disabled:opacity-60',
  ghost: 'bg-transparent text-ink underline-offset-4 hover:underline',
  danger: 'bg-red text-white hover:bg-red-ink disabled:opacity-60',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; pending?: boolean; size?: 'sm' | 'md' | 'lg' }>(
  function Button({ variant = 'primary', pending, size = 'md', className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={cx(
          'press inline-flex select-none items-center justify-center gap-2 rounded-xl font-bold transition-[background-color,box-shadow,filter,transform] duration-200',
          size === 'lg' ? 'min-h-15 px-6 text-[17px]' : size === 'sm' ? 'min-h-11 px-4 text-sm' : 'min-h-13 px-5 text-base',
          variants[variant],
          className,
        )}
        disabled={disabled || pending}
        aria-busy={pending || undefined}
        {...rest}
      >
        {pending && <Loader2 className="size-5 animate-spin" aria-hidden />}
        {children}
      </button>
    );
  },
);

const field = 'w-full min-h-13 rounded-xl border-[1.5px] border-line bg-surface px-4 text-[17px] font-medium text-ink shadow-[0_1px_2px_rgb(14_20_17/0.04)] transition-[border-color,box-shadow] duration-200 placeholder:text-muted hover:border-muted/50 focus:border-ink focus:outline-none focus:ring-4 focus:ring-ink/10 aria-[invalid=true]:border-red';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(field, className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(field, 'py-3', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...rest }, ref) {
  return <select ref={ref} className={cx(field, 'appearance-none pr-10', className)} {...rest} />;
});

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-[15px] font-bold text-ink">{label}</label>
      {children}
      {hint && !error && <p className="text-sm text-muted">{hint}</p>}
      {error && <p className="text-sm font-semibold text-red-ink" role="alert">{error}</p>}
    </div>
  );
}

export function Card({ className, children, strong }: { className?: string; children: ReactNode; strong?: boolean }) {
  return <div className={cx('rounded-2xl bg-surface p-4 shadow-card', strong ? 'border-[1.5px] border-ink' : 'border border-line/70', className)}>{children}</div>;
}

const badgeTones = {
  neutral: 'bg-line-soft text-body',
  good: 'bg-green-50 text-green-ink',
  warn: 'bg-gold-50 text-gold-ink',
  bad: 'bg-red-50 text-red-ink',
  wholesale: 'bg-indigo text-white',
  info: 'bg-indigo-50 text-indigo',
  ink: 'bg-ink text-paper',
  brand: 'bg-brand text-brand-ink',
};
export function Badge({ tone = 'neutral', children, className }: { tone?: keyof typeof badgeTones; children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold', badgeTones[tone], className)}>{children}</span>;
}

/** Always-visible connection/sync state (Live · Offline · To fix). */
export function StatusPill({ tone, children }: { tone: 'live' | 'offline' | 'fix'; children: ReactNode }) {
  const t = { live: ['bg-green-50 text-green-ink', 'bg-green'], offline: ['bg-gold-50 text-gold-ink', 'bg-gold'], fix: ['bg-red-50 text-red-ink', 'bg-red'] }[tone];
  return (
    <span className={cx('inline-flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-bold', t[0])}>
      <span className={cx('size-2.5 rounded-full', t[1])} aria-hidden />{children}
    </span>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex justify-center py-10" role="status" aria-label={label}>
      <Loader2 className="size-8 animate-spin text-muted" aria-hidden />
    </div>
  );
}

/** Shimmering placeholder while content loads (keeps layout stable, feels faster than a spinner). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('skeleton rounded-xl', className)} aria-hidden />;
}

/** A grid of product-card placeholders. */
export function ProductGridSkeleton({ n = 8 }: { n?: number }) {
  return (
    <div role="status" aria-label="Loading" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="overflow-hidden rounded-card border border-line/70 bg-surface">
          <div className="skeleton aspect-[4/3.9]" />
          <div className="space-y-2 p-3"><Skeleton className="h-3.5 w-4/5" /><Skeleton className="h-5 w-1/2" /></div>
        </div>
      ))}
    </div>
  );
}

export function ErrorNote({ error }: { error?: ApiError | null | { code?: string } }) {
  if (!error) return null;
  return <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-semibold text-red-ink">{errorText((error as { code?: string }).code)}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-12 text-center text-muted">{children}</p>;
}

export function Display({ as: Tag = 'h1', className, children }: { as?: 'h1' | 'h2' | 'h3' | 'p' | 'span'; className?: string; children: ReactNode }) {
  return <Tag className={cx('font-display font-extrabold tracking-tight', className)}>{children}</Tag>;
}

/** Fabric-like placeholder for products without a photo (deterministic per id). */
export function fabricStyle(seed: string, hex?: string | null): React.CSSProperties {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  const base = hex ?? ['#1D4ED8', '#7F1D1D', '#CA8A04', '#047857', '#BE185D', '#23308C'][Math.abs(h) % 6]!;
  const patterns = [
    `radial-gradient(circle at 12px 12px, rgb(255 255 255 / .55) 5px, transparent 5.5px)`,
    `repeating-linear-gradient(45deg, rgb(255 255 255 / .45) 0 3px, transparent 3px 14px)`,
    `repeating-linear-gradient(90deg, rgb(14 20 17 / .35) 0 5px, transparent 5px 22px)`,
  ];
  return { backgroundColor: base, backgroundImage: patterns[Math.abs(h >> 3) % 3], backgroundSize: '36px 36px' };
}

/** Placeholder rows for a list while it loads (same rhythm as the real rows, so nothing jumps). */
export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading" className="space-y-2">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-2xl border border-line/60 bg-surface p-3">
          <div className="skeleton size-11 shrink-0 rounded-xl" />
          <div className="flex-1 space-y-2"><Skeleton className="h-3.5 w-1/2" /><Skeleton className="h-3 w-1/3" /></div>
          <Skeleton className="h-5 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Whole-page placeholder: heading, a headline card, tiles and a list. */
export function PageSkeleton() {
  return (
    <div role="status" aria-label="Loading" className="mx-auto w-full max-w-6xl space-y-4 p-4">
      <Skeleton className="h-8 w-48" />
      <div className="skeleton h-36 rounded-3xl" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-24 rounded-2xl" />)}</div>
      <ListSkeleton rows={3} />
    </div>
  );
}
