import { useState } from 'react';
import { api } from '../lib/api';
import { useMutation, invalidate } from '../lib/use-api';
import { t } from '../i18n';
import { Button, ErrorNote, Field, Input } from './ui';

/** Two-step phone OTP sign-in. Calls onDone after the session cookie is set and data refreshed. */
export function PhoneSignIn({ onDone }: { onDone: () => void }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  // Accept 0803…, 803…, 234803… or +234803…; the server normalises to E.164.
  const digits = phone.replace(/[\s-]/g, '');
  const full = /^[789]\d{9}$/.test(digits) ? `0${digits}` : digits;
  const send = useMutation(async () => {
    await api('/api/auth/otp', { json: { phone: full } });
    setSent(true);
  });
  const verify = useMutation(async () => {
    await api('/api/auth/verify', { json: { phone: full, code } });
    await invalidate('/api/');
    onDone();
  });
  return (
    <div className="space-y-4">
      {!sent ? (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void send.run(); }}>
          <Field label={t('auth.phone')} hint={t('auth.noPassword')} htmlFor="phone">
            <div className="flex min-h-14 items-center gap-2.5 rounded-xl border-2 border-ink bg-white px-4 focus-within:outline-3 focus-within:outline-ink">
              <span className="font-bold text-body">+234</span>
              <input id="phone" type="tel" inputMode="tel" autoComplete="tel" required placeholder="803 123 4567" value={phone} onChange={(e) => setPhone(e.target.value)}
                className="min-w-0 flex-1 bg-transparent text-lg font-semibold outline-none placeholder:font-medium placeholder:text-muted" />
            </div>
          </Field>
          <ErrorNote error={send.error} />
          <Button type="submit" size="lg" className="w-full" pending={send.pending}>{t('auth.sendCode')}</Button>
        </form>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); void verify.run(); }}>
          <p className="text-body">{t('auth.codeSent', { phone: full })}</p>
          <Field label={t('auth.code')} htmlFor="code" hint={import.meta.env.DEV ? t('auth.devHint') : undefined}>
            <Input id="code" inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} required autoFocus
              value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} className="min-h-14 border-ink text-center font-display text-2xl tracking-[0.5em]" />
          </Field>
          <ErrorNote error={verify.error} />
          <Button type="submit" size="lg" className="w-full" pending={verify.pending}>{t('auth.verify')}</Button>
          <Button type="button" variant="ghost" className="w-full" onClick={() => { setSent(false); setCode(''); }}>{t('auth.changeNumber')}</Button>
        </form>
      )}
    </div>
  );
}
