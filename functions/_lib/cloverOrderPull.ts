import { resolveServerEnvironment } from "../../src/lib/deploymentEnvironment.ts";

export type PullEnv = Record<string, string | undefined>;
export type Fetcher = typeof fetch;
export type PullWindow = { start: number; end: number };
const nyWall = (value: number) => {
  const parts = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(value);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${fields.year}-${fields.month}-${fields.day}T${fields.hour}:${fields.minute}`;
};
function nyMidnight(day: string): number | null {
  const wall = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(wall)) return null;
  let candidate = wall;
  for (let i = 0; i < 4; i++) candidate += wall - Date.parse(`${nyWall(candidate)}:00Z`);
  return nyWall(candidate) === `${day}T00:00` ? candidate : null;
}
export function closedPullWindow(day: string, now = Date.now()): PullWindow | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day >= nyWall(now).slice(0, 10)) return null;
  const start = nyMidnight(day);
  const next = new Date(`${day}T12:00:00Z`);
  if (!Number.isFinite(next.getTime()) || next.toISOString().slice(0, 10) !== day) return null;
  next.setUTCDate(next.getUTCDate() + 1);
  const end = nyMidnight(next.toISOString().slice(0, 10));
  return start !== null && end !== null && now - start <= 30 * 86_400_000 && end <= now
    ? { start, end } : null;
}
type ObjectValue = Record<string, unknown>;
const cloverId = /^[A-Za-z0-9]{8,32}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (x: unknown): x is ObjectValue => x !== null && typeof x === "object" && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === "string" && cloverId.test(x);
export type PullStep = "configuration" | "authorization" | "list" | "order_core" | "order_refunds" | "order_customers" | "ingest";
export type PullWarning = { code: "clover_refunds_access_denied" | "clover_customers_access_denied"; step: "order_refunds" | "order_customers"; httpStatus: number };

export class PullError extends Error {
  readonly code: string;
  readonly step: PullStep;
  readonly providerStatus?: number;
  constructor(code: string, step: PullStep, providerStatus?: number) {
    super(code);
    this.code = code;
    this.step = step;
    this.providerStatus = providerStatus;
  }
}

export function orderPullConfig(env: PullEnv, hostname: string) {
  const target = resolveServerEnvironment(env, hostname);
  const prefix = target.isolated ? "TEST_" : "";
  const merchant = env[prefix + "CLOVER_MERCHANT_ID"] || "";
  const token = env[prefix + "CLOVER_ORDERS_ACCESS_TOKEN"] || "";
  const onlineTypes = (env[prefix + "CLOVER_ONLINE_ORDER_TYPE_IDS"] || "").split(",").map(x => x.trim()).filter(Boolean);
  const publicKey = env[target.isolated ? "VITE_TEST_SUPABASE_ANON_KEY" : "VITE_SUPABASE_ANON_KEY"] || "";
  const ready = target.configured && uuid.test(target.businessId) && target.secret.startsWith("sb_secret_")
    && publicKey.startsWith("sb_publishable_") && id(merchant) && token.length >= 12
    && onlineTypes.length > 0 && onlineTypes.length <= 4 && onlineTypes.every(id)
    && (!target.isolated || (target.secret !== env.SUPABASE_SECRET_KEY
      && token !== env.CLOVER_ORDERS_ACCESS_TOKEN && merchant !== env.CLOVER_MERCHANT_ID));
  return { ...target, ready, merchant, token, onlineTypes, publicKey,
    cloverBase: target.isolated ? "https://apisandbox.dev.clover.com" : "https://api.clover.com" };
}

function elements(value: unknown, step: PullStep): ObjectValue[] {
  const rows = Array.isArray(value) ? value : object(value) ? value.elements : null;
  if (!Array.isArray(rows) || rows.some(row => !object(row))) throw new PullError("clover_collection_missing", step);
  return rows as ObjectValue[];
}

function contact(customer: ObjectValue | undefined, single: string, plural: string): string | null {
  if (!customer) return null;
  if (typeof customer[single] === "string") return customer[single];
  const list = customer[plural];
  const first = object(list) && Array.isArray(list.elements) ? list.elements[0] : undefined;
  return object(first) && typeof first[single] === "string" ? first[single] : null;
}

/** Payments must be present; a successful order response may omit empty optional collections. */
export function snapshot(detail: unknown, merchant: string, onlineTypes: string[]): ObjectValue {
  if (!object(detail) || !id(detail.id) || !Number.isSafeInteger(detail.createdTime)) throw new PullError("clover_order_invalid", "order_core");
  const orderType = detail.orderType;
  const typeId = object(orderType) && id(orderType.id) ? orderType.id : null;
  if (!typeId) throw new PullError("clover_order_type_missing", "order_core");
  const items = elements(detail.lineItems, "order_core");
  const payments = elements(detail.payments, "order_core");
  const refunds = detail.refunds === undefined ? [] : elements(detail.refunds, "order_refunds");
  const customers = detail.customers === undefined ? [] : elements(detail.customers, "order_customers");
  for (const row of [...items, ...payments]) if (!id(row.id)) throw new PullError("clover_child_invalid", "order_core");
  for (const row of refunds) if (!id(row.id)) throw new PullError("clover_child_invalid", "order_refunds");
  for (const row of payments) if (!Number.isSafeInteger(row.amount) || Number(row.amount) < 0) throw new PullError("clover_payment_invalid", "order_core");
  for (const row of refunds) if (!Number.isSafeInteger(row.amount) || Number(row.amount) < 0) throw new PullError("clover_refund_invalid", "order_refunds");
  const isOnline = onlineTypes.includes(typeId);
  const customer = isOnline ? customers[0] : undefined;
  return { id: detail.id, merchantId: merchant, orderTypeId: typeId, online: isOnline,
    createdTime: detail.createdTime, modifiedTime: detail.modifiedTime ?? null,
    state: detail.state ?? null, total: detail.total ?? null,
    customerEmail: contact(customer, "emailAddress", "emailAddresses"),
    customerPhone: contact(customer, "phoneNumber", "phoneNumbers"),
    items, payments, refunds, refundsVerified: detail.refundsVerified !== false,
    customerAccess: detail.customerAccess === "denied" ? "denied" : "verified", raw: detail };
}

const REQUEST_LIMIT = 30;
const MIN_GAP_MS = 150;
const RETRY_BUDGET_MS = 12000;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class CloverRequestGate {
  attempts = 0;
  private lastStarted = 0;
  private deadline = 0;
  async get(url: URL, token: string, fetcher: Fetcher, step: PullStep): Promise<Response> {
    for (let retry = 0; retry < 3; retry++) {
      if (this.attempts >= REQUEST_LIMIT) throw new PullError("clover_request_budget_exhausted", step);
      const gap = this.lastStarted + MIN_GAP_MS - Date.now();
      if (gap > 0) await sleep(gap);
      this.lastStarted = Date.now();
      this.attempts++;
      let response: Response;
      try {
        response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(10000),
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "NazarCRM/1.0" } });
      } catch (error) { if (error instanceof PullError) throw error; throw new PullError("clover_request_failed", step); }
      if (response.status !== 429) return response;
      if (!this.deadline) this.deadline = Date.now() + RETRY_BUDGET_MS;
      const header = response.headers.get("Retry-After");
      const seconds = header && /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN;
      const wait = Math.max(1000 * 2 ** retry, Number.isFinite(seconds) ? Math.ceil(seconds * 1000) : 0);
      if (retry === 2 || Date.now() + wait > this.deadline || this.attempts >= REQUEST_LIMIT)
        throw new PullError("clover_rate_limited", step, 429);
      await sleep(wait);
    }
    throw new PullError("clover_rate_limited", step, 429);
  }
}

async function cloverJson(url: URL, token: string, fetcher: Fetcher, step: PullStep, gate: CloverRequestGate): Promise<ObjectValue> {
  const response = await gate.get(url, token, fetcher, step);
  if (!response.ok) throw new PullError(response.status === 401 || response.status === 403
    ? "clover_access_denied" : "clover_http_error", step, response.status);
  let body: unknown;
  try { body = await response.json(); } catch { throw new PullError("clover_response_invalid", step); }
  if (!object(body)) throw new PullError("clover_response_invalid", step);
  return body;
}

export async function collectOrders(config: ReturnType<typeof orderPullConfig>, windowOrDays: PullWindow | number, fetcher: Fetcher,
  gateOrWindow: CloverRequestGate | PullWindow = new CloverRequestGate()): Promise<{ orders: ObjectValue[]; warnings: PullWarning[]; requestCount: number }> {
  // K12's pending scheduler passes its own exact NY window as the fourth argument;
  // its budgeted fetcher reserves every attempt, including 429 retries.
  const gate = gateOrWindow instanceof CloverRequestGate ? gateOrWindow : new CloverRequestGate();
  const window = typeof windowOrDays === "number"
    ? (gateOrWindow instanceof CloverRequestGate
      ? { start: Date.now() - windowOrDays * 86_400_000, end: Date.now() } : gateOrWindow)
    : windowOrDays;
  if (typeof windowOrDays === "number" && (!Number.isInteger(windowOrDays) || windowOrDays < 1 || windowOrDays > 30))
    throw new Error("invalid_pull");
  if (!config.ready || !Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.end)
    || window.end <= window.start || window.end - window.start > 25 * 3600_000) throw new Error("invalid_pull");
  const since = window.start;
  const end = window.end - 1;
  const listed = new Map<string, ObjectValue>();
  const pageOffsets: number[] = [];
  for (let offset = 0; offset <= 1000; offset += 100) {
    const url = new URL(`${config.cloverBase}/v3/merchants/${config.merchant}/orders`);
    url.searchParams.append("filter", `createdTime>=${since}`);
    url.searchParams.append("filter", `createdTime<=${end}`);
    url.searchParams.set("expand", "orderType,lineItems,payments");
    url.searchParams.set("orderBy", "createdTime DESC");
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));
    const rows = elements(await cloverJson(url, config.token, fetcher, "list", gate), "list");
    pageOffsets.push(offset);
    for (const row of rows) {
      if (!id(row.id) || !Number.isSafeInteger(row.createdTime)) throw new PullError("clover_order_invalid", "list");
      listed.set(row.id, row);
    }
    if (rows.length < 100) break;
    if (offset === 1000) throw new PullError("clover_pull_limit", "list");
  }
  const output: ObjectValue[] = [];
  const warnings: PullWarning[] = [];
  if (listed.size === 0) return { orders: output, warnings, requestCount: gate.attempts };
  async function optionalCollection(expand: "refunds" | "customers", step: "order_refunds" | "order_customers") {
    const result = new Map<string, ObjectValue>();
    try {
      for (const offset of pageOffsets) {
        const url = new URL(`${config.cloverBase}/v3/merchants/${config.merchant}/orders`);
        url.searchParams.append("filter", `createdTime>=${since}`);
        url.searchParams.append("filter", `createdTime<=${end}`);
        url.searchParams.set("expand", expand);
        url.searchParams.set("orderBy", "createdTime DESC");
        url.searchParams.set("limit", "100");
        url.searchParams.set("offset", String(offset));
        for (const row of elements(await cloverJson(url, config.token, fetcher, step, gate), step)) {
          if (!id(row.id)) throw new PullError("clover_order_invalid", step);
          result.set(row.id, row);
        }
      }
      if ([...listed.keys()].some(orderId => !result.has(orderId))) throw new PullError("clover_collection_mismatch", step);
      return { rows: result, denied: false };
    } catch (error) {
      if (!(error instanceof PullError) || error.code !== "clover_access_denied") throw error;
      warnings.push({ code: expand === "refunds" ? "clover_refunds_access_denied" : "clover_customers_access_denied",
        step, httpStatus: error.providerStatus || 403 });
      return { rows: result, denied: true };
    }
  }
  const refundRows = await optionalCollection("refunds", "order_refunds");
  const customerRows = await optionalCollection("customers", "order_customers");
  for (const [orderId, listedOrder] of listed) {
    const url = new URL(`${config.cloverBase}/v3/merchants/${config.merchant}/orders/${orderId}`);
    let core = listedOrder;
    if (core.lineItems === undefined || core.payments === undefined || core.orderType === undefined) {
      url.searchParams.set("expand", "lineItems,payments,orderType");
      core = await cloverJson(url, config.token, fetcher, "order_core", gate);
    }
    if (core.id !== orderId) throw new PullError("clover_order_invalid", "order_core");
    // Do not spend optional calls on an order that lacks a payment or item collection.
    snapshot({ ...core, refunds: { elements: [] }, customers: { elements: [] } }, config.merchant, config.onlineTypes);
    const refunds = refundRows.denied ? undefined : refundRows.rows.get(orderId)?.refunds;
    const typeId = object(core.orderType) ? core.orderType.id : null;
    const online = typeof typeId === "string" && config.onlineTypes.includes(typeId);
    const customers = online && !customerRows.denied ? customerRows.rows.get(orderId)?.customers : undefined;
    output.push(snapshot({ ...core, refunds, customers, refundsVerified: !refundRows.denied,
      customerAccess: online && customerRows.denied ? "denied" : "verified" },
      config.merchant, config.onlineTypes));
  }
  return { orders: output, warnings, requestCount: gate.attempts };
}
