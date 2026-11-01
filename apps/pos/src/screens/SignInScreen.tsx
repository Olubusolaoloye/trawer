import { useState } from 'react';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Text, View } from 'react-native';
import { requestCode, verifyCode } from '../session';
import { Button, ErrorText, Field, s } from '../components/ui';

export function SignInScreen({ onSignedIn }: { onSignedIn: (r: { userId: string; staffBusinessIds: string[] }) => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setPending(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message === 'rate_limited' ? 'Too many attempts, wait a bit.' : 'That did not work. Check and try again.'); }
    finally { setPending(false); }
  };
  return (
    <SafeAreaView style={{ flex: 1, padding: 20, justifyContent: 'center', gap: 16 }}>
      <Text style={s.h1}>Trawer POS</Text>
      {!sent ? (
        <View style={{ gap: 16 }}>
          <Field label="Your phone number" keyboardType="phone-pad" autoComplete="tel" value={phone} onChangeText={setPhone} placeholder="0803 123 4567" />
          <ErrorText error={error} />
          <Button title="Send code" pending={pending} onPress={() => run(async () => { await requestCode(phone); setSent(true); })} />
        </View>
      ) : (
        <View style={{ gap: 16 }}>
          <Field label="6-digit code" keyboardType="number-pad" maxLength={6} autoComplete="sms-otp" value={code} onChangeText={(t) => setCode(t.replace(/\D/g, ''))} />
          <ErrorText error={error} />
          <Button title="Sign in" pending={pending} onPress={() => run(async () => onSignedIn(await verifyCode(phone, code)))} />
          <Button title="Change number" variant="secondary" onPress={() => setSent(false)} />
        </View>
      )}
    </SafeAreaView>
  );
}
