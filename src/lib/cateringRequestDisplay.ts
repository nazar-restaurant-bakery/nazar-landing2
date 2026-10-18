export type RequestedItem = {
  key: string;
  label: string;
  detail: string;
  shownPrice: number | null;
  needsQuote: boolean;
};

export type RequestSelection = {
  items: RequestedItem[];
  shownSubtotal: number | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function label(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 200
    ? value.trim() : null;
}

function positiveInteger(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) > 0 && (value as number) <= 10000
    ? value as number : null;
}

function price(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1000000
    ? value : null;
}

function customItems(value: unknown): RequestedItem[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((raw, index) => {
    const dish = record(raw);
    const name = label(dish?.label);
    if (!name) return [];
    const quantity = positiveInteger(dish?.quantity);
    return [{ key: `dish-${index}`, label: name,
      detail: quantity === null ? "Quantity to confirm" : `Quantity: ${quantity}`,
      shownPrice: null, needsQuote: true }];
  });
}

export function describeCateringSelection(value: unknown): RequestSelection | null {
  const selection = record(value);
  if (!selection) return null;

  if (selection.type === "package") {
    const name = label(selection.label);
    return name ? { items: [{ key: "package", label: name, detail: "Package selection",
      shownPrice: null, needsQuote: true }], shownSubtotal: null } : null;
  }
  if (selection.type === "custom") {
    const items = customItems(selection.dishes);
    return items.length ? { items, shownSubtotal: null } : null;
  }
  if (selection.type !== "trays" || !Array.isArray(selection.trays)) return null;

  const trays: RequestedItem[] = selection.trays.slice(0, 100).flatMap((raw, index) => {
    const tray = record(raw);
    const name = label(tray?.label);
    const guests = positiveInteger(tray?.guest_size);
    const quantity = positiveInteger(tray?.quantity);
    const unit = label(tray?.unit);
    if (!name || guests === null) return [];
    const details = [`${guests}-guest option`];
    if (quantity !== null && unit) details.push(`${quantity} ${unit}`);
    if (tray?.includes_rice === true) details.push("with rice pilav");
    return [{ key: `tray-${index}`, label: name, detail: details.join(" · "),
      shownPrice: price(tray?.shown_price), needsQuote: false }];
  });
  const items = [...trays, ...customItems(selection.additional_dishes)];
  if (!items.length) return null;
  return { items, shownSubtotal: price(selection.shown_subtotal) };
}
