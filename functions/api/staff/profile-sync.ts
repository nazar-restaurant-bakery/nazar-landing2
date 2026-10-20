import { runProfileSync, type SyncContext, type SyncLease, type SyncOutcome, type SyncStore } from "../../_lib/klaviyoProfileSync.ts";
import { isRecord, isUuid, liveProfileProvider, mockProfileProvider, profileSyncConfig,
  profileSyncRpc, RpcUnavailable, type Fetcher, type ProfileSyncEnv } from "../../_lib/profileSyncRuntime.ts";

type Context = { request: Request; env: ProfileSyncEnv };
const headers = { "Cache-Control": "private, no-store", "Content-Type": "application/json" };
const reply = (status: number, code: string, fields: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ code, ...fields }), { status, headers });
const states = ["queued", "running", "retry", "succeeded", "failed", "blocked"];
const safeErrors = new Set(["provider_timeout", "provider_network", "provider_rate_limited", "provider_auth",
  "provider_rejected", "provider_unavailable", "unknown_write", "configuration_missing", "payload_changed",
  "customer_ineligible", "lease_expired", "attempts_exhausted", "provider_unsubscribed", "provider_suppressed"]);
function safeError(outcome: SyncOutcome) {
  if (outcome.status === "provider_blocked") return outcome.providerStatus === "unsubscribed" ? "provider_unsubscribed" : "provider_suppressed";
  if (!outcome.errorCode) return undefined;
  if (safeErrors.has(outcome.errorCode)) return outcome.errorCode;
  if (["local_ineligible", "invalid_local_context"].includes(outcome.errorCode)) return "customer_ineligible";
  if (outcome.errorCode === "local_context_changed") return "payload_changed";
  if (outcome.errorCode === "retry_exhausted") return "attempts_exhausted";
  if (["provider_network_unavailable", "local_store_unavailable"].includes(outcome.errorCode)) return "provider_network";
  if (outcome.uncertainWrite) return "unknown_write";
  return "provider_rejected";
}
const date = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));

/** Network is injectable for synthetic tests; no imports perform network work. */
export function profileSyncHandler(fetcher: Fetcher = fetch) {
  return async ({ request, env }: Context): Promise<Response> => {
    const url = new URL(request.url);
    if (!["GET", "POST"].includes(request.method)) return reply(405, "method_not_allowed");
    const origin = request.headers.get("Origin");
    if ((request.method === "POST" && origin !== url.origin) || (origin !== null && origin !== url.origin)) return reply(403, "forbidden");
    const bearer = request.headers.get("Authorization") || "";
    if (!/^Bearer [A-Za-z0-9_.-]{20,4096}$/.test(bearer)) return reply(401, "unauthorized");
    const config = profileSyncConfig(env, url.hostname);
    if (!config.readable) return reply(503, "connection_unavailable");
    const rpc = (name: string, args: Record<string, unknown>, staff = false) =>
      profileSyncRpc(config, name, args, staff ? bearer : null, fetcher);
    try {
      let allowed: unknown;
      try { allowed = await rpc("crm_staff_authorized_v1", {}, true); }
      catch (error) {
        if (error instanceof RpcUnavailable && [401,403].includes(error.status)) return reply(error.status,"forbidden");
        throw error;
      }
      if (allowed !== true) return reply(403, "forbidden");
      if (request.method === "GET") {
        const queue = await rpc("crm_profile_sync_queue_v1", { p_business_id: config.businessId }, true);
        if (!isRecord(queue) || !Array.isArray(queue.items) || !isRecord(queue.counts)) return reply(503, "queue_unavailable");
        const jobs = queue.items.map(item => {
          if (!isRecord(item) || !isUuid(item.jobId) || !states.includes(String(item.status))
            || !Number.isSafeInteger(item.attempts) || Number(item.attempts) < 0 || !date(item.updatedAt)
            || (item.nextAttemptAt !== null && !date(item.nextAttemptAt))
            || (item.lastErrorCode !== null && !safeErrors.has(String(item.lastErrorCode)))) throw new RpcUnavailable();
          return { id: item.jobId, status: item.status, attempts: item.attempts, updatedAt: item.updatedAt,
            nextAttemptAt: item.nextAttemptAt, lastErrorCode: item.lastErrorCode === null ? null : String(item.lastErrorCode).toUpperCase(), profileId: null };
        });
        if (Object.entries(queue.counts).some(([key, value]) => !/^[a-z_]{1,32}$/.test(key) || !Number.isSafeInteger(value) || Number(value) < 0)) return reply(503, "queue_unavailable");
        return reply(200, "ok", { mode: config.mode, jobs, counts: queue.counts });
      }
      if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json")) return reply(415, "invalid_content_type");
      if (Number(request.headers.get("Content-Length") || 0) > 256) return reply(413, "too_large");
      const text = await request.text();
      if (text.length > 256) return reply(413, "too_large");
      let body: unknown;
      try { body = JSON.parse(text); } catch { return reply(400, "invalid_action"); }
      if (!isRecord(body) || Object.keys(body).join() !== "action" || body.action !== "run") return reply(400, "invalid_action");
      if (config.mode === "disabled") return reply(503, "connection_unavailable");

      // One lease per explicit request bounds load and narrow live-test approval.
      // Account/customer selection is server configuration, never browser input.
      const parameters = { p_business_id: config.businessId, p_account: config.accountId, p_customer_id: config.onlyCustomerId };
      await rpc("klaviyo_profile_sync_enqueue_v1", { ...parameters, p_limit: 100 });
      const claim = await rpc("klaviyo_profile_sync_claim_v1", parameters);
      if (claim === null) return reply(200, "ok", { mode: config.mode, processed: 0, succeeded: 0, blocked: 0, retry: 0, failed: 0 });
      if (!isRecord(claim) || !isUuid(claim.jobId) || !isUuid(claim.leaseId)
        || !Number.isInteger(claim.attempt) || Number(claim.attempt) < 1 || Number(claim.attempt) > 6
        || !date(claim.leaseExpiresAt)) return reply(503, "run_unconfirmed");
      const lease: SyncLease = { jobId: claim.jobId, leaseId: claim.leaseId, attempt: Number(claim.attempt), leaseExpiresAt: String(claim.leaseExpiresAt) };
      let invalidatedStatus: string | null = null;
      let finalStatus: string | null = null;
      let acknowledged = false;
      const store: SyncStore = {
        async readContext(current): Promise<SyncContext | null> {
          const context = await rpc("klaviyo_profile_sync_context_v1", { p_job_id: current.jobId, p_lease_id: current.leaseId });
          if (!isRecord(context) || typeof context.eligible !== "boolean") throw new RpcUnavailable();
          if (!context.eligible) {
            invalidatedStatus = ["customer_ineligible", "payload_changed"].includes(String(context.reason))
              ? String(context.status) : "unconfirmed";
            return null;
          }
          if (context.jobId !== current.jobId || context.businessId !== config.businessId || context.account !== config.accountId
            || !isUuid(context.customerId) || (config.onlyCustomerId !== null && context.customerId !== config.onlyCustomerId)
            || !isRecord(context.profile) || !isRecord(context.eligibility)) throw new RpcUnavailable();
          const p = context.profile;
          const e = context.eligibility;
          if (e.emailStatus !== "subscribed" || e.isTest !== false || e.suppressedAt !== null
            || typeof p.email !== "string" || !date(p.createdAt)
            || (p.name !== null && typeof p.name !== "string") || (p.source !== null && typeof p.source !== "string")) throw new RpcUnavailable();
          const utm: Record<string, string> | null = p.utm === null ? null : {};
          if (isRecord(p.utm)) for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"])
            if (utm && typeof p.utm[key] === "string") utm[key] = p.utm[key] as string;
          const tags = p.tags;
          if (tags !== null && (!Array.isArray(tags) || tags.some(tag => typeof tag !== "string"))) throw new RpcUnavailable();
          return { businessId: config.businessId, customerId: context.customerId, accountId: config.accountId,
            email: p.email, name: p.name as string | null, source: p.source as string | null, registeredAt: String(p.createdAt),
            utm, tags: tags as string[] | null, emailStatus: e.emailStatus, isTest: e.isTest, suppressedAt: null };
        },
        async finish(current, outcome) {
          // context() already atomically invalidated this lease; do not finish it twice.
          if (invalidatedStatus) { finalStatus = invalidatedStatus; acknowledged = states.includes(invalidatedStatus); return; }
          const errorCode = safeError(outcome);
          const safeOutcome = { status: outcome.status, ...(errorCode ? { errorCode } : {}),
            ...(outcome.retryAfterSeconds !== undefined ? { retryAfterSeconds: outcome.retryAfterSeconds } : {}),
            ...(outcome.providerStatus ? { providerStatus: outcome.providerStatus } : {}),
            ...(outcome.providerUpdatedAt ? { providerUpdatedAt: outcome.providerUpdatedAt } : {}) };
          const result = await rpc("klaviyo_profile_sync_finish_v1", { p_job_id: current.jobId, p_lease_id: current.leaseId, p_outcome: safeOutcome });
          if (!isRecord(result) || !states.includes(String(result.status))) throw new RpcUnavailable();
          finalStatus = String(result.status); acknowledged = true;
        },
      };
      const provider = config.mode === "mock" ? mockProfileProvider(config.mockFailure) : liveProfileProvider(config, fetcher);
      await runProfileSync({ lease, store, provider, timeoutMs: 4000 });
      if (!acknowledged) return reply(503, "run_unconfirmed");
      return reply(200, "ok", { mode: config.mode, processed: 1, succeeded: Number(finalStatus === "succeeded"),
        blocked: Number(finalStatus === "blocked"), retry: Number(finalStatus === "retry" || finalStatus === "queued"), failed: Number(finalStatus === "failed") });
    } catch (error) {
      if (error instanceof RpcUnavailable && [401, 403].includes(error.status) && request.method === "GET") return reply(error.status, "forbidden");
      return reply(503, "connection_unavailable");
    }
  };
}
export const onRequestGet = profileSyncHandler();
export const onRequestPost = profileSyncHandler();
export function onRequest(): Response { return reply(405, "method_not_allowed"); }
