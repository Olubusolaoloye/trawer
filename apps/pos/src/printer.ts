/**
 * Bluetooth (BLE) thermal printer. Most 58mm printers expose a writable characteristic; we find
 * the first one and stream ESC/POS bytes in 180-byte chunks.
 */
import { BleManager, type Device } from 'react-native-ble-plx';
import { escposReceipt } from '@trawer/core/pos';

const manager = new BleManager();
let printer: Device | null = null;
let target: { service: string; characteristic: string } | null = null;

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return globalThis.btoa(s);
}

export function scanPrinters(onFound: (d: { id: string; name: string }) => void, ms = 8000): () => void {
  const seen = new Set<string>();
  manager.startDeviceScan(null, null, (err, d) => {
    if (err || !d || seen.has(d.id)) return;
    seen.add(d.id);
    onFound({ id: d.id, name: d.name ?? d.localName ?? d.id });
  });
  const t = setTimeout(() => manager.stopDeviceScan(), ms);
  return () => { clearTimeout(t); manager.stopDeviceScan(); };
}

export async function connectPrinter(id: string): Promise<void> {
  manager.stopDeviceScan();
  const d = await (await manager.connectToDevice(id)).discoverAllServicesAndCharacteristics();
  for (const s of await d.services()) {
    for (const c of await s.characteristics()) {
      if (c.isWritableWithoutResponse || c.isWritableWithResponse) {
        printer = d;
        target = { service: s.uuid, characteristic: c.uuid };
        return;
      }
    }
  }
  throw new Error('printer_not_supported');
}

export function hasPrinter(): boolean {
  return !!printer && !!target;
}

export async function printReceipt(lines: string[]): Promise<void> {
  if (!printer || !target) throw new Error('no_printer');
  const bytes = escposReceipt(lines);
  for (let i = 0; i < bytes.length; i += 180) {
    await printer.writeCharacteristicWithoutResponseForService(target.service, target.characteristic, toBase64(bytes.slice(i, i + 180)));
  }
}
