/** Units of measure: everything is stored in base units (pieces); packs are multiples. */
export interface ProductUnit {
  unitId: string;
  name: string;
  plural: string;
  /** base units per one of this unit */
  factor: number;
  isBase: boolean;
  sellable?: boolean;
}

export function toBaseQty(units: readonly ProductUnit[], unitId: string, qty: number): number {
  const u = units.find((x) => x.unitId === unitId);
  if (!u || u.sellable === false) throw new Error('unit_not_sellable');
  if (!Number.isInteger(qty) || qty <= 0) throw new Error('invalid_qty');
  return qty * u.factor;
}

/**
 * Split a base quantity into the largest packs first, e.g. 30 pieces with carton=12 →
 * [{carton, 2}, {piece, 6}]. Used for display ("2 cartons + 6 pieces").
 */
export function splitIntoUnits(units: readonly ProductUnit[], baseQty: number): { unit: ProductUnit; qty: number }[] {
  const sorted = [...units].filter((u) => u.sellable !== false).sort((a, b) => b.factor - a.factor);
  const out: { unit: ProductUnit; qty: number }[] = [];
  let rest = baseQty;
  for (const u of sorted) {
    if (rest <= 0) break;
    const n = Math.floor(rest / u.factor);
    if (n > 0) {
      out.push({ unit: u, qty: n });
      rest -= n * u.factor;
    }
  }
  return out;
}

export function describeQty(units: readonly ProductUnit[], baseQty: number): string {
  if (baseQty === 0) return '0';
  return splitIntoUnits(units, baseQty)
    .map(({ unit, qty }) => `${qty} ${qty === 1 ? unit.name : unit.plural}`)
    .join(' + ');
}
