import { useState } from 'react';
import { api } from '../lib/api';
import { useMutation } from '../lib/use-api';
import { Button, Card, ErrorNote, Field, Input } from '../components/ui';
import { t } from '../i18n';

/**
 * Shown when the API answers mfa_required: enrol (first time) or verify a TOTP code, which
 * upgrades the session to aal2, then the caller retries.
 */
export function MfaPrompt({ onVerified, onCancel }: { onVerified: () => void; onCancel: () => void }) {
  const [factor, setFactor] = useState<{ factorId: string; uri: string; secret: string } | null>(null);
  const [code, setCode] = useState('');
  const start = useMutation(async () => setFactor(await api('/api/auth/mfa/enroll', { json: {} })));
  const verify = useMutation(async () => {
    await api('/api/auth/mfa/verify', { json: { factorId: factor!.factorId, code } });
    onVerified();
  });
  return (
    <div role="dialog" aria-modal="true" aria-labelledby="mfa-title" className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center">
      <Card className="w-full max-w-md space-y-4">
        <h2 id="mfa-title" className="text-xl font-bold">{t('auth.mfaTitle')}</h2>
        <p className="text-stone-700">{t('auth.mfaBody')}</p>
        {!factor ? (
          <Button className="w-full" pending={start.pending} onClick={() => void start.run()}>{t('common.continue')}</Button>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void verify.run(); }}>
            <p className="text-sm text-stone-700">{t('auth.mfaSetup')}</p>
            <code className="block break-all rounded-lg bg-stone-100 p-2 text-sm">{factor.secret}</code>
            <Field label={t('auth.code')} htmlFor="totp" hint={import.meta.env.DEV ? t('auth.devHint') : undefined}>
              <Input id="totp" inputMode="numeric" maxLength={6} autoFocus value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </Field>
            <ErrorNote error={verify.error ?? start.error} />
            <Button type="submit" className="w-full" pending={verify.pending}>{t('auth.verify')}</Button>
          </form>
        )}
        <Button variant="ghost" className="w-full" onClick={onCancel}>{t('common.cancel')}</Button>
      </Card>
    </div>
  );
}

/** Wrap a mutation: on mfa_required show the prompt, then retry once verified. */
export function useMfaRetry() {
  const [pending, setPending] = useState<(() => void) | null>(null);
  const prompt = pending ? <MfaPrompt onVerified={() => { const p = pending; setPending(null); p(); }} onCancel={() => setPending(null)} /> : null;
  return {
    prompt,
    guard: (err: { code?: string } | null | undefined, retry: () => void) => {
      if (err?.code === 'mfa_required') setPending(() => retry);
    },
  };
}
