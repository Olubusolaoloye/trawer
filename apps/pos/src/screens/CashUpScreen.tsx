import { useEffect, useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import { formatNaira, nairaToKobo } from '@trawer/core/money';
import type { PosEngine } from '@trawer/core/pos';
import { authed, type DeviceBinding } from '../session';
import { Button, Card, ErrorText, Field, colors, s } from '../components/ui';

const LABEL: Record<string, string> = { cash: 'Cash', card_terminal: 'Card', transfer: 'Transfer', ussd: 'USSD', qr: 'QR', virtual_account: 'Virtual account' };

/** End-of-day: compare cash in the drawer with what the server (and this till) recorded. */
export function CashUpScreen({ engine, binding, pending }: { engine: PosEngine; binding: DeviceBinding; pending: number }) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
  const [local, setLocal] = useState<Record<string, number>>({});
  const [server, setServer] = useState<Record<string, number> | null>(null);
  const [counted, setCounted] = useState('');
  const [result, setResult] = useState<{ variance_kobo: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void engine.localCashUp(today).then(setLocal);
    authed<{ expected: Record<string, number> }>(`/api/pos/cash-up?business_id=${binding.businessId}&day=${today}`)
      .then((r) => setServer(r.expected)).catch(() => setServer(null));
  }, [engine, binding, today]);

  const methods = [...new Set([...Object.keys(local), ...Object.keys(server ?? {})])].filter((m) => (local[m] ?? 0) || (server?.[m] ?? 0));
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={s.h1}>Cash-up · {today}</Text>
      {pending > 0 && <Text style={{ color: colors.warn, fontWeight: '700' }}>{pending} sale(s) not synced yet — connect to the internet so the server totals are complete.</Text>}
      <Card style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row' }}><Text style={[s.label, { flex: 1 }]}>Method</Text><Text style={[s.label, { width: 110, textAlign: 'right' }]}>This till</Text><Text style={[s.label, { width: 110, textAlign: 'right' }]}>Server</Text></View>
        {methods.map((m) => (
          <View key={m} style={{ flexDirection: 'row' }}>
            <Text style={{ flex: 1, fontSize: 16 }}>{LABEL[m] ?? m}</Text>
            <Text style={{ width: 110, textAlign: 'right', fontSize: 16 }}>{formatNaira(local[m] ?? 0)}</Text>
            <Text style={{ width: 110, textAlign: 'right', fontSize: 16 }}>{server ? formatNaira(server[m] ?? 0) : '—'}</Text>
          </View>
        ))}
      </Card>
      <Field label="Cash counted in the drawer (₦)" keyboardType="decimal-pad" value={counted} onChangeText={setCounted} />
      <ErrorText error={error} />
      <Button title="Submit cash-up" disabled={!counted} onPress={async () => {
        try {
          const r = await authed<{ cash_up: { variance_kobo: number } }>('/api/pos/cash-up', { method: 'POST', body: { business_id: binding.businessId, day: today, counted_cash_kobo: nairaToKobo(counted), device_id: binding.deviceId } });
          setResult(r.cash_up);
        } catch (e) { setError((e as Error).message); }
      }} />
      {result && (
        <Text style={{ fontSize: 20, fontWeight: '800', color: result.variance_kobo === 0 ? colors.good : colors.danger }}>
          {result.variance_kobo === 0 ? 'Balanced ✓' : `${result.variance_kobo > 0 ? 'Over' : 'Short'} by ${formatNaira(Math.abs(result.variance_kobo))}`}
        </Text>
      )}
    </ScrollView>
  );
}
