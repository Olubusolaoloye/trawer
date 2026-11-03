/**
 * EAN-13 barcodes (what supermarket and phone scanners read). Every variant gets one automatically
 * (in-store range 20–29, see the catalog migration); this turns the 13 digits into bars for labels.
 */
const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
// Which of the left six digits use the G (even parity) set, chosen by the first digit.
const PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

export function ean13CheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error('ean13 needs 12 digits');
  const sum = [...first12].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10;
}

export function isValidEan13(code: string): boolean {
  return /^\d{13}$/.test(code) && ean13CheckDigit(code.slice(0, 12)) === Number(code[12]);
}

/** 95 modules ("1" = bar): start guard, 6 left digits, centre guard, 6 right digits, end guard. */
export function ean13Modules(code: string): string {
  if (!isValidEan13(code)) throw new Error(`not a valid EAN-13: ${code}`);
  const d = [...code].map(Number);
  const parity = PARITY[d[0]!]!;
  let out = '101';
  for (let i = 1; i <= 6; i++) out += (parity[i - 1] === 'L' ? L : G)[d[i]!]!;
  out += '01010';
  for (let i = 7; i <= 12; i++) out += R[d[i]!]!;
  return out + '101';
}

/** Bars as [startModule, widthInModules] runs, ready to draw as rectangles. */
export function ean13Bars(code: string): [number, number][] {
  const m = ean13Modules(code);
  const bars: [number, number][] = [];
  for (let i = 0; i < m.length; i++) {
    if (m[i] !== '1') continue;
    let w = 1;
    while (m[i + w] === '1') w++;
    bars.push([i, w]);
    i += w - 1;
  }
  return bars;
}

/** Human-readable digits under the bars: "2 000000 000017". */
export const ean13Text = (code: string) => `${code[0]} ${code.slice(1, 7)} ${code.slice(7)}`;
