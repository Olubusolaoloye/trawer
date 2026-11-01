import { useState } from 'react';
import { api } from '../lib/api';
import { useMutation, invalidate } from '../lib/use-api';
import { t } from '../i18n';
import { Button, ErrorNote, Field, Input } from './ui';

/** Two-step phone OTP sign-in. Calls onDone after the session cookie is set. */
export function PhoneSignIn({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const send = useMutation(async () => {
    await api('/api/auth/otp', { json: { phone } });
    setSent(true);
  });
  const verify = useMutation(async () => {
    await api('/api/auth/verify', { json: { phone, code } });
    await invalidate('/api/');
    onDone();
  });
  return (
    <div className="space-y-4">
      {!sent ? (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void send.run(); }}>
          <Field label={t('auth.phone')} hint={t('auth.phoneHint')} htmlFor="phone">
            <Input id="phone" type="tel" inputMode="tel" autoComplete="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <ErrorNote error={send.error} />
          <Button type="submit" className="w-full" pending={send.pending}>{t('auth.sendCode')}</Button>
        </form>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void verify.run(); }}>
          <p className="text-stone-700">{t('auth.codeSent', { phone })}</p>
          <Field label={t('auth.code')} htmlFor="code" hint={import.meta.env.DEV ? t('auth.devHint') : undefined}>
            <Input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="tracking-[0.4em] text-xl" />
          </Field>
          <ErrorNote error={verify.error} />
          <Button type="submit" className="w-full" pending={verify.pending}>{t('auth.verify')}</Button>
          <Button type="button" variant="ghost" className="w-full" onClick={() => { setSent(false); setCode(''); }}>{t('auth.changeNumber')}</Button>
        </form>
      )}
    </div>
  );
}
