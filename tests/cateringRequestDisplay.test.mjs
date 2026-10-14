import assert from "node:assert/strict";
import test from "node:test";
import { describeCateringSelection } from "../src/lib/cateringRequestDisplay.ts";

test("tray and custom dishes remain separate with only shown tray prices", () => {
  const selection = describeCateringSelection({ type: "trays", trays: [
    { id: "wings", label: "Grilled Chicken Wings", guest_size: 30,
      quantity: 210, unit: "wings", shown_price: 450, includes_rice: false },
  ], additional_dishes: [
    { id: "cheese-pie", label: "Cheese Pie", quantity: 40 },
    { id: "baklava", label: "Baklava", quantity: null },
  ], shown_subtotal: 450 });
  assert.equal(selection.shownSubtotal, 450);
  assert.deepEqual(selection.items.map((item) => [item.label, item.detail, item.shownPrice, item.needsQuote]), [
    ["Grilled Chicken Wings", "30-guest option · 210 wings", 450, false],
    ["Cheese Pie", "Quantity: 40", null, true],
    ["Baklava", "Quantity to confirm", null, true],
  ]);
});

test("form-only and older requests do not invent items or prices", () => {
  assert.equal(describeCateringSelection(null), null);
  assert.equal(describeCateringSelection({ type: "trays", trays: [] }), null);
  assert.deepEqual(describeCateringSelection({ type: "package", label: "Doner & Gyro Table" }), {
    items: [{ key: "package", label: "Doner & Gyro Table", detail: "Package selection",
      shownPrice: null, needsQuote: true }], shownSubtotal: null,
  });
});
