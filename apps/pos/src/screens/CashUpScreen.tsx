import { useEffect, useState } from 'react';
import { Pressable, ScrollView, Text, View, useWindowDimensions } from 'react-native';
import { formatNaira } from '@trawer/core/money';
import type { PosEngine } from '@trawer/core/pos';
import { authed, type DeviceBinding } from '../session';
import { Button, Card, ErrorText, colors, fonts, s } from '../components/ui';

const LABEL: Record<string, string> = { cash: 'Cash', card_terminal: 'Card terminal', transfer: 'Transfer', ussd: 'USSD', qr: 'QR', virtual_account: 'Virtual account' };
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', '⌫'];

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
  const press = (k: string) => {
    setResult(null);
    if (k === 'C') setDigits('');
    else if (k === '⌫') setDigits((d) => d.slice(0, -1));
    else if (digits.length < 9) setDigits((d) => (d + k).replace(/^0+(?=\d)/, ''));
  };
  const tone = diff === 0 ? [colors.green50, colors.greenInk] : diff > 0 ? [colors.gold50, colors.goldInk] : [colors.red50, colors.redInk];

  const summary = (
    <View style={{ flex: 1, gap: 14 }}>
      <Text style={s.h1}>Close the day</Text>
      {pending > 0 && <Text style={{ color: colors.goldInk, fontFamily: fonts.bold, backgroundColor: colors.gold50, padding: 12, borderRadius: 12 }}>{pending} sale(s) not sent yet. Connect to the internet so the server totals are complete.</Text>}
      <Card style={{ paddingVertical: 4 }}>
        <View style={{ flexDirection: 'row', paddingVertical: 10 }}>
          <Text style={[s.label, { flex: 1.4, color: colors.muted, fontSize: 13 }]}>Method</Text>
          <Text style={[s.label, { flex: 1, textAlign: 'right', color: colors.muted, fontSize: 13 }]}>This till</Text>
          <Text style={[s.label, { flex: 1, textAlign: 'right', color: colors.muted, fontSize: 13 }]}>Trawer ledger</Text>
        </View>
        {methods.length === 0 && <Text style={[s.muted, { paddingVertical: 12 }]}>No sales yet today.</Text>}
        {methods.map((m) => (
          <View key={m} style={{ flexDirection: 'row', paddingVertical: 12, borderTopWidth: 1, borderColor: colors.lineSoft }}>
            <Text style={{ flex: 1.4, fontFamily: fonts.bold, fontSize: 17 }}>{LABEL[m] ?? m}</Text>
            <Text style={[s.money, { flex: 1, textAlign: 'right', fontSize: 17, fontFamily: fonts.semi }]}>{formatNaira(local[m] ?? 0)}</Text>
            <Text style={[s.money, { flex: 1, textAlign: 'right', fontSize: 17, fontFamily: fonts.semi }]}>{server ? formatNaira(server[m] ?? 0) : '—'}</Text>
          </View>
        ))}
      </Card>
    </View>
  );

  const counter = (
    <Card strong style={{ width: wide ? 420 : undefined, gap: 14, padding: 18 }}>
      <Text style={s.label}>Count the cash in the drawer</Text>
      <View accessibilityLiveRegion="polite" style={{ minHeight: 64, borderRadius: 16, backgroundColor: colors.paper, justifyContent: 'center', alignItems: 'flex-end', paddingHorizontal: 18 }}>
        <Text style={[s.money, { fontSize: 38 }]}>{formatNaira(counted)}</Text>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {KEYS.map((k) => (
          <Pressable key={k} accessibilityRole="button" accessibilityLabel={k === '⌫' ? 'Delete last digit' : k === 'C' ? 'Clear' : k} onPress={() => press(k)}
            style={{ width: '31.5%', minHeight: 58, borderRadius: 14, borderWidth: 2, borderColor: colors.line, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontFamily: fonts.black, fontSize: 22, color: colors.ink }}>{k}</Text>
          </Pressable>
        ))}
      </View>
      {digits !== '' && (
        <View style={{ padding: 14, borderRadius: 16, backgroundColor: tone[0] }}>
          <Text style={{ fontFamily: fonts.black, fontSize: 18, color: tone[1] }}>{diff === 0 ? 'Balanced. Well done.' : `${diff > 0 ? 'Over' : 'Short'} by ${formatNaira(Math.abs(diff))}`}</Text>
          <Text style={s.muted}>Expected cash {formatNaira(expectedCash)}</Text>
        </View>
      )}
      <ErrorText error={error} />
      {result
        ? <Text style={{ fontFamily: fonts.black, fontSize: 18, color: colors.greenInk, textAlign: 'center' }}>Day closed ✓ The owner can see it now.</Text>
        : <Button big title="Close day" pending={submitting} disabled={digits === ''} onPress={async () => {
            setSubmitting(true); setError(null);
            try {
              const r = await authed<{ cash_up: { variance_kobo: number } }>('/api/pos/cash-up', { method: 'POST', body: { business_id: binding.businessId, day: today, counted_cash_kobo: counted, device_id: binding.deviceId } });
              setResult(r.cash_up);
            } catch (e) { setError((e as Error).message === 'http_0' ? 'No connection. Try again when online.' : (e as Error).message); }
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
