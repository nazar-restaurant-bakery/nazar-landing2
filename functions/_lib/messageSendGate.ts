/**
 * Shared campaign/flow gate model. Trusted stores wrap the service-only K6 RPCs.
 * This module includes no network client, provider URL, key, scheduler or live
 * transport. Its injected transport is explicitly synthetic; accepted means a
 * simulated acknowledgement, never evidence that a customer received email.
 */
export type MessageKind = "campaign" | "flow";
export type MessageSendIntent = {
  businessId: string;
  customerId: string;
  messageKey: string;
  messageKind: MessageKind;
  payloadSha256: string;
};
export type MessageDispatchContext = MessageSendIntent & {
  leaseId: string;
  dispatchExpiresAt: string;
  email: string;
  emailStatus: "subscribed";
  isTest: false;
  suppressedAt: null;
  providerBlockedStatus: null;
};
export interface MessageSendStore {
  /** message_send_reserve_v1: no caller-supplied person, consent or window. */
  reserve(intent: MessageSendIntent): Promise<unknown>;
  /** message_send_claim_v1: durable dispatch intent; a claim is never renewed. */
  claim(reservationId: string): Promise<unknown>;
  /** message_send_context_v1: ONE consuming, current-state authorization. */
  context(reservationId: string, leaseId: string): Promise<unknown>;
  /** message_send_finalize_v1: terminal receipt; no retry or quota release. */
  finalize(reservationId: string, leaseId: string, outcome: "sent" | "unknown" | "blocked"): Promise<unknown>;
}
export type SyntheticMessageRequest = {
  reservationId: string;
  businessId: string;
  customerId: string;
  messageKey: string;
  messageKind: MessageKind;
  payloadSha256: string;
  email: string;
  signal: AbortSignal;
};
export interface SyntheticMessageTransport {
  mode: "synthetic";
  send(request: SyntheticMessageRequest): Promise<{ accepted: true }>;
}
const denialCodes = ["already_processed", "idempotency_conflict", "customer_ineligible", "frequency_limited",
  "settings_disabled", "not_found", "not_claimable", "reservation_expired", "identity_changed",
  "not_claimed", "already_dispatched", "lease_expired"] as const;
type DenialCode = typeof denialCodes[number];
export type MessageSendGateCode = DenialCode | "invalid_intent" | "invalid_transport" | "store_unavailable"
  | "reservation_unconfirmed" | "claim_unconfirmed" | "context_unconfirmed" | "invalid_context"
  | "transport_unconfirmed" | "transport_timeout" | "finalize_unconfirmed" | "sent";
export type MessageSendGateResult = {
  status: "sent" | "blocked" | "unknown" | "unavailable";
  code: MessageSendGateCode;
  synthetic: true;
  reservationId?: string;
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const uuid = (value: unknown): value is string => typeof value === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const instant = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const denial = (value: unknown): value is DenialCode =>
  typeof value === "string" && (denialCodes as readonly string[]).includes(value);

function validIntent(value: unknown): value is MessageSendIntent {
  return object(value) && Object.keys(value).sort().join() === "businessId,customerId,messageKey,messageKind,payloadSha256"
    && uuid(value.businessId) && uuid(value.customerId)
    && typeof value.messageKey === "string" && /^[A-Za-z0-9_.:-]{8,120}$/.test(value.messageKey)
    && (value.messageKind === "campaign" || value.messageKind === "flow")
    && typeof value.payloadSha256 === "string" && /^[a-f0-9]{64}$/.test(value.payloadSha256);
}

function matchingContext(value: unknown, intent: MessageSendIntent, leaseId: string,
  expiresAt: string, now: number): value is MessageDispatchContext {
  return object(value) && value.businessId === intent.businessId && value.customerId === intent.customerId
    && value.messageKey === intent.messageKey && value.messageKind === intent.messageKind
    && value.payloadSha256 === intent.payloadSha256 && value.leaseId === leaseId
    && value.dispatchExpiresAt === expiresAt && Date.parse(expiresAt) > now
    && value.emailStatus === "subscribed" && value.isTest === false && value.suppressedAt === null
    && value.providerBlockedStatus === null && typeof value.email === "string"
    && value.email === value.email.trim().toLowerCase() && value.email.length <= 254
    && /^[^\s<>"\\@]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(value.email);
}

/**
 * Database reservation/claim/context RPCs own person identity and the tenant's
 * rolling quota. Neither message kind nor an invented idempotency key can
 * override them. Every async acknowledgement is required before advancing;
 * missing/uncertain acknowledgements never trigger a second dispatch.
 */
export async function runMessageSendGate({ intent, store, transport, now = Date.now, timeoutMs = 5000 }: {
  intent: MessageSendIntent;
  store: MessageSendStore;
  transport: SyntheticMessageTransport;
  now?: () => number;
  timeoutMs?: number;
}): Promise<MessageSendGateResult> {
  const result = (status: MessageSendGateResult["status"], code: MessageSendGateCode,
    reservationId?: string): MessageSendGateResult => ({ status, code, synthetic: true,
    ...(reservationId ? { reservationId } : {}) });
  if (!validIntent(intent) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10000) {
    return result("blocked", "invalid_intent");
  }
  if (!transport || transport.mode !== "synthetic" || typeof transport.send !== "function") {
    return result("blocked", "invalid_transport");
  }
  // Copy only the agreed fields, and detach the caller's mutable input before
  // the first await. Recipient identity comes exclusively from the DB context.
  const snapshot: MessageSendIntent = Object.freeze({ businessId: intent.businessId.toLowerCase(),
    customerId: intent.customerId.toLowerCase(), messageKey: intent.messageKey,
    messageKind: intent.messageKind, payloadSha256: intent.payloadSha256 });
  let reserved: unknown;
  try { reserved = await store.reserve(snapshot); }
  catch { return result("unavailable", "store_unavailable"); }
  if (object(reserved) && reserved.allowed === false && denial(reserved.code)) {
    return result("blocked", reserved.code);
  }
  if (!object(reserved) || reserved.allowed !== true || reserved.status !== "reserved"
    || !["reserved", "already_reserved"].includes(String(reserved.code)) || !uuid(reserved.reservationId)
    || (reserved.idempotent !== undefined && typeof reserved.idempotent !== "boolean")) {
    return result("unavailable", "reservation_unconfirmed");
  }
  const reservationId = reserved.reservationId;
  let claimed: unknown;
  try { claimed = await store.claim(reservationId); }
  catch { return result("unknown", "claim_unconfirmed", reservationId); }
  if (object(claimed) && claimed.allowed === false && denial(claimed.code)) {
    return result("blocked", claimed.code, reservationId);
  }
  if (!object(claimed) || claimed.allowed !== true || claimed.code !== "claimed"
    || claimed.status !== "claimed" || claimed.reservationId !== reservationId
    || !uuid(claimed.leaseId) || !instant(claimed.dispatchExpiresAt)) {
    return result("unknown", "claim_unconfirmed", reservationId);
  }
  const leaseId = claimed.leaseId;
  const expiresAt = claimed.dispatchExpiresAt;
  const finish = async (outcome: "sent" | "unknown" | "blocked", code: MessageSendGateCode): Promise<MessageSendGateResult> => {
    try {
      const receipt = await store.finalize(reservationId, leaseId, outcome);
      if (!object(receipt) || !["sent", "unknown", "blocked"].includes(String(receipt.status))
        || typeof receipt.idempotent !== "boolean") return result("unknown", "finalize_unconfirmed", reservationId);
      if (receipt.status !== outcome) return result("unknown", "finalize_unconfirmed", reservationId);
      return result(outcome, code, reservationId);
    } catch {
      // A missing sent receipt may already have committed. Do not send again
      // or issue a contradictory second finalize after this lost ACK.
      return result("unknown", "finalize_unconfirmed", reservationId);
    }
  };

  let authorization: unknown;
  try { authorization = await store.context(reservationId, leaseId); }
  catch { return finish("unknown", "context_unconfirmed"); }
  if (object(authorization) && authorization.allowed === false && denial(authorization.code)) {
    if (authorization.status === "unknown") return result("unknown", authorization.code, reservationId);
    if (authorization.status === "blocked") return result("blocked", authorization.code, reservationId);
    if (authorization.status === "sending") return finish("unknown", authorization.code);
    return result("blocked", authorization.code, reservationId);
  }
  if (!object(authorization) || authorization.allowed !== true || authorization.code !== "dispatch_authorized"
    || authorization.status !== "sending" || authorization.reservationId !== reservationId
    || !matchingContext(authorization.context, snapshot, leaseId, expiresAt, now())) {
    return finish("blocked", "invalid_context");
  }
  const context = authorization.context;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    // The consuming current-state context is the last await before the one
    // injected synthetic dispatch. No second context call can reuse this grant.
    const acknowledgement: unknown = await Promise.race([
      transport.send({ reservationId, businessId: snapshot.businessId, customerId: snapshot.customerId,
        messageKey: snapshot.messageKey, messageKind: snapshot.messageKind, payloadSha256: snapshot.payloadSha256,
        email: context.email, signal: controller.signal }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error("synthetic_dispatch_timeout")); }, timeoutMs);
      }),
    ]);
    if (!object(acknowledgement) || Object.keys(acknowledgement).join() !== "accepted" || acknowledgement.accepted !== true) {
      return finish("unknown", "transport_unconfirmed");
    }
    return finish("sent", "sent");
  } catch {
    return finish("unknown", timedOut ? "transport_timeout" : "transport_unconfirmed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
