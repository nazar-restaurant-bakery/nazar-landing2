import type { Fetcher, ProfileSyncConfig } from "./profileSyncRuntime.ts";

const MAX_RESPONSE_BYTES = 16 * 1024;
const TIMEOUT_MS = 5000;
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type ConnectionCode = "connection_verified" | "connection_auth_failed" | "connection_unconfirmed"
  | "connection_unavailable" | "connection_rate_limited";
export type ConnectionResult = {
  status: number;
  body: { code: ConnectionCode; readOnly: true; checkedAt: string; providerHttpStatus?: number };
};

/** Separate staff-only diagnostic: never enters the customer sync/queue path. */
export async function checkProfileSyncConnection(config: ProfileSyncConfig, fetcher: Fetcher): Promise<ConnectionResult> {
  const checkedAt = new Date().toISOString();
  let providerHttpStatus: number | undefined;
  const result = (status: number, code: ConnectionCode): ConnectionResult => ({ status,
    body: { code, readOnly: true, checkedAt, ...(providerHttpStatus !== undefined ? { providerHttpStatus } : {}) } });
  if (!config.readable || config.isolated || config.mode !== "live"
    || !/^pk_[A-Za-z0-9_-]{10,200}$/.test(config.providerKey) || !config.approvalId) {
    return result(503, "connection_unavailable");
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<ConnectionResult>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(result(503, "connection_unavailable")); }, TIMEOUT_MS);
  });
  const operation = (async (): Promise<ConnectionResult> => {
    try {
      const nonce = crypto.randomUUID();
      const url = new URL("https://a.klaviyo.com/api/profiles");
      url.searchParams.set("filter", `equals(email,${JSON.stringify(`k5-auth-${nonce}@example.invalid`)})`);
      url.searchParams.set("fields[profile]", "id");
      url.searchParams.set("page[size]", "1");
      const response = await fetcher(url.href, { method: "GET", redirect: "manual", credentials: "omit",
        signal: controller.signal, headers: { Accept: "application/vnd.api+json", revision: "2026-07-15",
          Authorization: `Klaviyo-API-Key ${config.providerKey}` } });
      providerHttpStatus = response.status;
      // Error bodies and Location/other provider headers are never exposed or followed.
      if (response.status === 401 || response.status === 403) return result(502, "connection_auth_failed");
      if (response.status === 429) return result(429, "connection_rate_limited");
      if (response.status !== 200) return result(502, "connection_unconfirmed");
      const declared = response.headers.get("Content-Length");
      if ((declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) || !response.body) {
        return result(502, "connection_unconfirmed");
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          length += next.value.byteLength;
          if (length > MAX_RESPONSE_BYTES) {
            void reader.cancel().catch(() => {});
            return result(502, "connection_unconfirmed");
          }
          chunks.push(next.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let body: unknown;
      try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
      catch { return result(502, "connection_unconfirmed"); }
      if (!record(body) || !Array.isArray(body.data) || body.data.length !== 0 || "errors" in body
        || (body.links !== undefined && (!record(body.links) || (body.links.next !== undefined && body.links.next !== null)))
        || (body.included !== undefined && (!Array.isArray(body.included) || body.included.length !== 0))) {
        return result(502, "connection_unconfirmed");
      }
      return result(200, "connection_verified");
    } catch {
      return result(503, "connection_unavailable");
    }
  })();
  try { return await Promise.race([operation, deadline]); }
  finally { clearTimeout(timer); }
}
