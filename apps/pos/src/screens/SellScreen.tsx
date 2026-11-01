import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Linking, Modal, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { formatNaira, nairaToKobo } from '@trawer/core/money';
import { PosError, receiptLines, whatsappReceiptLink, type PosCart, type PosCustomer, type PosEngine, type PosPaymentMethod, type PosSale, type PosVariant } from '@trawer/core/pos';
import { catalog, stateRepo } from '../engine';
import { hasPrinter, printReceipt } from '../printer';
import type { DeviceBinding } from '../session';
import { Button, Card, Chip, ErrorText, colors, fonts, s } from '../components/ui';

type Priced = PosCart & { totalKobo: number };
const METHODS: { id: PosPaymentMethod; label: string }[] = [
  { id: 'cash', label: 'Cash' }, { id: 'card_terminal', label: 'Card' }, { id: 'transfer', label: 'Transfer' }, { id: 'ussd', label: 'USSD' }, { id: 'qr', label: 'QR' },
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
    try { await fn(); await refresh(); } catch (e) { setError(message(e)); }
  };

  const onScan = async (code: string) => {
    setScanning(false);
    await act(() => engine.scan(activeId!, code));
  };

  const customer = priced?.customerId ? customers.find((c) => c.id === priced.customerId) : undefined;
  const lineList = (
    <FlatList style={{ flex: 1 }} data={priced?.lines ?? []} keyExtractor={(l) => `${l.variantId}:${l.unitId}`} contentContainerStyle={{ gap: 10 }}
      ListEmptyComponent={<Text style={[s.muted, { textAlign: 'center', marginTop: 30 }]}>Scan or search to add items</Text>}
      renderItem={({ item }) => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 16, fontFamily: fonts.bold, color: colors.ink }}>{item.name}{item.label ? ` · ${item.label}` : ''}</Text>
            <Text style={s.muted}>{item.qty} {item.unitName} · {formatNaira(item.unitPriceKobo)} each</Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 2, borderColor: colors.line, borderRadius: 12 }}>
            <Pressable accessibilityLabel="Remove one" onPress={() => void act(() => engine.add(activeId!, item.variantId, item.unitId, -1))} style={qtyBtn}><Text style={qtyTxt}>−</Text></Pressable>
            <Text style={{ fontSize: 17, fontFamily: fonts.black, minWidth: 26, textAlign: 'center' }}>{item.qty}</Text>
            <Pressable accessibilityLabel="Add one" onPress={() => void act(() => engine.add(activeId!, item.variantId, item.unitId, 1))} style={qtyBtn}><Text style={qtyTxt}>+</Text></Pressable>
          </View>
          <Text style={[s.money, { fontSize: 16, minWidth: 96, textAlign: 'right' }]}>{formatNaira(item.unitPriceKobo * item.baseQty)}</Text>
        </View>
      )} />
  );

  const left = (
    <View style={{ flex: 1, gap: 12 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} style={{ flexGrow: 0 }}>
        {carts.map((c) => (
          <Chip key={c.id} selected={c.id === activeId} onPress={() => void refresh(c.id)} label={`${c.label} · ${c.lines.reduce((n, l) => n + l.qty, 0)}`} />
        ))}
        <Chip dashed label="+ New cart" onPress={() => void act(async () => { const c = await engine.openCart(); setActiveId(c.id); })} />
      </ScrollView>

      <View style={{ flexDirection: 'row', gap: 10 }}>
        <TextInput accessibilityLabel="Search products" placeholder="Search by name, SKU or colour" placeholderTextColor={colors.muted} value={query} onChangeText={setQuery} style={[s.input, { flex: 1 }]} />
        <Button title="Scan" variant="ink" onPress={async () => { if (!permission?.granted) await requestPermission(); setScanning(true); }} />
      </View>

      {results.length > 0 ? (
        <FlatList data={results} keyExtractor={(v) => v.id} keyboardShouldPersistTaps="handled" numColumns={wide ? 3 : 1} key={wide ? 'grid' : 'list'}
          columnWrapperStyle={wide ? { gap: 12 } : undefined} contentContainerStyle={{ gap: 12 }} renderItem={({ item }) => (
          <Pressable accessibilityRole="button" onPress={() => { setQuery(''); void act(() => engine.add(activeId!, item.id, null, 1)); }}
            style={{ flex: 1, minHeight: 64, padding: 14, borderRadius: 18, borderWidth: 2, borderColor: colors.line, backgroundColor: '#fff', justifyContent: 'center' }}>
            <Text style={{ fontSize: 16, fontFamily: fonts.bold, color: colors.ink }}>{item.name}{item.label ? ` · ${item.label}` : ''}</Text>
            <Text style={s.muted}>{item.sku}</Text>
          </Pressable>
        )} />
      ) : wide ? (
        <View style={{ marginTop: 'auto', padding: 16, borderRadius: 16, backgroundColor: colors.indigo50 }}>
          <Text style={{ color: colors.indigo, fontFamily: fonts.semi, fontSize: 15, lineHeight: 22 }}>Offline? Keep selling. This till holds its own stock, and sales send themselves when the network is back.</Text>
        </View>
      ) : null}
      <ErrorText error={error} />
      {!wide && lineList}
    </View>
  );

  const right = (
    <View style={wide ? { width: 430, backgroundColor: '#fff', borderLeftWidth: 1, borderColor: colors.line, padding: 16, gap: 12 } : { gap: 10 }}>
      <Pressable accessibilityRole="button" onPress={() => setPickCustomer(true)}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 14, backgroundColor: customer ? colors.indigo50 : colors.lineSoft }}>
        <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: customer ? colors.indigo : colors.muted, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: '#fff', fontFamily: fonts.black }}>{customer ? customer.name.slice(0, 2).toUpperCase() : 'WI'}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: fonts.bold, fontSize: 16, color: colors.ink }}>{customer?.name ?? 'Walk-in customer'}</Text>
          <Text style={{ fontFamily: fonts.bold, fontSize: 13, color: customer?.tier ? colors.indigo : colors.muted }}>{customer?.tier ? `${customer.tier} price applied` : 'Tap to pick a customer'}</Text>
        </View>
      </Pressable>
      {wide && lineList}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', borderTopWidth: 2, borderColor: colors.ink, paddingTop: 12 }}>
        <Text style={{ fontFamily: fonts.bold, fontSize: 16 }}>Total</Text>
        <Text style={[s.money, { fontSize: 34 }]}>{formatNaira(priced?.totalKobo ?? 0)}</Text>
      </View>
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button title="Discard" variant="secondary" onPress={() => Alert.alert('Discard cart?', undefined, [{ text: 'Keep' }, { text: 'Discard', style: 'destructive', onPress: () => void act(() => engine.discardCart(activeId!)) }])} />
        <Button big style={{ flex: 1 }} title={`Charge ${formatNaira(priced?.totalKobo ?? 0)}`} disabled={!priced?.lines.length} onPress={() => setPaying(true)} />
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
        <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'qr'] }}
          onBarcodeScanned={({ data }) => void onScan(data)} />
        <Button title="Close" variant="secondary" style={{ margin: 16 }} onPress={() => setScanning(false)} />
      </Modal>

      <CustomerPicker visible={pickCustomer} onClose={() => setPickCustomer(false)} onPick={(c) => { setPickCustomer(false); void act(() => engine.setCustomer(activeId!, c?.id ?? null)); }} />

      {priced && (
        <PayModal visible={paying} total={priced.totalKobo} canOverride={canOverride} onClose={() => setPaying(false)} onPay={async (payments, opts) => {
          try {
            const sale = await engine.checkout(priced.id, payments, { ...opts, overrideBy: opts.override ? binding.staffId : undefined });
            setPaying(false);
            setReceipt(sale);
            await refresh();
            void engine.sync().catch(() => undefined); // push right away when online
          } catch (e) { setError(message(e)); setPaying(false); }
        }} />
      )}

      <Modal visible={!!receipt} transparent animationType="fade" onRequestClose={() => setReceipt(null)}>
        <View style={{ flex: 1, backgroundColor: 'rgba(14,20,17,.55)', justifyContent: 'center', padding: 16 }}>
          <Card style={{ gap: 12, maxWidth: 480, width: '100%', alignSelf: 'center', padding: 20 }}>
            <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: colors.green, alignItems: 'center', justifyContent: 'center' }}><Text style={{ color: '#fff', fontSize: 28, fontFamily: fonts.black }}>✓</Text></View>
            <Text style={s.h1}>Sale complete</Text>
            {receipt && <Text style={[s.money, { fontSize: 30 }]}>{formatNaira(receipt.totalKobo)}</Text>}
            {receipt && receipt.changeKobo > 0 && <Text style={{ fontSize: 22, fontFamily: fonts.black, color: colors.greenInk, backgroundColor: colors.green50, padding: 12, borderRadius: 12 }}>Give change: {formatNaira(receipt.changeKobo)}</Text>}
            <Button title="Print receipt" variant="ink" disabled={!hasPrinter()} onPress={() => receipt && void printReceipt(receiptLines(receipt, shop)).catch((e) => setError(message(e)))} />
            <Button title="Send on WhatsApp" variant="secondary" onPress={async () => {
              if (!receipt) return;
              const phone = receipt.customerId ? customers.find((c) => c.id === receipt.customerId)?.phone : undefined;
              void Linking.openURL(whatsappReceiptLink(phone ?? '', receiptLines(receipt, shop)));
            }} />
            <Button title="Next customer" onPress={() => setReceipt(null)} />
          </Card>
        </View>
      </Modal>
    </View>
  );
}

const qtyBtn = { width: 44, height: 44, alignItems: 'center' as const, justifyContent: 'center' as const };
const qtyTxt = { fontSize: 22, fontFamily: fonts.black, color: colors.ink };

function CustomerPicker({ visible, onClose, onPick }: { visible: boolean; onClose: () => void; onPick: (c: PosCustomer | null) => void }) {
  const [all, setAll] = useState<PosCustomer[]>([]);
  const [q, setQ] = useState('');
  useEffect(() => { if (visible) void stateRepo.getCustomers().then(setAll); }, [visible]);
  const list = all.filter((c) => `${c.name} ${c.phone}`.toLowerCase().includes(q.toLowerCase())).slice(0, 50);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, padding: 16, gap: 10 }}>
        <Text style={s.h1}>Customer</Text>
        <TextInput accessibilityLabel="Search customers" placeholder="Name or phone" value={q} onChangeText={setQ} style={s.input} autoFocus />
        <FlatList data={list} keyExtractor={(c) => c.id} renderItem={({ item }) => (
          <Pressable accessibilityRole="button" onPress={() => onPick(item)} style={{ minHeight: 56, justifyContent: 'center', borderBottomWidth: 1, borderColor: colors.line }}>
            <Text style={{ fontSize: 17, fontFamily: fonts.black }}>{item.name}</Text>
            <Text style={s.muted}>{item.phone}{item.tier ? ` · ${item.tier}` : ''}</Text>
          </Pressable>
        )} />
        <Button title="Walk-in (no customer)" variant="secondary" onPress={() => onPick(null)} />
        <Button title="Close" variant="secondary" onPress={onClose} />
      </View>
    </Modal>
  );
}

function PayModal({ visible, total, canOverride, onClose, onPay }: {
  visible: boolean; total: number; canOverride: boolean; onClose: () => void;
  onPay: (p: { method: PosPaymentMethod; amountKobo: number }[], o: { credit: boolean; override: boolean }) => Promise<void>;
}) {
  const [amounts, setAmounts] = useState<Partial<Record<PosPaymentMethod, string>>>({});
  const [credit, setCredit] = useState(false);
  const [override, setOverride] = useState(false);
  const [pending, setPending] = useState(false);
  useEffect(() => { if (visible) { setAmounts({ cash: String(total / 100) }); setCredit(false); setOverride(false); } }, [visible, total]);
  const payments = METHODS.map((m) => ({ method: m.id, amountKobo: amounts[m.id] ? nairaToKobo(amounts[m.id]!) : 0 })).filter((p) => p.amountKobo > 0);
  const paid = payments.reduce((n, p) => n + p.amountKobo, 0);
  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
        <Text style={s.h1}>Charge {formatNaira(total)}</Text>
        {METHODS.map((m) => (
          <View key={m.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={[s.label, { width: 90 }]}>{m.label}</Text>
            <TextInput accessibilityLabel={`${m.label} amount`} keyboardType="decimal-pad" value={amounts[m.id] ?? ''} placeholder="0"
              onChangeText={(t) => setAmounts({ ...amounts, [m.id]: t })} style={[s.input, { flex: 1 }]} />
          </View>
        ))}
        <Text style={{ fontSize: 18, fontFamily: fonts.black }}>
          {paid >= total ? `Change: ${formatNaira(paid - total)}` : `Short: ${formatNaira(total - paid)}`}
        </Text>
        {paid < total && (
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: credit }} onPress={() => setCredit(!credit)} style={{ minHeight: 48, justifyContent: 'center' }}>
            <Text style={{ fontSize: 16 }}>{credit ? '☑' : '☐'} Sell on credit (balance goes to the debtors' book)</Text>
          </Pressable>
        )}
        {canOverride && (
          <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: override }} onPress={() => setOverride(!override)} style={{ minHeight: 48, justifyContent: 'center' }}>
            <Text style={{ fontSize: 16 }}>{override ? '☑' : '☐'} Manager override: sell beyond this till's allocation</Text>
          </Pressable>
        )}
        <Button title="Complete sale" pending={pending} disabled={paid < total && !credit} onPress={async () => { setPending(true); await onPay(payments, { credit, override }); setPending(false); }} />
        <Button title="Back" variant="secondary" onPress={onClose} />
      </ScrollView>
    </Modal>
  );
}
