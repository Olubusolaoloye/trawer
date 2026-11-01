/** All money is integer kobo (1 naira = 100 kobo). */
export type Kobo = number;

export function nairaToKobo(naira: number | string): Kobo {
  const n = typeof naira === 'string' ? Number(naira.replace(/[₦,\s]/g, '')) : naira;
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`invalid amount: ${String(naira)}`);
  return Math.round(n * 100);
}

export function koboToNaira(kobo: Kobo): number {
  return kobo / 100;
}

const formatter = new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN', minimumFractionDigits: 0, maximumFractionDigits: 2 });

/** ₦12,500 (drops .00 for whole naira). */
export function formatNaira(kobo: Kobo): string {
  return formatter.format(kobo / 100).replace('NGN', '₦').replace(/\s/g, '');
}

export function sumKobo(values: readonly Kobo[]): Kobo {
  return values.reduce((a, b) => a + b, 0);
}
