import { useState } from 'react';
import { ActivityIndicator, ScrollView, Text, View } from 'react-native';
import { Bluetooth, CheckCircle2, LogOut, MonitorSmartphone, Printer, Store } from 'lucide-react-native';
import { connectPrinter, hasPrinter, scanPrinters } from '../printer';
import { signOut, type DeviceBinding } from '../session';
import { Button, Card, ErrorText, Row, colors, s, tap } from '../components/ui';

export function SettingsScreen({ binding, onSignOut }: { binding: DeviceBinding; onSignOut: () => void }) {
  const [found, setFound] = useState<{ id: string; name: string }[]>([]);
  const [searching, setSearching] = useState(false);
  const [connected, setConnected] = useState(hasPrinter());
  const [error, setError] = useState<string | null>(null);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
      <Text accessibilityRole="header" style={s.h1}>Settings</Text>

      <View style={{ gap: 8 }}>
        <Text style={s.eyebrow}>This till</Text>
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <Row icon={Store} tint={colors.green} title={binding.businessName} subtitle={`Signed in as ${binding.role}`} />
          <View style={{ borderTopWidth: 1, borderColor: colors.lineSoft }}><Row icon={MonitorSmartphone} title={`Till ${binding.deviceId.slice(0, 8)}`} subtitle="Sales are saved on this phone and sent when online" /></View>
        </Card>
      </View>

      <View style={{ gap: 8 }}>
        <Text style={s.eyebrow}>Receipt printer</Text>
        <Card style={{ padding: 0, overflow: 'hidden' }}>
          <Row icon={Printer} tint={connected ? colors.green : undefined} title={connected ? 'Printer connected' : 'No printer connected'} subtitle={connected ? 'Receipts print after each sale' : 'Pair a Bluetooth receipt printer'}
            right={connected ? <CheckCircle2 size={22} color={colors.green} /> : undefined} />
          {found.map((d) => (
            <View key={d.id} style={{ borderTopWidth: 1, borderColor: colors.lineSoft }}>
              <Row icon={Bluetooth} title={d.name} subtitle="Tap to connect" onPress={async () => {
                try { await connectPrinter(d.id); tap('success'); setConnected(true); } catch (e) { setError((e as Error).message); }
              }} />
            </View>
          ))}
          {searching && found.length === 0 && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 14, borderTopWidth: 1, borderColor: colors.lineSoft }}>
              <ActivityIndicator color={colors.green} /><Text style={s.muted}>Looking for printers nearby…</Text>
            </View>
          )}
        </Card>
        <Button icon={Bluetooth} title="Find Bluetooth printers" variant="secondary" onPress={() => { setFound([]); setSearching(true); scanPrinters((d) => setFound((f) => [...f, d])); setTimeout(() => setSearching(false), 8000); }} />
      </View>

      <ErrorText error={error} />
      <Button icon={LogOut} title="Sign out" variant="danger" onPress={async () => { await signOut(); onSignOut(); }} />
    </ScrollView>
  );
}
