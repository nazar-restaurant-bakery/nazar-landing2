// Server-owned catalog for the future checkout. Never accept prices from the browser.
// Update together with src/data/cateringMenus.ts until catalog data moves to a
// single server-managed source.
export const CATERING_PRICES_CENTS: Record<string, readonly [number, number, number, number]> = {
  "lentil-soup": [5000, 9000, 13000, 20000],
  "caesar-salad": [7500, 14000, 20000, 30000],
  "season-salad": [7500, 14000, 20000, 30000],
  "shepherd-salad": [7500, 14000, 20000, 30000],
  "cold-appetizers-platter": [7000, 12000, 16000, 25000],
  jajik: [5000, 9000, 13000, 20000],
  "cheese-rolls": [1500, 2700, 3500, 5500],
  falafel: [2200, 4000, 5700, 9000],
  "grilled-meatballs": [2500, 4500, 6600, 10500],
  "chicken-wings": [17000, 32000, 45000, 72000],
  "chicken-chops": [15000, 28000, 40000, 65000],
  "adana-shish": [9500, 16500, 24000, 39000],
  "chicken-shish": [8500, 16000, 23000, 37500],
  "meat-gyro": [15000, 28500, 42000, 68000],
  "chicken-gyro": [14000, 26500, 36500, 58000],
};

export type TraySelection = { id: string; size: 10 | 20 | 30 | 50; quantity: number };
export type PricedTray = TraySelection & { unitPriceCents: number; lineTotalCents: number };

export function priceStandardTrays(input: unknown): { lines: PricedTray[]; subtotalCents: number } {
  if (!Array.isArray(input) || input.length === 0 || input.length > 50) {
    throw new RangeError("Select between 1 and 50 tray lines");
  }
  const sizes = [10, 20, 30, 50];
  const seen = new Set<string>();
  const lines: PricedTray[] = [];
  let subtotalCents = 0;
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Invalid tray");
    const line = value as Record<string, unknown>;
    const sizeIndex = sizes.indexOf(line.size as number);
    if (typeof line.id !== "string" || !Object.hasOwn(CATERING_PRICES_CENTS, line.id) ||
        sizeIndex < 0 || typeof line.quantity !== "number" ||
        !Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20) {
      throw new TypeError("Invalid tray selection");
    }
    const key = `${line.id}:${line.size}`;
    if (seen.has(key)) throw new TypeError("Duplicate tray selection");
    seen.add(key);
    const unitPriceCents = CATERING_PRICES_CENTS[line.id][sizeIndex];
    const lineTotalCents = unitPriceCents * line.quantity;
    subtotalCents += lineTotalCents;
    if (subtotalCents > 2_000_000) throw new RangeError("Order exceeds online limit");
    lines.push({ id: line.id, size: line.size as TraySelection["size"], quantity: line.quantity, unitPriceCents, lineTotalCents });
  }
  return { lines, subtotalCents };
}
