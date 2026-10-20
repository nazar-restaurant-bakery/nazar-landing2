import { resolveServerEnvironment } from "../../src/lib/deploymentEnvironment.ts";

export type PullEnv = Record<string, string | undefined>;
export type Fetcher = typeof fetch;
type ObjectValue = Record<string, unknown>;
const cloverId = /^[A-Za-z0-9]{8,32}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (x: unknown): x is ObjectValue => x !== null && typeof x === "object" && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === "string" && cloverId.test(x);
export type PullStep = "configuration" | "authorization" | "list" | "order_core" | "order_refunds" | "ingest";

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
  const customers = detail.customers === undefined ? [] : elements(detail.customers, "order_refunds");
  for (const row of [...items, ...payments, ...refunds]) if (!id(row.id)) throw new PullError("clover_child_invalid", "order_core");
  for (const row of payments) if (!Number.isSafeInteger(row.amount) || Number(row.amount) < 0) throw new PullError("clover_payment_invalid", "order_core");
  for (const row of refunds) if (!Number.isSafeInteger(row.amount) || Number(row.amount) < 0) throw new PullError("clover_refund_invalid", "order_refunds");
  const isOnline = onlineTypes.includes(typeId);
  const customer = isOnline ? customers[0] : undefined;
  return { id: detail.id, merchantId: merchant, orderTypeId: typeId, online: isOnline,
    createdTime: detail.createdTime, modifiedTime: detail.modifiedTime ?? null,
    state: detail.state ?? null, total: detail.total ?? null,
    customerEmail: contact(customer, "emailAddress", "emailAddresses"),
    customerPhone: contact(customer, "phoneNumber", "phoneNumbers"),
    items, payments, refunds, raw: detail };
}

async function cloverJson(url: URL, token: string, fetcher: Fetcher, step: PullStep): Promise<ObjectValue> {
  let response: Response;
  try {
    response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(10000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "NazarCRM/1.0" } });
  } catch { throw new PullError("clover_request_failed", step); }
  if (!response.ok) throw new PullError(response.status === 401 || response.status === 403
    ? "clover_access_denied" : "clover_http_error", step, response.status);
  let body: unknown;
  try { body = await response.json(); } catch { throw new PullError("clover_response_invalid", step); }
  if (!object(body)) throw new PullError("clover_response_invalid", step);
  return body;
}

export async function collectOrders(config: ReturnType<typeof orderPullConfig>, days: number, fetcher: Fetcher): Promise<ObjectValue[]> {
  if (!config.ready || !Number.isInteger(days) || days < 1 || days > 30) throw new Error("invalid_pull");
  const end = Date.now();
  const since = end - days * 86_400_000;
  const listed = new Map<string, ObjectValue>();
  for (let offset = 0; offset <= 1000; offset += 100) {
    const url = new URL(`${config.cloverBase}/v3/merchants/${config.merchant}/orders`);
    url.searchParams.append("filter", `createdTime>=${since}`);
    url.searchParams.append("filter", `createdTime<=${end}`);
    url.searchParams.set("expand", "orderType");
    url.searchParams.set("orderBy", "createdTime DESC");
    url.searchParams.set("limit", "100");
    url.searchParams.set("offset", String(offset));
    const rows = elements(await cloverJson(url, config.token, fetcher, "list"), "list");
    for (const row of rows) {
      if (!id(row.id) || !Number.isSafeInteger(row.createdTime)) throw new PullError("clover_order_invalid", "list");
      listed.set(row.id, row);
    }
    if (rows.length < 100) break;
    if (offset === 1000) throw new PullError("clover_pull_limit", "list");
  }
  const output: ObjectValue[] = [];
  for (const [orderId] of listed) {
    const url = new URL(`${config.cloverBase}/v3/merchants/${config.merchant}/orders/${orderId}`);
    url.searchParams.set("expand", "lineItems,payments,orderType");
    const core = await cloverJson(url, config.token, fetcher, "order_core");
    if (core.id !== orderId) throw new PullError("clover_order_invalid", "order_core");
    url.searchParams.set("expand", "refunds,customers");
    const optional = await cloverJson(url, config.token, fetcher, "order_refunds");
    if (optional.id !== orderId) throw new PullError("clover_order_invalid", "order_refunds");
    output.push(snapshot({ ...core, refunds: optional.refunds, customers: optional.customers },
      config.merchant, config.onlineTypes));
  }
  return output;
}
