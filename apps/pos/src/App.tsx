import { useEffect, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold } from '@expo-google-fonts/bricolage-grotesque';
import { Inter_400Regular, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold } from '@expo-google-fonts/inter';
import { getBinding, type DeviceBinding } from './session';
import { getEngine, startSyncLoop, type SyncStatus } from './engine';
import { SignInScreen } from './screens/SignInScreen';
import { SetupScreen } from './screens/SetupScreen';
import { SellScreen } from './screens/SellScreen';
import { CashUpScreen } from './screens/CashUpScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { colors, fonts, SyncPill } from './components/ui';

type Phase = 'loading' | 'signin' | 'setup' | 'ready';
type Tab = 'sell' | 'cashup' | 'settings';

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [binding, setBindingState] = useState<DeviceBinding | null>(null);
  // Fonts are bundled with the app (no network needed); render once loaded or after a failure.
  const [fontsReady, fontError] = useFonts({ BricolageGrotesque_700Bold, BricolageGrotesque_800ExtraBold, Inter_400Regular, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold });

  useEffect(() => {
    void getBinding().then((b) => { setBindingState(b); setPhase(b ? 'ready' : 'signin'); });
  }, []);

  if (!fontsReady && !fontError) return null;
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
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
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.ink }}>
      <View accessibilityRole="summary" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 10, backgroundColor: colors.ink }}>
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#fff', fontFamily: fonts.display, fontSize: 19 }} numberOfLines={1}>{binding.businessName}</Text>
        </View>
        <SyncPill
          tone={status?.conflicts ? 'fix' : status?.online ? 'live' : 'offline'}
          label={status?.conflicts ? `${status.conflicts} to fix`
            : status?.online ? (status.syncing ? 'Syncing…' : status.pending ? `Live · sending ${status.pending}` : 'Live')
            : `Offline · ${status?.pending ?? 0} saved · keep selling`} />
      </View>
      <View style={{ flex: 1, backgroundColor: colors.paper }}>
        {tab === 'sell' && <SellScreen engine={engine} binding={binding} shop={shop} />}
        {tab === 'cashup' && <CashUpScreen engine={engine} binding={binding} pending={status?.pending ?? 0} />}
        {tab === 'settings' && <SettingsScreen binding={binding} onSignOut={onSignOut} />}
      </View>
      <View accessibilityRole="tablist" style={{ flexDirection: 'row', borderTopWidth: 1, borderColor: colors.line, backgroundColor: '#fff' }}>
        {([['sell', 'Sell'], ['cashup', 'Cash-up'], ['settings', 'Settings']] as const).map(([id, label]) => (
          <Pressable key={id} accessibilityRole="tab" accessibilityState={{ selected: tab === id }} onPress={() => setTab(id)}
            style={{ flex: 1, minHeight: 60, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ fontSize: 16, fontFamily: tab === id ? fonts.black : fonts.semi, color: tab === id ? colors.green : colors.body }}>{label}</Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}
