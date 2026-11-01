import { useState } from 'react';
import { ScrollView, Text } from 'react-native';
import { connectPrinter, hasPrinter, scanPrinters } from '../printer';
import { signOut, type DeviceBinding } from '../session';
import { Button, Card, ErrorText, s } from '../components/ui';

export function SettingsScreen({ binding, onSignOut }: { binding: DeviceBinding; onSignOut: () => void }) {
  const [found, setFound] = useState<{ id: string; name: string }[]>([]);
  const [connected, setConnected] = useState(hasPrinter());
  const [error, setError] = useState<string | null>(null);
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Text style={s.h1}>Settings</Text>
      <Card><Text style={s.label}>{binding.businessName}</Text><Text style={s.muted}>Till {binding.deviceId.slice(0, 8)} · {binding.role}</Text></Card>
      <Text style={s.label}>Receipt printer {connected ? '· connected ✓' : ''}</Text>
      <Button title="Find Bluetooth printers" variant="secondary" onPress={() => { setFound([]); scanPrinters((d) => setFound((f) => [...f, d])); }} />
      {found.map((d) => (
        <Button key={d.id} title={d.name} variant="secondary" onPress={async () => {
          try { await connectPrinter(d.id); setConnected(true); } catch (e) { setError((e as Error).message); }
        }} />
      ))}
      <ErrorText error={error} />
      <Button title="Sign out" variant="danger" onPress={async () => { await signOut(); onSignOut(); }} />
    </ScrollView>
  );
}
