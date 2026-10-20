import { resolveServerEnvironment } from "../../src/lib/deploymentEnvironment.ts";

export type PullEnv = Record<string, string | undefined>;
export type Fetcher = typeof fetch;
type ObjectValue = Record<string, unknown>;
const cloverId = /^[A-Za-z0-9]{8,32}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const object = (x: unknown): x is ObjectValue => x !== null && typeof x === "object" && !Array.isArray(x);
const id = (x: unknown): x is string => typeof x === "string" && cloverId.test(x);

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

function elements(value: unknown): ObjectValue[] {
  if (Array.isArray(value)) return value.filter(object);
  if (object(value) && Array.isArray(value.elements)) return value.elements.filter(object);
  throw new Error("incomplete_collection");
}

function contact(customer: ObjectValue | undefined, single: string, plural: string): string | null {
  if (!customer) return null;
  if (typeof customer[single] === "string") return customer[single];
  const list = customer[plural];
  const first = object(list) && Array.isArray(list.elements) ? list.elements[0] : undefined;
  return object(first) && typeof first[single] === "string" ? first[single] : null;
}

/** Every required expansion is present before any database write. */
export function snapshot(detail: unknown, merchant: string, onlineTypes: string[]): ObjectValue {
  if (!object(detail) || !id(detail.id) || !Number.isSafeInteger(detail.createdTime)) throw new Error("invalid_order");
  const orderType = detail.orderType;
  const typeId = object(orderType) && id(orderType.id) ? orderType.id : null;
  if (!typeId) throw new Error("missing_order_type");
  const items = elements(detail.lineItems);
  const payments = elements(detail.payments);
  const refunds = elements(detail.refunds);
  const customers = elements(detail.customers);
  for (const row of [...items, ...payments, ...refunds]) if (!id(row.id)) throw new Error("invalid_child_id");
  for (const row of payments) if (!Number.isSafeInteger(row.amount) || Number(row.amount) < 0) throw new Error("invalid_payment");
  for (const row of refunds) if (!Number.isSafeInteger(row.amount) || Number(row.amount) < 0) throw new Error("invalid_refund");
  const isOnline = onlineTypes.includes(typeId);
  const customer = isOnline ? customers[0] : undefined;
  return { id: detail.id, merchantId: merchant, orderTypeId: typeId, online: isOnline,
    createdTime: detail.createdTime, modifiedTime: detail.modifiedTime ?? null,
    state: detail.state ?? null, total: detail.total ?? null,
    customerEmail: contact(customer, "emailAddress", "emailAddresses"),
    customerPhone: contact(customer, "phoneNumber", "phoneNumbers"),
    items, payments, refunds, raw: detail };
}

async function cloverJson(url: URL, token: string, fetcher: Fetcher): Promise<ObjectValue> {
  const response = await fetcher(url, { redirect: "manual", signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "NazarCRM/1.0" } });
  if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "clover_scope_or_auth" : "clover_unavailable");
  const body: unknown = await response.json();
  if (!object(body)) throw new Error("invalid_clover_response");
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
    const rows = elements(await cloverJson(url, config.token, fetcher));
    for (const row of rows) {
      if (!id(row.id) || !Number.isSafeInteger(row.createdTime)) throw new Error("invalid_order_list");
      listed.set(row.id, row);
    }
    if (rows.length < 100) break;
    if (offset === 1000) throw new Error("pull_limit_exceeded");
  }
  const output: ObjectValue[] = [];
  for (const [orderId] of listed) {
    const url = new URL(`${config.cloverBase}/v3/merchants/${config.merchant}/orders/${orderId}`);
    url.searchParams.set("expand", "lineItems,payments,refunds,customers,orderType");
    output.push(snapshot(await cloverJson(url, config.token, fetcher), config.merchant, config.onlineTypes));
  }
  return output;
}
