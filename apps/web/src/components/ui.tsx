import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { cx } from '../lib/format';
import { errorText } from '../i18n';
import type { ApiError } from '../lib/api';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const variants: Record<Variant, string> = {
  primary: 'bg-brand text-brand-ink hover:brightness-110 disabled:opacity-60',
  secondary: 'bg-white text-stone-900 border-2 border-stone-300 hover:border-stone-500 disabled:opacity-60',
  ghost: 'bg-transparent text-stone-800 hover:bg-stone-100',
  danger: 'bg-red-700 text-white hover:bg-red-800 disabled:opacity-60',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; pending?: boolean; size?: 'md' | 'lg' | 'sm' }>(
  function Button({ variant = 'primary', pending, size = 'md', className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={cx(
          'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition select-none',
          size === 'lg' ? 'min-h-14 px-6 text-lg' : size === 'sm' ? 'min-h-10 px-3 text-sm' : 'min-h-12 px-5 text-base',
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

const field = 'w-full min-h-12 rounded-xl border-2 border-stone-300 bg-white px-4 text-base text-stone-900 placeholder:text-stone-500 focus:border-brand focus:outline-none aria-[invalid=true]:border-red-600';

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
      <label htmlFor={htmlFor} className="block text-sm font-semibold text-stone-800">{label}</label>
      {children}
      {hint && !error && <p className="text-sm text-stone-600">{hint}</p>}
      {error && <p className="text-sm font-medium text-red-700" role="alert">{error}</p>}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx('rounded-2xl border border-stone-200 bg-white p-4 shadow-sm', className)}>{children}</div>;
}

const badgeTones = {
  neutral: 'bg-stone-100 text-stone-800',
  good: 'bg-emerald-100 text-emerald-900',
  warn: 'bg-amber-100 text-amber-900',
  bad: 'bg-red-100 text-red-900',
  brand: 'bg-brand text-brand-ink',
};
export function Badge({ tone = 'neutral', children }: { tone?: keyof typeof badgeTones; children: ReactNode }) {
  return <span className={cx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold', badgeTones[tone])}>{children}</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex justify-center py-10" role="status" aria-label={label}>
      <Loader2 className="size-8 animate-spin text-stone-500" aria-hidden />
    </div>
  );
}

export function ErrorNote({ error }: { error?: ApiError | null | { code?: string } }) {
  if (!error) return null;
  return <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm font-medium text-red-800">{errorText((error as { code?: string }).code)}</p>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-12 text-center text-stone-600">{children}</p>;
}
