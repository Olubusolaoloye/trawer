export { formatNaira } from '@trawer/core/money';

export function formatDate(iso: string, withTime = false): string {
  const d = new Date(iso);
  return d.toLocaleString('en-NG', withTime
    ? { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }
    : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}
