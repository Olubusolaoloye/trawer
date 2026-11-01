import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { ChevronLeft } from 'lucide-react';
import { t } from '../i18n';

/** Header for full-bleed storefront pages (product, cart, checkout, order). */
export function PageHeader({ title, back, right }: { title: string; back: string; right?: ReactNode }) {
  const navigate = useNavigate();
  return (
    <header className="flex items-center gap-2.5 px-3.5 pb-2.5 pt-3.5">
      <button type="button" onClick={() => navigate(back)} aria-label={t('common.back')}
        className="flex size-[46px] items-center justify-center rounded-xl border border-line bg-surface"><ChevronLeft className="size-6" aria-hidden /></button>
      <h1 className="flex-1 font-display text-2xl font-extrabold">{title}</h1>
      {right}
    </header>
  );
}
