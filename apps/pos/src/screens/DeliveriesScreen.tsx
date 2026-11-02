import { useCallback, useEffect, useRef, useState } from 'react';
import { Image, Linking, Modal, RefreshControl, ScrollView, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Bike, Camera, CheckCircle2, CloudOff, MapPin, MessageCircle, Navigation, PackageCheck, Phone, RotateCcw, TriangleAlert, X } from 'lucide-react-native';
import { formatNaira } from '@trawer/core/money';
import { riderQueue, stateRepo } from '../engine';
import { authed, type DeviceBinding } from '../session';
import { FAILURE_LABEL, addressLine, effectiveStatus, mapsUrl, type FailureReason, type RiderAction, type RiderStatus } from '../rider';
import { Button, Card, Chip, ErrorText, Field, IconButton, Press, Sheet, colors, fonts, radius, s, shadow, tap, type Icon } from '../components/ui';

interface Address { line1?: string; area?: string; city?: string; state?: string; landmark?: string }
interface Run {
  id: string; order_id: string; order_number: number; status: string; address: Address | null; recipient_name: string | null; recipient_phone: string | null;
  collect_kobo: number; attempts: number; dispatched_at: string | null; delivered_at: string | null; failure: FailureReason | null; shop: string; note: string | null;
  items: { name: string; label: string | null; qty: number; unit: string | null }[];
}

const GROUPS: { id: string; title: string; match: (s: string) => boolean; tone: [string, string]; icon: Icon }[] = [
  { id: 'way', title: 'On the way', match: (s) => s === 'dispatched', tone: [colors.indigo50, colors.indigo], icon: Bike },
  { id: 'ready', title: 'Ready to go', match: (s) => s === 'packed', tone: [colors.green50, colors.greenInk], icon: PackageCheck },
  { id: 'failed', title: "Couldn't deliver", match: (s) => s === 'failed', tone: [colors.red50, colors.redInk], icon: TriangleAlert },
  { id: 'done', title: 'Done today', match: (s) => s === 'delivered' || s === 'returned', tone: [colors.lineSoft, colors.body], icon: CheckCircle2 },
];
const SHEET_KEY = 'rider_sheet';
const uuid = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function DeliveriesScreen({ binding }: { binding: DeviceBinding }) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [queued, setQueued] = useState<RiderAction[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [open, setOpen] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);

  const load = useCallback(async () => {
    const flushed = await riderQueue.flush();
    if (flushed.rejected.length) setError(`Order #${flushed.rejected[0]!.action.orderNumber}: ${flushed.rejected[0]!.code.replace(/_/g, ' ')}. Ask the shop to check it.`);
    try {
      const r = await authed<{ deliveries: Run[] }>(`/api/pos/deliveries?business_id=${binding.businessId}`);
      setRuns(r.deliveries);
      setOffline(false);
      await stateRepo.kvSet(SHEET_KEY, r.deliveries);
    } catch {
      setOffline(true);
      setRuns((cur) => cur ?? []);
      const cached = await stateRepo.kvGet<Run[]>(SHEET_KEY, []);
      setRuns((cur) => (cur && cur.length ? cur : cached));
    }
    setQueued(await riderQueue.pending());
  }, [binding.businessId]);

  useEffect(() => {
    void stateRepo.kvGet<Run[]>(SHEET_KEY, []).then((c) => setRuns((cur) => cur ?? (c.length ? c : null)));
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (run: Run, status: RiderStatus, extra: Partial<RiderAction> = {}) => {
    await riderQueue.enqueue({ clientId: uuid(), orderId: run.order_id, orderNumber: run.order_number, status, occurredAt: new Date().toISOString(), ...extra });
    tap(status === 'failed' ? 'warning' : 'success');
    setQueued(await riderQueue.pending());
    setOpen(null);
    void load();
  };

  const view = (runs ?? []).map((r) => ({ ...r, status: effectiveStatus(r.status, r.order_id, queued) }));
  const active = view.filter((r) => r.status !== 'delivered' && r.status !== 'returned');
  const toCollect = active.reduce((n, r) => n + r.collect_kobo, 0);

  return (
    <View style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16, paddingBottom: 32 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} tintColor={colors.green} />}>
        <View>
          <Text style={s.eyebrow}>{new Date().toLocaleDateString('en-NG', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Africa/Lagos' })}</Text>
          <Text accessibilityRole="header" style={s.h1}>Deliveries</Text>
        </View>

        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Stat label="To deliver" value={String(active.length)} />
          <Stat label="Cash to collect" value={formatNaira(toCollect)} gold={toCollect > 0} />
        </View>

        {(queued.length > 0 || offline) && (
          <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: radius.lg, backgroundColor: colors.gold50 }}>
            <CloudOff size={20} color={colors.goldInk} />
            <Text style={{ flex: 1, fontFamily: fonts.bold, fontSize: 14, color: colors.goldInk }}>
              {queued.length ? `${queued.length} update${queued.length === 1 ? '' : 's'} saved on this phone. They send by themselves when the network is back.` : 'No network. Showing your last list.'}
            </Text>
          </View>
        )}
        <ErrorText error={error} />

        {runs === null ? <Text style={s.muted}>Loading your deliveries…</Text>
          : view.length === 0 ? (
            <View style={{ alignItems: 'center', gap: 10, paddingVertical: 48 }}>
              <View style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: colors.green50, alignItems: 'center', justifyContent: 'center' }}><Bike size={40} color={colors.green} /></View>
              <Text style={s.h2}>No deliveries yet</Text>
              <Text style={[s.muted, { textAlign: 'center' }]}>When the shop gives you an order to deliver, it shows here.</Text>
            </View>
          )
          : GROUPS.map((g) => {
            const list = view.filter((r) => g.match(r.status));
            if (!list.length) return null;
            return (
              <View key={g.id} style={{ gap: 10 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <g.icon size={18} color={g.tone[1]} />
                  <Text style={[s.eyebrow, { color: g.tone[1] }]}>{g.title} · {list.length}</Text>
                </View>
                {list.map((r) => <RunCard key={r.id} run={r} queued={queued.some((q) => q.orderId === r.order_id)} onOpen={() => setOpen(r)} onAct={act} />)}
              </View>
            );
          })}
      </ScrollView>
      {open && <RunSheet run={view.find((r) => r.id === open.id) ?? open} onClose={() => setOpen(null)} onAct={act} />}
    </View>
  );
}

function Stat({ label, value, gold }: { label: string; value: string; gold?: boolean }) {
  return (
    <View style={[{ flex: 1, padding: 14, borderRadius: radius.lg, backgroundColor: gold ? colors.ink : colors.surface, gap: 2 }, gold ? shadow.lift : shadow.card]}>
      <Text style={{ fontFamily: fonts.semi, fontSize: 13, color: gold ? colors.onInkMuted : colors.muted }}>{label}</Text>
      <Text style={[s.money, { fontSize: 24, color: gold ? colors.gold : colors.ink }]}>{value}</Text>
    </View>
  );
}

function itemsLine(items: Run['items']): string {
  if (!items.length) return '';
  const first = items[0]!;
  return `${first.qty} ${first.unit ?? ''} ${first.name}${first.label ? ` (${first.label})` : ''}${items.length > 1 ? ` · +${items.length - 1} more` : ''}`.replace(/\s+/g, ' ');
}

function RunCard({ run, queued, onOpen, onAct }: { run: Run; queued: boolean; onOpen: () => void; onAct: (r: Run, s: RiderStatus) => void }) {
  const done = run.status === 'delivered' || run.status === 'returned';
  // The details and the action are sibling buttons (never nested), so screen readers reach both.
  return (
    <View style={[{ borderRadius: radius.lg, backgroundColor: colors.surface, padding: 14, gap: 10, borderWidth: 1, borderColor: 'rgba(228,222,210,0.7)', opacity: done ? 0.75 : 1 }, shadow.card]}>
      <Press accessibilityRole="button" accessibilityHint="Opens the delivery details" accessibilityLabel={`Order ${run.order_number} for ${run.recipient_name ?? 'customer'}. ${addressLine(run.address)}`} onPress={onOpen} scaleTo={0.985} style={{ gap: 10 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontFamily: fonts.display, fontSize: 20, color: colors.ink }}>#{run.order_number}</Text>
          {run.attempts > 1 && <Badge text={`Try ${run.attempts}`} tone={[colors.gold50, colors.goldInk]} />}
          {queued && <Badge text="Saved" tone={[colors.gold50, colors.goldInk]} />}
          <View style={{ flex: 1 }} />
          {run.collect_kobo > 0 && !done
            ? <Badge text={`Collect ${formatNaira(run.collect_kobo)}`} tone={[colors.ink, colors.gold]} />
            : <Badge text={done ? (run.status === 'returned' ? 'Returned' : 'Delivered') : 'Paid'} tone={[colors.green50, colors.greenInk]} />}
        </View>
        <View style={{ gap: 3 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 17, color: colors.ink }}>{run.recipient_name ?? 'Customer'}</Text>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <MapPin size={16} color={colors.muted} style={{ marginTop: 2 }} />
            <Text style={[s.muted, { flex: 1, fontSize: 14 }]} numberOfLines={2}>{addressLine(run.address)}{run.address?.landmark ? ` · ${run.address.landmark}` : ''}</Text>
          </View>
          <Text style={[s.muted, { fontSize: 13 }]} numberOfLines={1}>{itemsLine(run.items)}</Text>
        </View>
      </Press>
      {run.status === 'packed' && <Button icon={Bike} title="Start delivery" accessibilityLabel={`Start delivery for order ${run.order_number}`} onPress={() => onAct(run, 'dispatched')} />}
      {run.status === 'dispatched' && <Button icon={Camera} title="Delivered · take photo" accessibilityLabel={`Order ${run.order_number} delivered, take photo`} onPress={onOpen} />}
      {run.status === 'failed' && <Button icon={RotateCcw} variant="ink" title="Try again" accessibilityLabel={`Try order ${run.order_number} again`} onPress={() => onAct(run, 'dispatched')} />}
    </View>
  );
}

function Badge({ text, tone }: { text: string; tone: [string, string] }) {
  return <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: tone[0] }}><Text style={{ fontFamily: fonts.black, fontSize: 12, color: tone[1] }}>{text}</Text></View>;
}

function RunSheet({ run, onClose, onAct }: { run: Run; onClose: () => void; onAct: (r: Run, s: RiderStatus, extra?: Partial<RiderAction>) => Promise<void> }) {
  const [step, setStep] = useState<'menu' | 'failed' | 'camera' | 'confirm'>('menu');
  const [photo, setPhoto] = useState<string | null>(null);
  const [receivedBy, setReceivedBy] = useState(run.recipient_name ?? '');
  const [reason, setReason] = useState<FailureReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const cam = useRef<CameraView>(null);
  const phone = run.recipient_phone?.replace(/[^\d+]/g, '') ?? '';
  const done = run.status === 'delivered' || run.status === 'returned';

  const snap = async () => {
    const p = await cam.current?.takePictureAsync({ quality: 0.5, skipProcessing: true }).catch(() => null);
    if (p?.uri) { tap('medium'); setPhoto(p.uri); setStep('confirm'); }
  };

  return (
    <>
      <Sheet visible={step !== 'camera'} onClose={onClose} title={`Order #${run.order_number}`}>
        {step === 'menu' && <>
          <Card flat style={{ gap: 6 }}>
            <Text style={{ fontFamily: fonts.bold, fontSize: 18, color: colors.ink }}>{run.recipient_name ?? 'Customer'}</Text>
            <Text style={s.body}>{addressLine(run.address)}</Text>
            {run.address?.landmark ? <Text style={s.muted}>Landmark: {run.address.landmark}</Text> : null}
            {run.note ? <Text style={[s.muted, { fontStyle: 'italic' }]}>“{run.note}”</Text> : null}
          </Card>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <Button style={{ flex: 1 }} variant="secondary" icon={Navigation} title="Map" onPress={() => void Linking.openURL(mapsUrl(run.address))} />
            {phone ? <Button style={{ flex: 1 }} variant="secondary" icon={Phone} title="Call" onPress={() => void Linking.openURL(`tel:${phone}`)} /> : null}
            {phone ? <IconButton icon={MessageCircle} label="WhatsApp the customer" size={56} onPress={() => void Linking.openURL(`https://wa.me/${phone.replace(/\D/g, '')}`)} /> : null}
          </View>
          <Card flat style={{ gap: 6 }}>
            <Text style={s.eyebrow}>Items</Text>
            {run.items.map((i, k) => <Text key={k} style={s.body}>{i.qty} {i.unit} · {i.name}{i.label ? ` (${i.label})` : ''}</Text>)}
          </Card>
          {run.collect_kobo > 0 && !done && (
            <View style={{ padding: 16, borderRadius: radius.lg, backgroundColor: colors.ink, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Text style={{ color: colors.onInk, fontFamily: fonts.bold, fontSize: 15 }}>Collect at the door</Text>
              <Text style={[s.money, { color: colors.gold, fontSize: 26 }]}>{formatNaira(run.collect_kobo)}</Text>
            </View>
          )}
          {run.status === 'packed' && <Button big icon={Bike} title="Start delivery" pending={busy} onPress={async () => { setBusy(true); await onAct(run, 'dispatched'); }} />}
          {run.status === 'dispatched' && <>
            <Button big icon={Camera} title="Delivered · take photo" onPress={async () => { if (!permission?.granted) await requestPermission(); setStep('camera'); }} />
            <Button icon={TriangleAlert} variant="soft" title="Couldn't deliver" onPress={() => setStep('failed')} />
          </>}
          {run.status === 'failed' && <Button big icon={RotateCcw} title="Try again" pending={busy} onPress={async () => { setBusy(true); await onAct(run, 'dispatched'); }} />}
        </>}

        {step === 'failed' && <>
          <Text style={s.label}>What happened?</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {(Object.keys(FAILURE_LABEL) as FailureReason[]).map((k) => <Chip key={k} label={FAILURE_LABEL[k]} selected={reason === k} onPress={() => setReason(k)} />)}
          </View>
          <Field label="Note for the shop (optional)" value={note} onChangeText={setNote} maxLength={300} placeholder="e.g. Gate locked, called twice" />
          <Button big variant="danger" icon={TriangleAlert} title="Report failed delivery" disabled={!reason} pending={busy}
            onPress={async () => { setBusy(true); await onAct(run, 'failed', { failure: reason!, note: note.trim() || undefined }); }} />
          <Button title="Back" variant="soft" onPress={() => setStep('menu')} />
        </>}

        {step === 'confirm' && photo && <>
          <Image source={{ uri: photo }} accessibilityLabel="Proof of delivery photo" style={{ width: '100%', aspectRatio: 4 / 3, borderRadius: radius.lg, backgroundColor: colors.lineSoft }} />
          <Field label="Received by" value={receivedBy} onChangeText={setReceivedBy} maxLength={80} placeholder="Name of the person who took it" />
          {run.collect_kobo > 0 && <Text style={{ fontFamily: fonts.bold, color: colors.goldInk, backgroundColor: colors.gold50, padding: 12, borderRadius: radius.md, overflow: 'hidden' }}>Make sure you collected {formatNaira(run.collect_kobo)}.</Text>}
          <Button big icon={CheckCircle2} title="Confirm delivered" pending={busy}
            onPress={async () => { setBusy(true); await onAct(run, 'delivered', { photoUri: photo, receivedBy: receivedBy.trim() || undefined }); }} />
          <Button title="Retake photo" variant="soft" icon={Camera} onPress={() => setStep('camera')} />
        </>}
      </Sheet>

      <Modal visible={step === 'camera'} animationType="slide" onRequestClose={() => setStep('menu')}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView ref={cam} style={{ flex: 1 }} facing="back" />
          <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: 40, alignItems: 'center', gap: 14 }}>
            <Text style={{ color: '#fff', fontFamily: fonts.bold, fontSize: 15 }}>Show the goods at the door</Text>
            <Press accessibilityRole="button" accessibilityLabel="Take photo" onPress={() => void snap()} scaleTo={0.9}
              style={{ width: 78, height: 78, borderRadius: 39, borderWidth: 5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ width: 58, height: 58, borderRadius: 29, backgroundColor: '#fff' }} />
            </Press>
          </View>
          <View style={{ position: 'absolute', top: 48, right: 16 }}><IconButton icon={X} label="Close camera" tone="onInk" onPress={() => setStep('menu')} /></View>
        </View>
      </Modal>
    </>
  );
}
