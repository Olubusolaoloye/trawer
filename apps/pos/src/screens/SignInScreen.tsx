import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowRight, ScanLine, WifiOff, Zap } from 'lucide-react-native';
import { requestCode, verifyCode } from '../session';
import { Button, ErrorText, Field, Glow, colors, fonts, radius, s, tap } from '../components/ui';

export function SignInScreen({ onSignedIn }: { onSignedIn: (r: { userId: string; staffBusinessIds: string[] }) => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setPending(true); setError(null);
    try { await fn(); } catch (e) { tap('warning'); setError((e as Error).message === 'rate_limited' ? 'Too many attempts, wait a bit.' : 'That did not work. Check and try again.'); }
    finally { setPending(false); }
  };
  return (
    <SafeAreaView edges={['top']} style={{ flex: 1, backgroundColor: colors.ink }}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1 }} keyboardShouldPersistTaps="handled">
          <View style={{ padding: 24, paddingBottom: 40, gap: 18, overflow: 'hidden' }}>
            <Glow id="signin" />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <View style={{ width: 44, height: 44, borderRadius: 13, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontFamily: fonts.display, fontSize: 22 }}>T</Text>
              </View>
              <Text style={{ color: '#fff', fontFamily: fonts.display, fontSize: 24 }}>trawer <Text style={{ color: colors.gold }}>till</Text></Text>
            </View>
            <Text accessibilityRole="header" style={{ color: '#fff', fontFamily: fonts.display, fontSize: 38, lineHeight: 42, letterSpacing: -1 }}>Sell at the counter, even offline.</Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {[[WifiOff, 'Works offline'], [ScanLine, 'Scan barcodes'], [Zap, 'Live stock']].map(([I, label]) => {
                const C = I as typeof WifiOff;
                return (
                  <View key={label as string} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 8, borderRadius: 999, backgroundColor: 'rgba(255,255,255,0.1)' }}>
                    <C size={15} color={colors.gold} /><Text style={{ color: colors.onInk, fontFamily: fonts.bold, fontSize: 13 }}>{label as string}</Text>
                  </View>
                );
              })}
            </View>
          </View>
          <View style={{ flex: 1, backgroundColor: colors.paper, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl, padding: 24, gap: 16 }}>
            {!sent ? (
              <>
                <Text style={s.h2}>Sign in with your phone</Text>
                <Field label="Your phone number" keyboardType="phone-pad" autoComplete="tel" value={phone} onChangeText={setPhone} placeholder="0803 123 4567" />
                <ErrorText error={error} />
                <Button big icon={ArrowRight} title="Send code" pending={pending} disabled={phone.replace(/\D/g, '').length < 10} onPress={() => run(async () => { await requestCode(phone); setSent(true); })} />
              </>
            ) : (
              <>
                <Text style={s.h2}>Enter the code we sent</Text>
                <Text style={s.muted}>Sent by SMS to {phone}</Text>
                <Field label="6-digit code" keyboardType="number-pad" maxLength={6} autoComplete="sms-otp" value={code} onChangeText={(t) => setCode(t.replace(/\D/g, ''))}
                  style={{ fontSize: 28, letterSpacing: 10, fontFamily: fonts.black, textAlign: 'center' }} />
                <ErrorText error={error} />
                <Button big title="Sign in" pending={pending} disabled={code.length !== 6} onPress={() => run(async () => onSignedIn(await verifyCode(phone, code)))} />
                <Button title="Change number" variant="soft" onPress={() => { setSent(false); setCode(''); }} />
              </>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
