import { useEffect, useState } from 'react';
import { FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { authed, setBinding, type DeviceBinding } from '../session';
import { Button, Card, ErrorText, Field, colors, fonts, s } from '../components/ui';

interface Me { user: { id: string }; staff: { business_id: string; name: string; role: string }[] }
interface Device { id: string; name: string; location: string; last_sync_at: string | null }

/** Pick the business and which till this phone is (or register it as a new till). */
export function SetupScreen({ onReady }: { onReady: (b: DeviceBinding) => void }) {
  const [me, setMe] = useState<Me | null>(null);
  const [biz, setBiz] = useState<Me['staff'][number] | null>(null);
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { authed<Me>('/api/auth/me').then((m) => { setMe(m); if (m.staff.length === 1) setBiz(m.staff[0]!); }).catch((e) => setError(e.message)); }, []);
  useEffect(() => { if (biz) authed<{ devices: Device[] }>(`/api/pos/devices?business_id=${biz.business_id}`).then((r) => setDevices(r.devices)).catch((e) => setError(e.message)); }, [biz]);

  const bind = async (deviceId: string) => {
    const b: DeviceBinding = { deviceId, businessId: biz!.business_id, businessName: biz!.name, staffId: me!.user.id, role: biz!.role };
    await setBinding(b);
    onReady(b);
  };

  return (
    <SafeAreaView style={{ flex: 1, padding: 20, gap: 14 }}>
      <Text style={s.h1}>{biz ? biz.name : 'Choose your shop'}</Text>
      <ErrorText error={error} />
      {!biz && me && (me.staff.length === 0
        ? <Text style={s.muted}>Your number is not staff at any shop yet. Ask the owner to invite you.</Text>
        : me.staff.map((b) => <Button key={b.business_id} title={`${b.name} (${b.role})`} variant="secondary" onPress={() => setBiz(b)} />))}
      {biz && devices && (
        <>
          <Text style={s.label}>Which till is this?</Text>
          <FlatList data={devices} keyExtractor={(d) => d.id} contentContainerStyle={{ gap: 10 }} renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => void bind(item.id)}>
              <Card><Text style={{ fontSize: 18, fontFamily: fonts.black, color: colors.ink }}>{item.name}</Text><Text style={s.muted}>{item.location}</Text></Card>
            </Pressable>
          )} />
          {(biz.role === 'owner' || biz.role === 'manager') && (
            <View style={{ gap: 10 }}>
              <Field label="Or add this phone as a new till" value={name} onChangeText={setName} placeholder="e.g. Front counter" />
              <Button title="Add till" disabled={!name.trim()} onPress={async () => {
                try {
                  const r = await authed<{ device: { id: string } }>('/api/pos/devices', { method: 'POST', body: { business_id: biz.business_id, name: name.trim(), platform: 'android' } });
                  await bind(r.device.id);
                } catch (e) { setError((e as Error).message); }
              }} />
            </View>
          )}
        </>
      )}
    </SafeAreaView>
  );
}
