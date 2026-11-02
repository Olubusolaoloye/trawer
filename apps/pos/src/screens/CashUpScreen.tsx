import { useEffect, useState } from 'react';
import { ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { ArrowLeftRight, Banknote, CheckCircle2, CloudUpload, CreditCard, Delete, Hash, Landmark, QrCode } from 'lucide-react-native';
import { formatNaira } from '@trawer/core/money';
import type { PosEngine } from '@trawer/core/pos';
import { authed, type DeviceBinding } from '../session';
import { Button, Card, ErrorText, Glow, Press, colors, fonts, radius, s, shadow, tap, type Icon } from '../components/ui';

const METHOD: Record<string, { label: string; icon: Icon }> = {
  cash: { label: 'Cash', icon: Banknote }, card_terminal: { label: 'Card terminal', icon: CreditCard }, transfer: { label: 'Transfer', icon: ArrowLeftRight },
  ussd: { label: 'USSD', icon: Hash }, qr: { label: 'QR', icon: QrCode }, virtual_account: { label: 'Virtual account', icon: Landmark },
};
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', '⌫'];

/** End of day: count the drawer, compare with the till and the server ledger, close the day. */
export function CashUpScreen({ engine, binding, pending }: { engine: PosEngine; binding: DeviceBinding; pending: number }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const wide = useWindowDimensions().width >= 900;
  const [local, setLocal] = useState<Record<string, number>>({});
  const [server, setServer] = useState<Record<string, number> | null>(null);
  const [digits, setDigits] = useState('');
  const [result, setResult] = useState<{ variance_kobo: number } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void engine.localCashUp(today).then(setLocal);
    authed<{ expected: Record<string, number> }>(`/api/pos/cash-up?business_id=${binding.businessId}&day=${today}`)
      .then((r) => setServer(r.expected)).catch(() => setServer(null));
  }, [engine, binding, today]);

  const counted = Number(digits || '0') * 100;
  const expectedCash = server?.cash ?? local.cash ?? 0;
  const diff = counted - expectedCash;
  const methods = [...new Set([...Object.keys(local), ...Object.keys(server ?? {})])].filter((m) => (local[m] ?? 0) || (server?.[m] ?? 0));
  const totalToday = methods.reduce((n, m) => n + (server?.[m] ?? local[m] ?? 0), 0);
  const press = (k: string) => {
    setResult(null);
    if (k === '⌫') setDigits((d) => d.slice(0, -1));
    else if (digits.length < 9) setDigits((d) => (d + k).replace(/^0+(?=\d)/, '').slice(0, 9));
  };
  const tone = diff === 0 ? [colors.green50, colors.greenInk] : diff > 0 ? [colors.gold50, colors.goldInk] : [colors.red50, colors.redInk];

  const summary = (
    <View style={{ flex: 1, gap: 14 }}>
      <View>
        <Text style={s.eyebrow}>{new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Lagos' })}</Text>
        <Text accessibilityRole="header" style={s.h1}>Close the day</Text>
      </View>
      <View style={[{ borderRadius: radius.xl, backgroundColor: colors.ink, padding: 20, overflow: 'hidden', gap: 4 }, shadow.float]}>
        <Glow id="cash" />
        <Text style={{ color: colors.onInkMuted, fontFamily: fonts.semi, fontSize: 14 }}>Taken on this till today</Text>
        <Text style={[s.money, { color: '#fff', fontSize: 40 }]}>{formatNaira(totalToday)}</Text>
      </View>
      {pending > 0 && (
        <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', backgroundColor: colors.gold50, padding: 14, borderRadius: radius.lg }}>
          <CloudUpload size={22} color={colors.goldInk} />
          <Text style={{ flex: 1, color: colors.goldInk, fontFamily: fonts.bold, fontSize: 14 }}>{pending} sale(s) not sent yet. Connect to the internet so the server totals are complete.</Text>
        </View>
      )}
      <Card style={{ paddingVertical: 4 }}>
        <View style={{ flexDirection: 'row', paddingVertical: 10 }}>
          <Text style={[s.eyebrow, { flex: 1.5 }]}>Method</Text>
          <Text style={[s.eyebrow, { flex: 1, textAlign: 'right' }]}>This till</Text>
          <Text style={[s.eyebrow, { flex: 1, textAlign: 'right' }]}>Trawer</Text>
        </View>
        {methods.length === 0 && <Text style={[s.muted, { paddingVertical: 12 }]}>No sales yet today.</Text>}
        {methods.map((m) => {
          const meta = METHOD[m] ?? { label: m, icon: Banknote };
          const match = server ? (server[m] ?? 0) === (local[m] ?? 0) : true;
          return (
            <View key={m} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderTopWidth: 1, borderColor: colors.lineSoft }}>
              <View style={{ flex: 1.5, flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <View style={{ width: 34, height: 34, borderRadius: 10, backgroundColor: colors.lineSoft, alignItems: 'center', justifyContent: 'center' }}><meta.icon size={18} color={colors.ink} /></View>
                <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.ink }}>{meta.label}</Text>
              </View>
              <Text style={[s.money, { flex: 1, textAlign: 'right', fontSize: 16, fontFamily: fonts.semi }]}>{formatNaira(local[m] ?? 0)}</Text>
              <Text style={[s.money, { flex: 1, textAlign: 'right', fontSize: 16, fontFamily: fonts.semi, color: match ? colors.ink : colors.goldInk }]}>{server ? formatNaira(server[m] ?? 0) : '—'}</Text>
            </View>
          );
        })}
      </Card>
    </View>
  );

  const counter = (
    <Card style={{ width: wide ? 420 : undefined, gap: 14, padding: 18 }}>
      <Text style={s.label}>Count the cash in the drawer</Text>
      <View accessibilityLiveRegion="polite" accessibilityLabel={`Counted ${formatNaira(counted)}`}
        style={{ minHeight: 76, borderRadius: radius.lg, backgroundColor: colors.ink, justifyContent: 'center', alignItems: 'flex-end', paddingHorizontal: 20, overflow: 'hidden' }}>
        <Glow id="count" tone="gold" />
        <Text style={[s.money, { fontSize: 40, color: '#fff' }]}>{formatNaira(counted)}</Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {KEYS.map((k) => (
          <Press key={k} accessibilityRole="button" accessibilityLabel={k === '⌫' ? 'Delete last digit' : k} onPress={() => press(k)} onLongPress={k === '⌫' ? () => { tap('medium'); setDigits(''); } : undefined} scaleTo={0.92}
            style={{ width: '31.6%', minHeight: 62, borderRadius: radius.md, backgroundColor: k === '⌫' ? colors.lineSoft : colors.surface, borderWidth: k === '⌫' ? 0 : 1, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' }}>
            {k === '⌫' ? <Delete size={24} color={colors.ink} /> : <Text style={{ fontFamily: fonts.display, fontSize: 26, color: colors.ink }}>{k}</Text>}
          </Press>
        ))}
      </View>
      <Text style={[s.muted, { fontSize: 12, textAlign: 'center' }]}>Hold ⌫ to clear</Text>
      {digits !== '' && (
        <View style={{ padding: 14, borderRadius: radius.lg, backgroundColor: tone[0], gap: 2 }}>
          <Text style={{ fontFamily: fonts.black, fontSize: 18, color: tone[1] }}>{diff === 0 ? 'Balanced. Well done.' : `${diff > 0 ? 'Over' : 'Short'} by ${formatNaira(Math.abs(diff))}`}</Text>
          <Text style={s.muted}>Expected cash {formatNaira(expectedCash)}</Text>
        </View>
      )}
      <ErrorText error={error} />
      {result
        ? (
          <View style={{ flexDirection: 'row', gap: 10, alignItems: 'center', justifyContent: 'center', padding: 14, borderRadius: radius.lg, backgroundColor: colors.green50 }}>
            <CheckCircle2 size={24} color={colors.greenInk} />
            <Text style={{ fontFamily: fonts.black, fontSize: 16, color: colors.greenInk }}>Day closed. The owner can see it now.</Text>
          </View>
        )
        : <Button big title="Close day" pending={submitting} disabled={digits === ''} onPress={async () => {
            setSubmitting(true); setError(null);
            try {
              const r = await authed<{ cash_up: { variance_kobo: number } }>('/api/pos/cash-up', { method: 'POST', body: { business_id: binding.businessId, day: today, counted_cash_kobo: counted, device_id: binding.deviceId } });
              tap('success');
              setResult(r.cash_up);
            } catch (e) { tap('warning'); setError((e as Error).message === 'http_0' ? 'No connection. Try again when online.' : (e as Error).message); }
            finally { setSubmitting(false); }
          }} />}
    </Card>
  );

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16, flexDirection: wide ? 'row' : 'column', alignItems: wide ? 'flex-start' : 'stretch' }}>
      {summary}
      {counter}
    </ScrollView>
  );
}
