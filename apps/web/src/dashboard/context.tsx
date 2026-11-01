import { createContext, useContext } from 'react';

export interface BizInfo {
  business: { id: string; name: string; slug: string; brand_colour: string; logo_url: string | null; onboarding_completed_at: string | null; reservation_minutes: number };
  role: string;
  permissions: string[];
  locations: { id: string; name: string; is_default: boolean }[];
  stats: { products: number; orders_today: number; sales_today_kobo: number; pending_wholesale: number; low_stock: number; conflicts: number };
}

export const BizCtx = createContext<(BizInfo & { base: string; can: (p: string) => boolean }) | null>(null);
export function useBiz() {
  const b = useContext(BizCtx);
  if (!b) throw new Error('outside business');
  return b;
}
