import { useState } from 'react';
import { api, type ApiError } from '../lib/api';
import { invalidate, useApi, useMutation } from '../lib/use-api';
import { formatDate } from '../lib/format';
import { Badge, Button, Card, ErrorNote, Field, Input } from '../components/ui';
import { t, type MessageKey } from '../i18n';
import { useBiz } from './context';
import { MfaPrompt } from './MfaGate';

interface WaData {
  connection: { connected: boolean; display_phone: string | null; catalog: boolean; catalog_synced_at: string | null; own_token: boolean };
  chats: { id: string; wa_phone: string; name: string | null; human_handoff_at: string }[];
  notifications: { id: string; kind: string; status: string; used_template: boolean | null; created_at: string; order_number: number | null; last_error: string | null }[];
}

const tone = (s: string) => (s === 'read' || s === 'delivered' || s === 'sent' ? 'good' : s === 'failed' ? 'bad' : 'warn') as 'good' | 'bad' | 'warn';

export function WhatsAppCard() {
  const b = useBiz();
  const key = `/api/biz/${b.business.id}/whatsapp`;
  const { data } = useApi<WaData>(key, { staleMs: 10_000 });
  const [f, setF] = useState({ phone_number_id: '', display_phone: '', catalog_id: '', token: '' });
  const [askMfa, setAskMfa] = useState(false);
  const save = useMutation(async () => {
    await api(key, { method: 'PUT', json: { ...f, token: f.token || undefined } });
    setF({ ...f, token: '' });
    await invalidate(key);
  });
  const done = useMutation(async (id: string) => { await api(`${key}/chats/${id}/done`, { json: {} }); await invalidate(key); });
  const needsMfa = (save.error as ApiError | null)?.code === 'mfa_required';

  return (
    <Card className="space-y-4" >
      <span id="whatsapp" className="sr-only" />
      {(needsMfa || askMfa) && <MfaPrompt onVerified={() => { setAskMfa(false); save.setError(null); void save.run(); }} onCancel={() => { setAskMfa(false); save.setError(null); }} />}
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-lg font-extrabold">WhatsApp</h2>
        {data && (data.connection.connected ? <Badge tone="good">{t('wa.connected')}{data.connection.display_phone ? ` · ${data.connection.display_phone}` : ''}</Badge> : <Badge tone="warn">{t('wa.notConnected')}</Badge>)}
      </div>

      {data && data.chats.length > 0 && (
        <section className="space-y-2 rounded-2xl border-2 border-green p-3">
          <b>{t('dash.chatsWaiting', { n: data.chats.length })}</b>
          {data.chats.map((c) => (
            <div key={c.id} className="flex items-center justify-between gap-2 text-sm">
              <span><b>{c.name || c.wa_phone}</b> · {c.wa_phone} · {formatDate(c.human_handoff_at, true)}</span>
              <span className="flex gap-2">
                <a className="flex min-h-10 items-center rounded-xl bg-green px-3 font-bold text-white" href={`https://wa.me/${c.wa_phone.replace(/\D/g, '')}`} target="_blank" rel="noreferrer">{t('wa.reply')}</a>
                <Button size="sm" variant="secondary" onClick={() => void done.run(c.id)}>{t('wa.done')}</Button>
              </span>
            </div>
          ))}
        </section>
      )}

      {b.can('settings.manage') && (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); void save.run(); }} autoComplete="off">
          <p className="text-sm text-body">{t('wa.help')}</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('wa.phoneNumberId')} htmlFor="wa-pn"><Input id="wa-pn" inputMode="numeric" required value={f.phone_number_id} onChange={(e) => setF({ ...f, phone_number_id: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label={t('wa.displayPhone')} htmlFor="wa-dp"><Input id="wa-dp" value={f.display_phone} onChange={(e) => setF({ ...f, display_phone: e.target.value })} /></Field>
            <Field label={t('wa.catalogId')} htmlFor="wa-cat" hint={t('common.optional')}><Input id="wa-cat" inputMode="numeric" value={f.catalog_id} onChange={(e) => setF({ ...f, catalog_id: e.target.value.replace(/\D/g, '') })} /></Field>
            <Field label={t('wa.token')} htmlFor="wa-tok" hint={data?.connection.own_token ? t('wa.tokenSaved') : t('wa.tokenHint')}>
              <Input id="wa-tok" type="password" autoComplete="new-password" spellCheck={false} value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} />
            </Field>
          </div>
          {!needsMfa && <ErrorNote error={save.error} />}
          <Button type="submit" pending={save.pending}>{t('common.save')}</Button>
        </form>
      )}

      {data && data.notifications.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-bold">{t('wa.recentMessages')}</summary>
          <ul className="mt-2 divide-y divide-line-soft text-sm">
            {data.notifications.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{t(`wa.kind.${n.kind}` as MessageKey)}{n.order_number ? ` · #${n.order_number}` : ''} · {formatDate(n.created_at, true)}{n.used_template ? ` · ${t('wa.template')}` : ''}</span>
                <Badge tone={tone(n.status)}>{n.status}</Badge>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}
