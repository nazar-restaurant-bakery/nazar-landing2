import {normalCouponProviders} from '../../_lib/couponAutomationTransport.ts';
import { couponConfig, couponStore, handleCouponProcessRequest, type CouponProvider } from "../../_lib/couponWelcome.ts";
type Context = { request: Request; env: Record<string, string | undefined> };

/** Default-disabled, machine-only entry. No public signup, staff action or timer invokes it. */
export async function onRequest(context: Context): Promise<Response> {
  const config = couponConfig(context.env, new URL(context.request.url).hostname);
  // Runtime mock never fabricates a positive consent record. Happy-path
  // synthetic fixtures are injected only by the isolated test harness.
  const mock: CouponProvider = { mode: "mock", async get() { throw new Error("mock_evidence_required"); },
    async eventAccount() { throw new Error("mock_evidence_required"); }, async event() { return { status: 202 }; } };
  const providers=config.mode==='live'?normalCouponProviders(config,fetch):{provider:mock};
  return handleCouponProcessRequest(context.request, config, { store: couponStore(config, fetch),...providers });
}
