import { CollectorError, addDays, metric, nyDate, sanitizeText, type MetricSnapshot } from "./collectors.ts";

export type CloverChannel = "dine_in" | "pickup" | "delivery" | "catering" | "excluded" | "unknown";
export type DailySales = { date: string; grossCents: number | null; refundCents: number | null; netCents: number | null; taxCents: number | null; tipCents: number | null; collectedCents: number | null; orders: number | null };
export type CloverCsvOptions = { periodStart: string; periodEnd: string; now?: Date; fileName?: string };
export type CloverCsvResult = {
  format: "sales_report" | "normalized"; metrics: MetricSnapshot[]; qualifiedSales: number | null;
  commissionReady: boolean; commissionEstimateReady: boolean; coverageValidated: boolean;
  periodMonth: string; periodStart: string; periodEnd: string; sourceFile: string; fingerprint: string;
  daily: DailySales[]; counts: { rows: number; duplicates: number; excluded: number; unknownChannel: number; unknownAmounts: number };
};
export function csvRows(text: string): string[][] {
  if (typeof text !== "string" || text.length > 2_000_000 || text.includes("\0")) throw new CollectorError("invalid_csv_size");
  const rows: string[][] = []; let row: string[] = []; let cell = ""; let quoted = false; let closed = false;
  const source = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) { if (char === '"') { if (source[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } } else cell += char; continue; }
    if (char === '"') { if (cell || closed) throw new CollectorError("invalid_csv_quote"); quoted = true; continue; }
    if (char === ",") { row.push(cell); cell = ""; closed = false; continue; }
    if (char === "\r" || char === "\n") { if (char === "\r" && source[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; closed = false; continue; }
    if (closed && !/\s/.test(char)) throw new CollectorError("invalid_csv_quote");
    if (!closed) cell += char;
  }
  if (quoted) throw new CollectorError("invalid_csv_quote");
  if (cell || row.length || closed) { row.push(cell); rows.push(row); }
  if (rows.length > 30_000 || rows.some(r => r.length > 100)) throw new CollectorError("invalid_csv_size");
  return rows;
}
// Exact decimal parsing: neither parseFloat nor binary floating-point arithmetic
// is used for any financial addition. Blank is unknown, not zero.
export function parseCents(value: string | undefined): number | null {
  if (value === undefined || !value.trim()) return null;
  let text = value.trim(); const parentheses = /^\(.*\)$/.test(text);
  if (parentheses) text = text.slice(1, -1).trim();
  text = text.replace(/^\$/, "");
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(text)) throw new CollectorError("invalid_money");
  const negative = parentheses || text.startsWith("-");
  const [whole, decimals = ""] = text.replace(/^-/, "").replaceAll(",", "").split(".");
  const cents = Number(whole) * 100 + Number(decimals.padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents > 9_000_000_000_000) throw new CollectorError("money_out_of_range");
  return negative ? -cents : cents;
}
function sum(values: (number | null)[]): number | null {
  if (values.some(value => value === null)) return null;
  const total = values.reduce<number>((a, b) => a + b!, 0);
  if (!Number.isSafeInteger(total)) throw new CollectorError("money_out_of_range"); return total;
}
function validPeriod(options: CloverCsvOptions) {
  for (const value of [options.periodStart, options.periodEnd]) {
    const parsed = new Date(value + "T12:00:00Z");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new CollectorError("invalid_csv_period");
  }
  if (options.periodStart > options.periodEnd || options.periodStart.slice(0, 7) !== options.periodEnd.slice(0, 7)) throw new CollectorError("single_month_required");
}
export function classifyChannel(value: string): CloverChannel {
  const v = value.toLowerCase().trim().replace(/[ _-]+/g, " ");
  if (/\buber(?:\s*eats)?\b|\bgrub\s*hub\b/.test(v)) return "excluded";
  if (["dine in", "dinein"].includes(v)) return "dine_in";
  if (["pickup", "pick up", "takeout", "take out"].includes(v)) return "pickup";
  if (["delivery", "doordash", "door dash"].includes(v)) return "delivery";
  return v === "catering" ? "catering" : "unknown";
}
const financialRows = new Map([['Gross sales', 'grossCents'], ['Refunds', 'refundCents'], ['Net sales', 'netCents'], ['Taxes', 'taxCents'], ['Tips', 'tipCents'], ['Amount collected', 'collectedCents']] as const);
function parseSalesReport(rows: string[][], options: CloverCsvOptions) {
  const section = rows.findIndex(row => row.length === 1 && row[0].trim() === "Sales");
  if (section < 0) throw new CollectorError("sales_section_missing");
  const header = rows[section + 1];
  if (!header || header[1]?.trim() !== "Total" || header.length < 3) throw new CollectorError("invalid_sales_header");
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dates = header.slice(2).map(label => {
    const match = /^([A-Z][a-z]{2})\s+(\d{1,2})$/.exec(label.trim());
    if (!match || !monthNames.includes(match[1])) throw new CollectorError("invalid_sales_date_header");
    return options.periodStart.slice(0, 4) + "-" + String(monthNames.indexOf(match[1]) + 1).padStart(2, "0") + "-" + match[2].padStart(2, "0");
  });
  if (new Set(dates).size !== dates.length || dates[0] !== options.periodStart || dates.at(-1) !== options.periodEnd
    || dates.some((date, i) => date !== addDays(options.periodStart, i))) throw new CollectorError("csv_period_mismatch");
  const ranges = rows.slice(0, section).flatMap(row => (row[0] || "").match(/[A-Z][a-z]{2} \d{1,2}, \d{4}/g) || []);
  if (ranges.length >= 2 && !ranges.slice(0, 2).every(date => new Date(date + " 12:00:00 UTC").getUTCFullYear() === Number(options.periodStart.slice(0, 4)))) throw new CollectorError("csv_year_mismatch");
  const daily: DailySales[] = dates.map(date => ({ date, grossCents: null, refundCents: null, netCents: null, taxCents: null, tipCents: null, collectedCents: null, orders: null }));
  const totals: Record<string, number | null> = {}; const seen = new Set<string>(); let financialCount = 0;
  for (let i = section + 2; i < rows.length; i++) {
    const row = rows[i]; if (!row.some(value => value.trim())) break;
    const field = financialRows.get(row[0] as 'Gross sales');
    if (!field) throw new CollectorError("unsupported_sales_row");
    if (seen.has(field) || row.length !== header.length) throw new CollectorError("duplicate_or_malformed_sales_row");
    seen.add(field); const values = row.slice(2).map(parseCents);
    const parsedTotal = parseCents(row[1]);
    totals[field] = field === "refundCents" && parsedTotal !== null ? Math.abs(parsedTotal) : parsedTotal;
    const financialTotal = sum(values);
    if (financialTotal !== null && parsedTotal !== null && financialTotal !== parsedTotal) throw new CollectorError("sales_total_mismatch");
    values.forEach((value, index) => { daily[index][field] = field === "refundCents" && value !== null ? Math.abs(value) : value; }); financialCount++;
  }
  if (financialCount !== 6) throw new CollectorError("incomplete_sales_rows");
  const orderSummary = rows.slice(0, section).find(row => row[0] === "Net sales" && /^from (?:\d+|\d{1,3}(?:,\d{3})+) orders?$/.test(row[2] || ""));
  const orders = orderSummary ? Number(orderSummary[2].replace(/\D/g, "")) : null;
  if (orders !== null && !Number.isSafeInteger(orders)) throw new CollectorError("invalid_order_count");
  return { daily, totals, orders, counts: { rows: daily.length, duplicates: 0, excluded: 0, unknownChannel: daily.length, unknownAmounts: daily.flatMap(d => [d.grossCents, d.refundCents, d.netCents, d.taxCents, d.tipCents, d.collectedCents]).filter(v => v === null).length }, channels: null, coverageValidated: true };
}
type Transaction = { key: string; order: string; kind: "payment" | "refund"; date: string; channel: CloverChannel; net: number | null; tax: number | null; tip: number | null; collected: number | null };
function parseNormalized(rows: string[][], options: CloverCsvOptions) {
  const headers = rows[0].map(value => value.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  if (new Set(headers).size !== headers.length) throw new CollectorError("duplicate_csv_header");
  const required = ["order_id", "transaction_id", "transaction_type", "occurred_at", "channel", "net_sales_usd"];
  if (!required.every(key => headers.includes(key))) throw new CollectorError("unsupported_csv_headers");
  const coverageValidated = ["export_period_start", "export_period_end"].every(key => headers.includes(key));
  if (["export_period_start", "export_period_end"].some(key => headers.includes(key)) && !coverageValidated) throw new CollectorError("incomplete_export_period_header");
  const get = (row: string[], key: string) => row[headers.indexOf(key)] ?? "";
  const seen = new Map<string, string>(); const transactions: Transaction[] = []; let duplicates = 0; let skipped = 0;
  for (const row of rows.slice(1)) {
    if (!row.some(value => value.trim())) continue;
    if (row.length !== headers.length) throw new CollectorError("malformed_transaction_row");
    const kind = get(row, "transaction_type").trim().toLowerCase();
    if (["summary", "total"].includes(kind)) { skipped++; continue; }
    if (!["payment", "refund"].includes(kind)) throw new CollectorError("unknown_transaction_type");
    if (coverageValidated && (get(row, "export_period_start") !== options.periodStart || get(row, "export_period_end") !== options.periodEnd)) throw new CollectorError("csv_period_mismatch");
    const id = get(row, "transaction_id").trim(); const order = get(row, "order_id").trim();
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id) || !/^[A-Za-z0-9_-]{1,100}$/.test(order)) throw new CollectorError("transaction_identity_required");
    const occurred = get(row, "occurred_at");
    // An offset is mandatory: device-local or ambiguous timestamps cannot define NY dates.
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(occurred) || !Number.isFinite(Date.parse(occurred))) throw new CollectorError("transaction_timezone_required");
    const calendar = new Date(occurred.slice(0, 10) + "T12:00:00Z");
    if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== occurred.slice(0, 10)) throw new CollectorError("invalid_transaction_date");
    const key = kind + ":" + id; const signature = JSON.stringify(row);
    if (seen.has(key)) { if (seen.get(key) !== signature) throw new CollectorError("conflicting_transaction_duplicate"); duplicates++; continue; }
    seen.set(key, signature);
    const date = nyDate(occurred); if (date < options.periodStart || date > options.periodEnd) continue;
    const amount = parseCents(get(row, "net_sales_usd"));
    if (kind === "payment" && amount !== null && amount < 0) throw new CollectorError("negative_payment_net");
    // Each refund is a separately dated product-net adjustment. A payment's net
    // is not reduced again by a summary refund column.
    const net = kind === "refund" && amount !== null ? -Math.abs(amount) : amount;
    for (const unsupported of ["refunds_usd", "refund_amount_usd", "refund_total_usd"]) if (get(row, unsupported).trim() && parseCents(get(row, unsupported)) !== 0) throw new CollectorError("ambiguous_refund_basis");
    const signed = (value: number | null) => kind === "refund" && value !== null ? -Math.abs(value) : value;
    transactions.push({ key, order, kind: kind as "payment" | "refund", date, channel: classifyChannel(get(row, "channel")), net,
      tax: signed(parseCents(get(row, "taxes_usd"))), tip: signed(parseCents(get(row, "tips_usd"))), collected: signed(parseCents(get(row, "amount_collected_usd"))) });
  }
  if (!transactions.length) throw new CollectorError("no_transactions_in_period");
  const included = transactions.filter(t => t.channel !== "excluded");
  const known = included.filter(t => t.channel !== "unknown");
  const dates = [...new Set(included.map(t => t.date))].sort();
  const daily = dates.map(date => {
    const rows = included.filter(t => t.date === date);
    return { date, grossCents: null, refundCents: sum(rows.filter(t => t.kind === "refund").map(t => t.net === null ? null : Math.abs(t.net))),
      netCents: sum(rows.map(t => t.net)), taxCents: sum(rows.map(t => t.tax)), tipCents: sum(rows.map(t => t.tip)), collectedCents: sum(rows.map(t => t.collected)),
      orders: new Set(rows.filter(t => t.kind === "payment").map(t => t.order)).size };
  });
  const channels = Object.fromEntries((["dine_in", "pickup", "delivery", "catering"] as const).map(channel => {
    const rows = known.filter(t => t.channel === channel);
    return [channel, { net: sum(rows.map(t => t.net)), orders: new Set(rows.filter(t => t.kind === "payment").map(t => t.order)).size }];
  }));
  return { daily, totals: { grossCents: null, refundCents: sum(daily.map(d => d.refundCents)), netCents: sum(included.map(t => t.net)), taxCents: sum(included.map(t => t.tax)), tipCents: sum(included.map(t => t.tip)), collectedCents: sum(included.map(t => t.collected)) },
    orders: new Set(included.filter(t => t.kind === "payment").map(t => t.order)).size, channels,
    counts: { rows: transactions.length, duplicates: duplicates + skipped, excluded: transactions.filter(t => t.channel === "excluded").length, unknownChannel: included.filter(t => t.channel === "unknown").length, unknownAmounts: included.filter(t => t.net === null).length }, coverageValidated };
}
export async function csvFingerprint(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function parseCloverCsv(text: string, options: CloverCsvOptions): Promise<CloverCsvResult> {
  validPeriod(options); const rows = csvRows(text); if (!rows.length) throw new CollectorError("empty_csv");
  const format = rows[0][0]?.trim() === "Sales Report" ? "sales_report" : "normalized";
  const parsed = format === "sales_report" ? parseSalesReport(rows, options) : parseNormalized(rows, options);
  const ctx = { env: {}, now: options.now }; const metrics: MetricSnapshot[] = [];
  const add = (key: string, value: number | null, start: string, end: string, note: string | null = null) => { const m = metric(ctx, "clover", key, value, note, start, end); m.collector = "manual_csv"; metrics.push(m); };
  const dollars = (cents: number | null) => cents === null ? null : cents / 100;
  const nyToday = nyDate(options.now ?? new Date());
  const qualified = parsed.coverageValidated && parsed.counts.unknownChannel === 0 && parsed.counts.unknownAmounts === 0 && parsed.totals.netCents !== null;
  const monthEnd = new Date(Date.UTC(Number(options.periodStart.slice(0, 4)), Number(options.periodStart.slice(5, 7)), 0)).toISOString().slice(0, 10);
  const monthStarts = options.periodStart.endsWith("-01");
  const commissionReady = qualified && monthStarts && options.periodEnd === monthEnd && options.periodEnd < nyToday;
  const commissionEstimateReady = qualified && !commissionReady && monthStarts && options.periodStart.slice(0, 7) === nyToday.slice(0, 7)
    && [nyToday, addDays(nyToday, -1)].includes(options.periodEnd);
  const scope = commissionEstimateReady ? "estimate" : commissionReady ? null : "Dönem, kanal veya tutar doğrulanmadı; QICR ve komisyon hazır değil.";
  add("net_sales_mtd", dollars(parsed.totals.netCents), options.periodStart, options.periodEnd, scope);
  add("orders_mtd", parsed.orders, options.periodStart, options.periodEnd, scope);
  const yesterday = addDays(nyDate(options.now ?? new Date()), -1); const day = parsed.daily.find(d => d.date === yesterday);
  add("net_sales_yesterday", day ? dollars(day.netCents) : null, yesterday, yesterday, day ? scope : "Bu CSV dünün dönemini kapsamıyor.");
  add("orders_yesterday", day?.orders ?? null, yesterday, yesterday);
  for (const row of parsed.daily) for (const [field, key] of [["grossCents", "gross_sales"], ["refundCents", "product_refunds"], ["netCents", "net_sales"], ["taxCents", "taxes"], ["tipCents", "tips"], ["collectedCents", "amount_collected"]] as const) add(key, dollars(row[field]), row.date, row.date);
  for (const row of parsed.daily) add("orders", row.orders, row.date, row.date);
  for (const channel of ["dine_in", "pickup", "delivery", "catering"] as const) {
    add("channel_" + channel + "_net_sales_mtd", parsed.channels ? dollars(parsed.channels[channel].net) : null, options.periodStart, options.periodEnd);
    add("channel_" + channel + "_orders_mtd", parsed.channels ? parsed.channels[channel].orders : null, options.periodStart, options.periodEnd);
  }
  return { format, metrics, qualifiedSales: commissionReady || commissionEstimateReady ? dollars(parsed.totals.netCents) : null, commissionReady, commissionEstimateReady, coverageValidated: parsed.coverageValidated,
    periodMonth: options.periodStart.slice(0, 7), periodStart: options.periodStart, periodEnd: options.periodEnd,
    sourceFile: sanitizeText((options.fileName ?? "clover.csv").split(/[\\/]/).at(-1), 120), fingerprint: await csvFingerprint(text), daily: parsed.daily, counts: parsed.counts };
}
// The CSV source is uploaded by staff; there is no background source to poll.
export async function collect() { return { source: "clover" as const, status: "not_connected" as const, metrics: [], note: "Clover CSV dosyası elle yüklenir.", requestsUsed: 0 }; }
