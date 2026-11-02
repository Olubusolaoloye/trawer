import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Animated, FlatList, Image, Linking, Modal, Platform, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ArrowLeftRight, ArrowRight, Banknote, Check, ChevronRight, CreditCard, Hash, MessageCircle, Minus, Plus, Printer, QrCode, ScanLine, Search, ShieldCheck, Trash2, UserRound, Wallet, WifiOff, X } from 'lucide-react-native';
import { formatNaira, nairaToKobo } from '@trawer/core/money';
import { PosError, receiptLines, whatsappReceiptLink, type PosCart, type PosCustomer, type PosEngine, type PosPaymentMethod, type PosSale, type PosVariant } from '@trawer/core/pos';
import { catalog, stateRepo } from '../engine';
import { hasPrinter, printReceipt } from '../printer';
import type { DeviceBinding } from '../session';
import { Button, Card, Chip, ErrorText, IconButton, Press, SearchBox, Sheet, Toggle, colors, fonts, radius, s, shadow, tap, type Icon } from '../components/ui';

type Priced = PosCart & { totalKobo: number };
const METHODS: { id: PosPaymentMethod; label: string; icon: Icon }[] = [
  { id: 'cash', label: 'Cash', icon: Banknote }, { id: 'card_terminal', label: 'Card', icon: CreditCard }, { id: 'transfer', label: 'Transfer', icon: ArrowLeftRight },
  { id: 'ussd', label: 'USSD', icon: Hash }, { id: 'qr', label: 'QR', icon: QrCode },
];

function message(e: unknown): string {
  if (e instanceof PosError) {
    if (e.code === 'not_allocated') return `${e.message}. Ask a manager to allocate more or approve an override.`;
    if (e.code === 'unknown_variant') return 'Product not found on this till. Sync and try again.';
    if (e.code === 'underpaid') return 'Payment is less than the total.';
    if (e.code === 'not_ready') return 'Connect to the internet once to download products and prices.';
  }
  return (e as Error).message;
}

/** Deterministic fabric-ish tile colour for products without a photo. */
const TILE = ['#1D4ED8', '#7F1D1D', '#CA8A04', '#047857', '#BE185D', '#23308C', '#9A3412', '#0E7490'];
function tileColour(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return TILE[Math.abs(h) % TILE.length]!;
}
function Thumb({ seed, name, image, size = 48 }: { seed: string; name: string; image?: string | null; size?: number }) {
  if (image) return <Image source={{ uri: image }} accessibilityIgnoresInvertColors style={{ width: size, height: size, borderRadius: 12, backgroundColor: colors.lineSoft }} />;
  return (
    <View style={{ width: size, height: size, borderRadius: 12, backgroundColor: tileColour(seed), alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
      <View style={{ position: 'absolute', width: size * 1.6, height: size * 0.28, backgroundColor: 'rgba(255,255,255,0.18)', transform: [{ rotate: '-30deg' }] }} />
      <Text style={{ color: '#fff', fontFamily: fonts.display, fontSize: size * 0.4 }}>{name.charAt(0)}</Text>
    </View>
  );
}

export function SellScreen({ engine, binding, shop }: { engine: PosEngine; binding: DeviceBinding; shop: { name: string; address?: string | null; phone?: string | null } }) {
  const [carts, setCarts] = useState<PosCart[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [priced, setPriced] = useState<Priced | null>(null);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<PosVariant[]>([]);
  const [scanning, setScanning] = useState(false);
  const [paying, setPaying] = useState(false);
  const [pickCustomer, setPickCustomer] = useState(false);
  const [receipt, setReceipt] = useState<PosSale | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [permission, requestPermission] = useCameraPermissions();
  const canOverride = binding.role === 'owner' || binding.role === 'manager';
  const wide = useWindowDimensions().width >= 900;
  const [customers, setCustomers] = useState<PosCustomer[]>([]);
  useEffect(() => { void stateRepo.getCustomers().then(setCustomers); }, [pickCustomer]);

  const refresh = useCallback(async (focus?: string) => {
    let list = await engine.carts();
    if (list.length === 0) list = [await engine.openCart()];
    setCarts(list);
    const id = focus && list.some((c) => c.id === focus) ? focus : activeId && list.some((c) => c.id === activeId) ? activeId : list[0]!.id;
    setActiveId(id);
    try { setPriced(await engine.priced(id)); setError(null); } catch (e) { setError(message(e)); }
  }, [engine, activeId]);

  useEffect(() => { void refresh(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const t = setTimeout(() => { if (query.trim().length >= 2) void catalog.search(query.trim(), 20).then(setResults); else setResults([]); }, 150);
    return () => clearTimeout(t);
  }, [query]);

  const act = async (fn: () => Promise<unknown>) => {
    try { await fn(); await refresh(); } catch (e) { tap('warning'); setError(message(e)); }
  };

  const onScan = async (code: string) => {
    setScanning(false);
    tap('success');
    await act(() => engine.scan(activeId!, code));
  };

  const customer = priced?.customerId ? customers.find((c) => c.id === priced.customerId) : undefined;
  const items = priced?.lines.reduce((n, l) => n + l.qty, 0) ?? 0;

  const lineList = (
    <FlatList style={{ flex: 1 }} data={priced?.lines ?? []} keyExtractor={(l) => `${l.variantId}:${l.unitId}`} contentContainerStyle={{ gap: 8, paddingBottom: 8, flexGrow: 1 }}
      ListEmptyComponent={wide ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 6, paddingVertical: 28 }}>
          <Text style={s.h2}>Cart is empty</Text>
          <Text style={[s.muted, { textAlign: 'center' }]}>Items you scan or pick show here</Text>
        </View>
      ) :
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 28 }}>
          <View style={{ width: 72, height: 72, borderRadius: 36, backgroundColor: colors.green50, alignItems: 'center', justifyContent: 'center' }}><ScanLine size={34} color={colors.green} strokeWidth={2.2} /></View>
          <Text style={[s.h2, { textAlign: 'center' }]}>Ready for the next sale</Text>
          <Text style={[s.muted, { textAlign: 'center' }]}>Scan a barcode or search to add items</Text>
        </View>
      }
      renderItem={({ item }) => (
        <View style={{ flexDirection: 'row', gap: 12, padding: 10, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(228,222,210,0.7)' }}>
          <Thumb seed={item.variantId} name={item.name} size={48} />
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={{ fontSize: 15, fontFamily: fonts.bold, color: colors.ink }} numberOfLines={2}>{item.name}{item.label ? <Text style={{ color: colors.muted, fontFamily: fonts.semi }}> · {item.label}</Text> : null}</Text>
            <Text style={[s.muted, { fontSize: 13 }]} numberOfLines={1}>{item.qty} {item.unitName} · {formatNaira(item.unitPriceKobo)} each</Text>
          </View>
          <View style={{ alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
            <Text style={[s.money, { fontSize: 17 }]}>{formatNaira(item.unitPriceKobo * item.baseQty)}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', borderRadius: 999, backgroundColor: colors.lineSoft }}>
              <Press accessibilityRole="button" accessibilityLabel={`Remove one ${item.name}`} onPress={() => void act(() => engine.add(activeId!, item.variantId, item.unitId, -1))} style={qtyBtn} scaleTo={0.85}>
                {item.qty === 1 ? <Trash2 size={17} color={colors.redInk} /> : <Minus size={18} color={colors.ink} strokeWidth={2.8} />}
              </Press>
              <Text style={{ fontSize: 16, fontFamily: fonts.black, minWidth: 24, textAlign: 'center', color: colors.ink }}>{item.qty}</Text>
              <Press accessibilityRole="button" accessibilityLabel={`Add one ${item.name}`} onPress={() => void act(() => engine.add(activeId!, item.variantId, item.unitId, 1))} style={qtyBtn} scaleTo={0.85}>
                <Plus size={18} color={colors.ink} strokeWidth={2.8} />
              </Press>
            </View>
          </View>
        </View>
      )} />
  );

  const left = (
    <View style={{ flex: 1, gap: 12 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingRight: 8 }} style={{ flexGrow: 0 }}>
        {carts.map((c) => (
          <Chip key={c.id} selected={c.id === activeId} onPress={() => void refresh(c.id)} label={c.label} count={c.lines.reduce((n, l) => n + l.qty, 0)} />
        ))}
        <Chip dashed icon={Plus} label="New cart" onPress={() => void act(async () => { const c = await engine.openCart(); setActiveId(c.id); })} />
      </ScrollView>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <SearchBox icon={Search} accessibilityLabel="Search products" placeholder="Search name, SKU or colour" value={query} onChangeText={setQuery} style={{ flex: 1 }} />
        <IconButton icon={ScanLine} label="Scan barcode" tone="ink" size={54} onPress={async () => { if (!permission?.granted) await requestPermission(); setScanning(true); }} />
      </View>

      {results.length > 0 ? (
        <FlatList data={results} keyExtractor={(v) => v.id} keyboardShouldPersistTaps="handled" numColumns={wide ? 2 : 1} key={wide ? 'grid' : 'list'}
          columnWrapperStyle={wide ? { gap: 10 } : undefined} contentContainerStyle={{ gap: 10 }} renderItem={({ item }) => (
          <Press accessibilityRole="button" accessibilityLabel={`Add ${item.name}${item.label ? ` ${item.label}` : ''}`} onPress={() => { setQuery(''); void act(() => engine.add(activeId!, item.id, null, 1)); }}
            style={[{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 12, padding: 10, borderRadius: radius.lg, backgroundColor: colors.surface, borderWidth: 1, borderColor: 'rgba(228,222,210,0.7)' }, shadow.card]}>
            <Thumb seed={item.id} name={item.name} image={item.image} size={52} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontFamily: fonts.bold, color: colors.ink }} numberOfLines={1}>{item.name}</Text>
              <Text style={[s.muted, { fontSize: 13 }]} numberOfLines={1}>{item.label ? `${item.label} · ` : ''}{item.sku}</Text>
            </View>
            <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' }}><Plus size={20} color="#fff" strokeWidth={2.8} /></View>
          </Press>
        )} />
      ) : wide ? (
        <>
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
          <View style={{ width: 96, height: 96, borderRadius: 48, backgroundColor: colors.green50, alignItems: 'center', justifyContent: 'center' }}><ScanLine size={44} color={colors.green} strokeWidth={2} /></View>
          <Text style={[s.h1, { textAlign: 'center' }]}>Scan or search to sell</Text>
          <Text style={[s.muted, { textAlign: 'center', maxWidth: 420 }]}>Point the camera at a barcode, or type a product name, SKU or colour above. Items appear in the cart on the right.</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 12, padding: 16, borderRadius: radius.lg, backgroundColor: colors.indigo50, alignItems: 'center' }}>
          <View style={{ width: 40, height: 40, borderRadius: 12, backgroundColor: colors.indigo, alignItems: 'center', justifyContent: 'center' }}><WifiOff size={20} color="#fff" /></View>
          <Text style={{ flex: 1, color: colors.indigo, fontFamily: fonts.semi, fontSize: 15, lineHeight: 21 }}>Offline? Keep selling. This till holds its own stock, and sales send themselves when the network is back.</Text>
        </View>
        </>
      ) : null}
      <ErrorText error={error} />
      {!wide && lineList}
    </View>
  );

  const right = (
    <View style={wide ? [{ width: 440, backgroundColor: colors.surface, borderLeftWidth: 1, borderColor: 'rgba(228,222,210,0.7)', padding: 16, gap: 12 }] : { gap: 10 }}>
      <Press accessibilityRole="button" accessibilityLabel={customer ? `Customer ${customer.name}. Change` : 'Walk-in customer. Pick a customer'} onPress={() => setPickCustomer(true)} scaleTo={0.98}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderRadius: radius.lg, backgroundColor: customer ? colors.indigo50 : colors.lineSoft }}>
        <View style={{ width: 42, height: 42, borderRadius: 21, backgroundColor: customer ? colors.indigo : colors.surface, alignItems: 'center', justifyContent: 'center' }}>
          {customer ? <Text style={{ color: '#fff', fontFamily: fonts.black }}>{customer.name.slice(0, 2).toUpperCase()}</Text> : <UserRound size={20} color={colors.body} />}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.ink }}>{customer?.name ?? 'Walk-in customer'}</Text>
          <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: customer?.tier ? colors.indigo : colors.muted }}>{customer?.tier ? `${customer.tier} price applied` : 'Tap to pick a customer'}</Text>
        </View>
        <ChevronRight size={20} color={colors.muted} />
      </Press>
      {wide && lineList}
      <View style={{ gap: 2, paddingTop: 4 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <View>
            <Text style={s.eyebrow}>Total</Text>
            <Text style={[s.muted, { fontSize: 13 }]}>{items} item{items === 1 ? '' : 's'}</Text>
          </View>
          <Text accessibilityLiveRegion="polite" style={[s.money, { fontSize: wide ? 40 : 34 }]}>{formatNaira(priced?.totalKobo ?? 0)}</Text>
        </View>
      </View>
      <View style={{ flexDirection: 'row', gap: 10 }}>
        <IconButton icon={Trash2} label="Discard cart" size={66} onPress={() => Alert.alert('Discard cart?', undefined, [{ text: 'Keep' }, { text: 'Discard', style: 'destructive', onPress: () => void act(() => engine.discardCart(activeId!)) }])} />
        <Button big style={{ flex: 1 }} icon={Wallet} title={`Charge ${formatNaira(priced?.totalKobo ?? 0)}`} disabled={!priced?.lines.length} onPress={() => setPaying(true)} />
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {wide ? (
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ flex: 1, padding: 16 }}>{left}</View>
          {right}
        </View>
      ) : (
        <View style={{ flex: 1, padding: 12, gap: 12 }}>{left}{right}</View>
      )}

      <Modal visible={scanning} animationType="slide" onRequestClose={() => setScanning(false)}>
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'qr'] }}
            onBarcodeScanned={({ data }) => void onScan(data)} />
          {/* Aim frame */}
          <View pointerEvents="none" style={{ position: 'absolute', inset: 0, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 280, height: 170, borderRadius: 24, borderWidth: 3, borderColor: colors.gold }} />
            <Text style={{ marginTop: 16, color: '#fff', fontFamily: fonts.bold, fontSize: 16 }}>Point at the barcode</Text>
          </View>
          <View style={{ position: 'absolute', top: 48, right: 16 }}><IconButton icon={X} label="Close scanner" tone="onInk" onPress={() => setScanning(false)} /></View>
        </View>
      </Modal>

      <CustomerPicker visible={pickCustomer} onClose={() => setPickCustomer(false)} onPick={(c) => { setPickCustomer(false); void act(() => engine.setCustomer(activeId!, c?.id ?? null)); }} />

      {priced && (
        <PayModal visible={paying} total={priced.totalKobo} canOverride={canOverride} onClose={() => setPaying(false)} onPay={async (payments, opts) => {
          try {
            const sale = await engine.checkout(priced.id, payments, { ...opts, overrideBy: opts.override ? binding.staffId : undefined });
            setPaying(false);
            tap('success');
            setReceipt(sale);
            await refresh();
            void engine.sync().catch(() => undefined); // push right away when online
          } catch (e) { tap('warning'); setError(message(e)); setPaying(false); }
        }} />
      )}

      <Sheet visible={!!receipt} onClose={() => setReceipt(null)}>
        <SuccessMark />
        <Text accessibilityRole="header" style={[s.h1, { textAlign: 'center' }]}>Sale complete</Text>
        {receipt && <Text style={[s.money, { fontSize: 40, textAlign: 'center' }]}>{formatNaira(receipt.totalKobo)}</Text>}
        {receipt && receipt.changeKobo > 0 && (
          <View accessibilityLiveRegion="assertive" style={{ padding: 16, borderRadius: radius.lg, backgroundColor: colors.green50, alignItems: 'center', gap: 2 }}>
            <Text style={[s.eyebrow, { color: colors.greenInk }]}>Give change</Text>
            <Text style={[s.money, { fontSize: 34, color: colors.greenInk }]}>{formatNaira(receipt.changeKobo)}</Text>
          </View>
        )}
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button style={{ flex: 1 }} icon={Printer} title="Print" variant="secondary" disabled={!hasPrinter()} onPress={() => receipt && void printReceipt(receiptLines(receipt, shop)).catch((e) => setError(message(e)))} />
          <Button style={{ flex: 1 }} icon={MessageCircle} title="WhatsApp" variant="secondary" onPress={async () => {
            if (!receipt) return;
            const phone = receipt.customerId ? customers.find((c) => c.id === receipt.customerId)?.phone : undefined;
            void Linking.openURL(whatsappReceiptLink(phone ?? '', receiptLines(receipt, shop)));
          }} />
        </View>
        <Button big icon={ArrowRight} title="Next customer" onPress={() => setReceipt(null)} />
      </Sheet>
    </View>
  );
}

function SuccessMark() {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => { Animated.spring(v, { toValue: 1, useNativeDriver: Platform.OS !== 'web', speed: 10, bounciness: 12 }).start(); }, [v]);
  return (
    <Animated.View style={{ alignSelf: 'center', width: 84, height: 84, borderRadius: 42, backgroundColor: colors.green50, alignItems: 'center', justifyContent: 'center', transform: [{ scale: v }] }}>
      <View style={[{ width: 60, height: 60, borderRadius: 30, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' }, shadow.green]}>
        <Check size={34} color="#fff" strokeWidth={3.2} />
      </View>
    </Animated.View>
  );
}

const qtyBtn = { width: 42, height: 42, alignItems: 'center' as const, justifyContent: 'center' as const };

function CustomerPicker({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (c: PosCustomer | null) => void }) {
  const [all, setAll] = useState<PosCustomer[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => { if (visible) void stateRepo.getCustomers().then(setAll); }, [visible]);
  const list = all.filter((c) => `${c.name} ${c.phone}`.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  return (
    <Sheet visible={visible} onClose={onClose} title="Customer">
      <SearchBox icon={Search} accessibilityLabel="Search customers" placeholder="Name or phone" value={q} onChangeText={setQ} />
      <Card flat style={{ padding: 0, overflow: 'hidden' }}>
        <Press accessibilityRole="button" accessibilityLabel="Walk-in, no customer" onPress={() => onPick(null)} scaleTo={0.985}
          style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 60, paddingHorizontal: 14 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: colors.lineSoft, alignItems: 'center', justifyContent: 'center' }}><UserRound size={20} color={colors.body} /></View>
          <Text style={{ flex: 1, fontSize: 16, fontFamily: fonts.bold, color: colors.ink }}>Walk-in (no customer)</Text>
        </Press>
        {list.map((item) => (
          <Press key={item.id} accessibilityRole="button" accessibilityLabel={`${item.name}${item.tier ? `, ${item.tier}` : ''}`} onPress={() => onPick(item)} scaleTo={0.985}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 14, borderTopWidth: 1, borderColor: colors.lineSoft }}>
            <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: item.tier ? colors.indigo : colors.ink2, alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ color: '#fff', fontFamily: fonts.black, fontSize: 13 }}>{item.name.slice(0, 2).toUpperCase()}</Text>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontFamily: fonts.bold, color: colors.ink }}>{item.name}</Text>
              <Text style={[s.muted, { fontSize: 13 }]}>{item.phone}</Text>
            </View>
            {item.tier && <View style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, backgroundColor: colors.indigo }}><Text style={{ color: '#fff', fontFamily: fonts.black, fontSize: 11 }}>{item.tier.toUpperCase()}</Text></View>}
          </Press>
        ))}
      </Card>
      <Button title="Close" variant="soft" onPress={onClose} />
    </Sheet>
  );
}

function PayModal({ visible, total, canOverride, onClose, onPay }: {
  visible: boolean; total: number; canOverride: boolean; onClose: () => void;
  onPay: (p: { method: PosPaymentMethod; amountKobo: number }[], o: { credit: boolean; override: boolean }) => Promise<void>;
}) {
  const [amounts, setAmounts] = useState<Partial<Record<PosPaymentMethod, string>>>({});
  const [active, setActive] = useState<PosPaymentMethod[]>(['cash']);
  const [credit, setCredit] = useState(false);
  const [override, setOverride] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => { if (visible) { setAmounts({ cash: String(total / 100) }); setActive(['cash']); setCredit(false); setOverride(false); } }, [visible, total]);
  const payments = active.map((m) => ({ method: m, amountKobo: amounts[m] ? nairaToKobo(amounts[m]!) : 0 })).filter((p) => p.amountKobo > 0);
  const paid = payments.reduce((n, p) => n + p.amountKobo, 0);
  const toggle = (m: PosPaymentMethod) => {
    if (active.includes(m)) { if (active.length > 1) setActive(active.filter((x) => x !== m)); return; }
    const remaining = Math.max(total - paid, 0);
    setActive([...active, m]);
    setAmounts({ ...amounts, [m]: remaining ? String(remaining / 100) : '' });
  };
  // Quick cash: exact, then the next round notes a customer is likely to hand over.
  const naira = total / 100;
  const quick = [...new Set([naira, Math.ceil(naira / 1000) * 1000, Math.ceil(naira / 5000) * 5000, Math.ceil(naira / 10000) * 10000])].slice(0, 4);
  return (
    <Sheet visible={visible} onClose={onClose} title={`Charge ${formatNaira(total)}`} wide>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {METHODS.map((m) => {
          const on = active.includes(m.id);
          return (
            <Press key={m.id} accessibilityRole="checkbox" accessibilityState={{ checked: on }} accessibilityLabel={m.label} onPress={() => toggle(m.id)}
              style={[{ flexGrow: 1, flexBasis: '30%', minHeight: 64, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', gap: 4,
                backgroundColor: on ? colors.ink : colors.surface, borderWidth: on ? 0 : 1.5, borderColor: colors.line }, on ? shadow.lift : {}]}>
              <m.icon size={22} color={on ? colors.gold : colors.ink} strokeWidth={2.3} />
              <Text style={{ fontFamily: fonts.black, fontSize: 14, color: on ? colors.paper : colors.ink }}>{m.label}</Text>
            </Press>
          );
        })}
      </View>

      {active.map((id) => {
        const m = METHODS.find((x) => x.id === id)!;
        return (
          <View key={id} style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Text style={[s.label, { width: 92 }]}>{m.label}</Text>
              <View style={[s.input, { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }]}>
                <Text style={{ fontFamily: fonts.black, fontSize: 18, color: colors.muted }}>₦</Text>
                <TextInput accessibilityLabel={`${m.label} amount`} keyboardType="decimal-pad" value={amounts[id] ?? ''} placeholder="0" placeholderTextColor={colors.muted}
                  onChangeText={(t) => setAmounts({ ...amounts, [id]: t.replace(/[^\d.]/g, '') })}
                  style={{ flex: 1, minHeight: 50, fontSize: 20, fontFamily: fonts.black, color: colors.ink, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } as object : {}) }} />
              </View>
            </View>
            {id === 'cash' && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingLeft: 102 }}>
                {quick.map((q, i) => (
                  <Chip key={q} label={i === 0 ? 'Exact' : formatNaira(q * 100)} selected={amounts.cash === String(q)} onPress={() => setAmounts({ ...amounts, cash: String(q) })} />
                ))}
              </ScrollView>
            )}
          </View>
        );
      })}

      <View accessibilityLiveRegion="polite" style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderRadius: radius.lg, backgroundColor: paid >= total ? colors.green50 : colors.gold50 }}>
        <Text style={{ fontFamily: fonts.black, fontSize: 16, color: paid >= total ? colors.greenInk : colors.goldInk }}>{paid >= total ? 'Change to give' : 'Still to pay'}</Text>
        <Text style={[s.money, { fontSize: 30, color: paid >= total ? colors.greenInk : colors.goldInk }]}>{formatNaira(Math.abs(paid - total))}</Text>
      </View>

      {(paid < total || canOverride) && (
        <Card flat style={{ paddingVertical: 2 }}>
          {paid < total && <Toggle icon={Wallet} label="Sell on credit" hint="The balance goes to the debtors' book" value={credit} onChange={setCredit} />}
          {canOverride && <Toggle icon={ShieldCheck} label="Manager override" hint="Sell beyond this till's allocation" value={override} onChange={setOverride} />}
        </Card>
      )}

      <Button big icon={Check} title="Complete sale" pending={pending} disabled={paid < total && !credit} onPress={async () => { setPending(true); await onPay(payments, { credit, override }); setPending(false); }} />
      <Button title="Back" variant="soft" onPress={onClose} />
    </Sheet>
  );
}
