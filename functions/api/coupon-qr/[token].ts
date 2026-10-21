// First-party, non-consuming image only. Never accepts a coupon code or payload.
import qrcode from "qrcode-generator";
import { resolveServerEnvironment } from "../../../src/lib/deploymentEnvironment.ts";

type Context = { request: Request; env: Record<string, string | undefined>; params: { token?: string } };
type Fetcher = typeof fetch;
const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" };
const failure = (status: number) => new Response(null, { status, headers });

export function couponQrHandler(fetcher: Fetcher = fetch) {
  return async ({ request, env, params }: Context): Promise<Response> => {
    if (request.method !== "GET") return new Response(null, { status: 405, headers: { ...headers, Allow: "GET" } });
    const match = /^([a-f0-9]{32})\.gif$/.exec(params.token || "");
    if (!match || new URL(request.url).search) return failure(404);
    const target = resolveServerEnvironment(env, new URL(request.url).hostname);
    const enabled = env[(target.isolated ? "TEST_" : "") + "COUPON_QR_ENABLED"] === "true";
    if (!enabled || !target.configured || !target.secret.startsWith("sb_secret_")) return failure(503);
    try {
      const response = await fetcher(`${target.url}/rest/v1/rpc/coupon_qr_payload_v1`, {
        method: "POST", redirect: "manual", signal: AbortSignal.timeout(5000),
        headers: { apikey: target.secret, "Content-Type": "application/json" },
        body: JSON.stringify({ p_token: match[1] }),
      });
      if (response.status === 404) return failure(404);
      if (!response.ok) return failure(503);
      const data: unknown = await response.json();
      const payload = data && typeof data === "object" && "payload" in data ? data.payload : null;
      if (typeof payload !== "string" || !/^VIPCOUPON1:[2-9A-HJ-NP-Z]{4}(?:-[2-9A-HJ-NP-Z]{4}){3}$/.test(payload)) return failure(404);
      const qr = qrcode(0, "M");
      qr.addData(payload, "Alphanumeric"); qr.make();
      const url = qr.createDataURL(6, 24);
      if (!url.startsWith("data:image/gif;base64,")) return failure(503);
      const bytes = Uint8Array.from(atob(url.slice("data:image/gif;base64,".length)), char => char.charCodeAt(0));
      return new Response(bytes, { status: 200, headers: { ...headers, "Content-Type": "image/gif" } });
    } catch { return failure(503); }
  };
}

export const onRequestGet = couponQrHandler();
