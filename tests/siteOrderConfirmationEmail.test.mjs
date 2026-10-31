import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSiteOrderConfirmationEmail, sendVerifiedSiteOrderEmail } from "../functions/_lib/siteOrderConfirmationEmail.ts";

const claim = { orderId: "12345678-1234-4123-8123-123456789012", email: "customer@example.com",
  requestedAt: "2026-11-02T17:00:00Z", totalCents: 31151, status: "paid" };
const detail = { customerName: "Ayşe <b>&</b>", preparationNote: 'No "onions" <script>alert(1)</script>',
  lines: [{ id: "jajik", size: 10, quantity: 2, unitPriceCents: 5000, lineTotalCents: 10000 },
    { id: "adana-shish", size: 20, quantity: 1, unitPriceCents: 16500, lineTotalCents: 19017 }],
  subtotalCents: 29017, taxCents: 2134, totalCents: 31151 };

test("email lists stored lines, subtotal, tax and total in text and HTML", () => {
  const { subject, text, html } = buildSiteOrderConfirmationEmail(claim, detail);
  assert.equal(subject, "Nazar catering order 12345678");
  assert.match(text, /- Jajik \(Cacık\) \(10 guests\) x 2: \$100\.00/);
  // Stored line total is shown as is, never recomputed from unit price or catalog.
  assert.match(text, /- Adana Shish \(20 guests\) x 1: \$190\.17/);
  assert.match(text, /Subtotal: \$290\.17\nTax: \$21\.34\nPaid total: \$311\.51/);
  assert.match(text, /Preparation note: No "onions" <script>/);
  for (const cell of ["Jajik (Cacık)", "10 guests", ">2<", "$100.00", "Adana Shish", "$190.17",
    "Subtotal: $290.17", "Tax: $21.34", "Paid total: $311.51"]) assert.ok(html.includes(cell), cell);
});

test("customer name and note are escaped in HTML", () => {
  const { html } = buildSiteOrderConfirmationEmail(claim, detail);
  assert.ok(html.includes("Hello Ayşe &lt;b&gt;&amp;&lt;/b&gt;,"));
  assert.ok(html.includes("No &quot;onions&quot; &lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<b>&</b>"));
});

test("missing or inconsistent detail falls back to a totals-only receipt", () => {
  for (const value of [null, { ...detail, lines: [] }, { ...detail, totalCents: 1 },
    { ...detail, lines: [{ id: "jajik", size: 10, quantity: 0, lineTotalCents: 5000 }] }]) {
    const { text, html } = buildSiteOrderConfirmationEmail(claim, value);
    assert.ok(!text.includes("Items:"));
    assert.ok(!text.includes("Ayşe"));
    assert.match(text, /Paid total: \$311\.51/);
    assert.ok(html.includes("Paid total: $311.51"));
  }
  const reschedule = buildSiteOrderConfirmationEmail({ ...claim, status: "needs_reschedule" }, detail).text;
  assert.match(reschedule, /contact you to confirm a new pickup time/);
});

const env = { SUPABASE_SECRET_KEY: "sb_secret_test", SITE_BUSINESS_ID: "a358eba4-b197-4309-805b-46f43a718454",
  RESEND_API_KEY: "token-test" };
// provider: (Resend call) => Response; may throw for a transport failure.
async function send(provider, overrides = {}) {
  const calls = [];
  const fetcher = async (address, options) => {
    const path = String(address);
    calls.push({ path, body: JSON.parse(options.body), headers: options.headers });
    if (path.endsWith("_claim_v1")) return Response.json(claim);
    if (path.endsWith("_detail_v1")) return Response.json(detail);
    if (path.startsWith("https://api.resend.com/")) return provider();
    return Response.json(true);
  };
  await sendVerifiedSiteOrderEmail({ ...env, ...overrides }, "https://khgczybubufouraqyrcj.supabase.co", "session-1", fetcher);
  return calls;
}

test("sender reads detail only after the claim and sends both bodies through Resend", async () => {
  const calls = await send(() => Response.json({ id: "re_test_1" }));
  assert.deepEqual(calls.map((c) => c.path.split("/").at(-1)), ["site_order_customer_email_claim_v1",
    "site_order_customer_email_detail_v1", "emails", "site_order_customer_email_finish_v1"]);
  assert.equal(calls[2].path, "https://api.resend.com/emails");
  assert.deepEqual(calls[2].headers, { Authorization: "Bearer token-test", "Content-Type": "application/json",
    "Idempotency-Key": claim.orderId });
  const sent = calls[2].body;
  assert.deepEqual(Object.keys(sent), ["from", "to", "subject", "text", "html"]);
  assert.equal(sent.from, "Nazar Restaurant & Bakery <notifications@mail.nazarrestaurantandbakery.com>");
  assert.deepEqual(sent.to, [claim.email]);
  assert.equal(sent.subject, "Nazar catering order 12345678");
  assert.match(sent.text, /Jajik/);
  assert.match(sent.html, /<table/);
  assert.deepEqual(calls[3].body, { p_business_id: env.SITE_BUSINESS_ID, p_site_order_id: claim.orderId,
    p_sent: true, p_provider_status: "accepted" });
});

for (const [name, provider] of [
  ["HTTP error", () => Response.json({ name: "validation_error" }, { status: 422 })],
  ["OK without id", () => Response.json({})],
  ["non-string id", () => Response.json({ id: 42 })],
]) {
  test(`Resend ${name} is finished as not_accepted, sent once`, async () => {
    const calls = await send(provider);
    assert.equal(calls.filter((c) => c.path.startsWith("https://api.resend.com/")).length, 1);
    assert.deepEqual([calls.at(-1).body.p_sent, calls.at(-1).body.p_provider_status], [false, "not_accepted"]);
  });
}

test("a Resend transport exception is finished as provider_error and not retried", async () => {
  const calls = await send(() => { throw new Error("uncertain transport"); });
  assert.equal(calls.filter((c) => c.path.startsWith("https://api.resend.com/")).length, 1);
  assert.deepEqual([calls.at(-1).body.p_sent, calls.at(-1).body.p_provider_status], [false, "provider_error"]);
});

test("without RESEND_API_KEY nothing is claimed or sent", async () => {
  const calls = await send(() => Response.json({ id: "re_test_1" }), { RESEND_API_KEY: undefined });
  assert.equal(calls.length, 0);
});
