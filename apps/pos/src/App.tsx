import { useEffect, useMemo, useState } from 'react';
import { Text, View, useWindowDimensions } from 'react-native';
import { Bike, Calculator, Settings as SettingsIcon, ShoppingBag } from 'lucide-react-native';
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { DeliveriesScreen } from './screens/DeliveriesScreen';
import { colors, fonts, Glow, Press, SyncPill, type Icon } from './components/ui';

type Phase = 'loading' | 'signin' | 'setup' | 'ready';
type Tab = 'sell' | 'deliveries' | 'cashup' | 'settings';

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

const TABS: { id: Tab; label: string; icon: Icon }[] = [
  { id: 'sell', label: 'Sell', icon: ShoppingBag },
  { id: 'deliveries', label: 'Deliveries', icon: Bike },
  { id: 'cashup', label: 'Cash-up', icon: Calculator },
  { id: 'settings', label: 'Settings', icon: SettingsIcon },
];
/** Riders only deliver; cashiers only sell; owners, managers and store keepers do both. */
function tabsFor(role: string): Tab[] {
  if (role === 'rider') return ['deliveries', 'settings'];
  if (role === 'cashier') return ['sell', 'cashup', 'settings'];
  return ['sell', 'deliveries', 'cashup', 'settings'];
}

function Till({ binding, onSignOut }: { binding: DeviceBinding; onSignOut: () => void }) {
  const engine = useMemo(() => getEngine(binding), [binding]);
  const tabs = tabsFor(binding.role);
  const [tab, setTab] = useState<Tab>(tabs[0]!);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  useEffect(() => startSyncLoop(engine, setStatus), [engine]);
  const shop = { name: binding.businessName };
  const narrow = useWindowDimensions().width < 520;

  return (
    <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1, backgroundColor: colors.ink }}>
      <View accessibilityRole="summary" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 14, backgroundColor: colors.ink, overflow: 'hidden' }}>
        <Glow id="hdr" />
        <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontFamily: fonts.display, fontSize: 20 }}>{binding.businessName.charAt(0)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ color: '#fff', fontFamily: fonts.display, fontSize: 19, letterSpacing: -0.3 }} numberOfLines={1}>{binding.businessName}</Text>
          <Text style={{ color: colors.onInkMuted, fontFamily: fonts.semi, fontSize: 12 }} numberOfLines={1}>Till · {binding.role}</Text>
        </View>
        <SyncPill onInk
          tone={status?.conflicts ? 'fix' : status?.online ? 'live' : 'offline'}
          label={status?.conflicts ? `${status.conflicts} to fix`
            : status?.online ? (status.syncing ? 'Syncing…' : status.pending ? `Live · sending ${status.pending}` : 'Live')
            : narrow ? `Offline · ${status?.pending ?? 0} saved` : `Offline · ${status?.pending ?? 0} saved · keep selling`} />
      </View>
      <View style={{ flex: 1, backgroundColor: colors.paper, borderTopLeftRadius: 22, borderTopRightRadius: 22, overflow: 'hidden', marginTop: -8 }}>
        {tab === 'sell' && <SellScreen engine={engine} binding={binding} shop={shop} />}
        {tab === 'deliveries' && <DeliveriesScreen binding={binding} />}
        {tab === 'cashup' && <CashUpScreen engine={engine} binding={binding} pending={status?.pending ?? 0} />}
        {tab === 'settings' && <SettingsScreen binding={binding} onSignOut={onSignOut} />}
      </View>
      <TabBar tabs={tabs} tab={tab} onChange={setTab} />
    </SafeAreaView>
  );
}

function TabBar({ tabs, tab, onChange }: { tabs: Tab[]; tab: Tab; onChange: (t: Tab) => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: 'row', gap: 6, paddingHorizontal: Math.max(10, (useWindowDimensions().width - 640) / 2), paddingTop: 8, paddingBottom: Math.max(insets.bottom, 10), backgroundColor: colors.surface, borderTopWidth: 1, borderColor: 'rgba(228,222,210,0.7)' }}>
      {TABS.filter((x) => tabs.includes(x.id)).map(({ id, label, icon: I }) => {
        const on = tab === id;
        return (
          <Press key={id} accessibilityRole="tab" accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={() => onChange(id)} scaleTo={0.94}
            style={{ flex: 1, minHeight: 56, alignItems: 'center', justifyContent: 'center', gap: 3 }}>
            <View style={{ paddingHorizontal: 18, paddingVertical: 5, borderRadius: 999, backgroundColor: on ? colors.green50 : 'transparent' }}>
              <I size={23} color={on ? colors.green : colors.body} strokeWidth={on ? 2.6 : 2.1} />
            </View>
            <Text style={{ fontSize: 13, fontFamily: on ? fonts.black : fonts.semi, color: on ? colors.greenInk : colors.body }}>{label}</Text>
          </Press>
        );
      })}
    </View>
  );
}
