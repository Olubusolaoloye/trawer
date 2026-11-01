import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Linking, Modal, Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { formatNaira, nairaToKobo } from '@trawer/core/money';
import { PosError, receiptLines, whatsappReceiptLink, type PosCart, type PosCustomer, type PosEngine, type PosPaymentMethod, type PosSale, type PosVariant } from '@trawer/core/pos';
import { catalog, stateRepo } from '../engine';
import { hasPrinter, printReceipt } from '../printer';
import type { DeviceBinding } from '../session';
import { Button, Card, ErrorText, colors, s } from '../components/ui';

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

  return (
    <View style={{ flex: 1, gap: 10, padding: 12 }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }} style={{ flexGrow: 0 }}>
        {carts.map((c) => (
          <Pressable key={c.id} accessibilityRole="tab" accessibilityState={{ selected: c.id === activeId }} onPress={() => void refresh(c.id)}
            style={{ minHeight: 48, paddingHorizontal: 16, borderRadius: 24, justifyContent: 'center', backgroundColor: c.id === activeId ? colors.brand : '#fff', borderWidth: 2, borderColor: c.id === activeId ? colors.brand : colors.line }}>
            <Text style={{ fontWeight: '700', color: c.id === activeId ? '#fff' : colors.ink }}>{c.label} · {c.lines.reduce((n, l) => n + l.qty, 0)}</Text>
          </Pressable>
        ))}
        <Pressable accessibilityRole="button" accessibilityLabel="New cart" onPress={() => void act(async () => { const c = await engine.openCart(); setActiveId(c.id); })}
          style={{ minHeight: 48, paddingHorizontal: 16, borderRadius: 24, justifyContent: 'center', borderWidth: 2, borderStyle: 'dashed', borderColor: colors.line }}>
          <Text style={{ fontWeight: '700' }}>＋ New cart</Text>
        </Pressable>
      </ScrollView>

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <TextInput accessibilityLabel="Search products" placeholder="Search name or SKU" value={query} onChangeText={setQuery} style={[s.input, { flex: 1 }]} />
        <Button title="Scan" onPress={async () => { if (!permission?.granted) await requestPermission(); setScanning(true); }} />
      </View>

      {results.length > 0 && (
        <Card style={{ maxHeight: 220, padding: 0 }}>
          <FlatList data={results} keyExtractor={(v) => v.id} keyboardShouldPersistTaps="handled" renderItem={({ item }) => (
            <Pressable accessibilityRole="button" onPress={() => { setQuery(''); void act(() => engine.add(activeId!, item.id, null, 1)); }}
              style={{ minHeight: 52, paddingHorizontal: 14, justifyContent: 'center', borderBottomWidth: 1, borderColor: colors.line }}>
              <Text style={{ fontSize: 16, fontWeight: '600' }}>{item.name}{item.label ? ` · ${item.label}` : ''}</Text>
              <Text style={s.muted}>{item.sku}</Text>
            </Pressable>
          )} />
        </Card>
      )}

      <ErrorText error={error} />

      <FlatList style={{ flex: 1 }} data={priced?.lines ?? []} keyExtractor={(l) => `${l.variantId}:${l.unitId}`} contentContainerStyle={{ gap: 8 }}
        ListEmptyComponent={<Text style={[s.muted, { textAlign: 'center', marginTop: 30 }]}>Scan or search to add items</Text>}
        renderItem={({ item }) => (
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 16, fontWeight: '700' }}>{item.name}{item.label ? ` · ${item.label}` : ''}</Text>
              <Text style={s.muted}>{item.qty} {item.unitName} · {formatNaira(item.unitPriceKobo)}/pc</Text>
            </View>
            <Pressable accessibilityLabel="Remove one" onPress={() => void act(() => engine.add(activeId!, item.variantId, item.unitId, -1))} style={qtyBtn}><Text style={qtyTxt}>−</Text></Pressable>
            <Text style={{ fontSize: 18, fontWeight: '800', minWidth: 28, textAlign: 'center' }}>{item.qty}</Text>
            <Pressable accessibilityLabel="Add one" onPress={() => void act(() => engine.add(activeId!, item.variantId, item.unitId, 1))} style={qtyBtn}><Text style={qtyTxt}>＋</Text></Pressable>
            <Text style={{ fontSize: 16, fontWeight: '800', minWidth: 90, textAlign: 'right' }}>{formatNaira(item.unitPriceKobo * item.baseQty)}</Text>
          </Card>
        )} />

      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button variant="secondary" style={{ flex: 1 }} title={priced?.customerId ? 'Customer ✓' : 'Customer'} onPress={() => setPickCustomer(true)} />
        <Button variant="secondary" title="Discard" onPress={() => Alert.alert('Discard cart?', undefined, [{ text: 'Keep' }, { text: 'Discard', style: 'destructive', onPress: () => void act(() => engine.discardCart(activeId!)) }])} />
      </View>
      <Button title={`Charge ${formatNaira(priced?.totalKobo ?? 0)}`} disabled={!priced?.lines.length} onPress={() => setPaying(true)} />

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
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,.5)', justifyContent: 'flex-end' }}>
          <Card style={{ margin: 12, gap: 12 }}>
            <Text style={s.h1}>Sale complete</Text>
            {receipt && receipt.changeKobo > 0 && <Text style={{ fontSize: 22, fontWeight: '800', color: colors.good }}>Change: {formatNaira(receipt.changeKobo)}</Text>}
            <Button title="Print receipt" disabled={!hasPrinter()} onPress={() => receipt && void printReceipt(receiptLines(receipt, shop)).catch((e) => setError(message(e)))} />
            <Button title="Send on WhatsApp" variant="secondary" onPress={async () => {
              if (!receipt) return;
              const phone = receipt.customerId ? (await stateRepo.getCustomers()).find((c) => c.id === receipt.customerId)?.phone : undefined;
              void Linking.openURL(whatsappReceiptLink(phone ?? '', receiptLines(receipt, shop)));
            }} />
            <Button title="Done" variant="secondary" onPress={() => setReceipt(null)} />
          </Card>
        </View>
      </Modal>
    </View>
  );
}

const qtyBtn = { width: 44, height: 44, borderRadius: 12, borderWidth: 2, borderColor: colors.line, alignItems: 'center' as const, justifyContent: 'center' as const };
const qtyTxt = { fontSize: 22, fontWeight: '800' as const };

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
            <Text style={{ fontSize: 17, fontWeight: '700' }}>{item.name}</Text>
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
        <Text style={{ fontSize: 18, fontWeight: '700' }}>
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
