import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { getBinding, type DeviceBinding } from './session';
import { getEngine, startSyncLoop, type SyncStatus } from './engine';
import { SignInScreen } from './screens/SignInScreen';
import { SetupScreen } from './screens/SetupScreen';
import { SellScreen } from './screens/SellScreen';
import { CashUpScreen } from './screens/CashUpScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { colors } from './components/ui';

type Phase = 'loading' | 'signin' | 'setup' | 'ready';
type Tab = 'sell' | 'cashup' | 'settings';

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [binding, setBindingState] = useState<DeviceBinding | null>(null);

  useEffect(() => {
    void getBinding().then((b) => { setBindingState(b); setPhase(b ? 'ready' : 'signin'); });
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {phase === 'signin' && <SignInScreen onSignedIn={() => setPhase('setup')} />}
      {phase === 'setup' && <SetupScreen onReady={(b) => { setBindingState(b); setPhase('ready'); }} />}
      {phase === 'ready' && binding && <Till binding={binding} onSignOut={() => setPhase('signin')} />}
    </SafeAreaProvider>
  );
}

function Till({ binding, onSignOut }: { binding: DeviceBinding; onSignOut: () => void }) {
  const engine = useMemo(() => getEngine(binding), [binding]);
  const [tab, setTab] = useState<Tab>('sell');
  const [status, setStatus] = useState<SyncStatus | null>(null);
  useEffect(() => startSyncLoop(engine, setStatus), [engine]);
  const shop = { name: binding.businessName };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.bg }}>
      <View accessibilityRole="summary" style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 8, backgroundColor: status?.online ? colors.brand : colors.warn }}>
        <Text style={{ color: '#fff', fontWeight: '800' }}>{binding.businessName}</Text>
        <Text style={{ color: '#fff', fontWeight: '700' }}>
          {status?.online ? (status.syncing ? 'Syncing…' : 'Online') : 'Offline'}{status?.pending ? ` · ${status.pending} to sync` : ''}{status?.conflicts ? ` · ⚠ ${status.conflicts}` : ''}
        </Text>
      </View>
      <View style={{ flex: 1 }}>
        {tab === 'sell' && <SellScreen engine={engine} binding={binding} shop={shop} />}
        {tab === 'cashup' && <CashUpScreen engine={engine} binding={binding} pending={status?.pending ?? 0} />}
        {tab === 'settings' && <SettingsScreen binding={binding} onSignOut={onSignOut} />}
      </View>
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: colors.line, backgroundColor: '#fff' }}>
        {([['sell', 'Sell'], ['cashup', 'Cash-up'], ['settings', 'Settings']] as const).map(([id, label]) => (
          <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: tab === id }} onPress={() => setTab(id)}
            style={{ flex: 1, minHeight: 60, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 16, fontWeight: '800', color: tab === id ? colors.brand : colors.muted }}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}
