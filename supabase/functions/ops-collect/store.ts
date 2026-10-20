import { projectUrl, OPS_BUCKET, uuid, type ActionName, type ClaimedAction, type Commission, type Environment, type SafeAction, type SafeResult } from "./contracts.ts";
import type { CollectorResult, MetricSnapshot } from "./collectors.ts";

export class OpsStore {
  readonly env: Environment;
  readonly request: typeof fetch;
  constructor(env: Environment, request: typeof fetch = fetch) { this.env = env; this.request = request; }
  private headers(service = true, bearer?: string) {
    const key = service ? this.env.SUPABASE_SERVICE_ROLE_KEY : this.env.SUPABASE_ANON_KEY;
    if (!key) throw new Error("ops_configuration_missing");
    return { apikey: key, Authorization: bearer || `Bearer ${key}`, "Content-Type": "application/json" };
  }
  async rpc<T>(name: string, args: Record<string, unknown> = {}, bearer?: string): Promise<T> {
    const response = await this.request(`${projectUrl(this.env)}/rest/v1/rpc/${name}`, { method: "POST", headers: this.headers(!bearer, bearer), body: JSON.stringify(args), signal: AbortSignal.timeout(12000) });
    if (!response.ok) {
      const code = await response.json().then((value: { code?: string }) => value.code).catch(() => undefined);
      throw new Error(response.status === 401 || response.status === 403 ? "forbidden" : code === "55000" || code === "PGRST202" ? "capability_not_connected" : code === "23505" ? "already_imported_or_busy" : "ops_source_unavailable");
    }
    return await response.json() as T;
  }
  async authenticate(bearer: string) {
    const response = await this.request(`${projectUrl(this.env)}/auth/v1/user`, { headers: this.headers(false, bearer), signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error("forbidden");
    const value: unknown = await response.json();
    const id = (value as { id?: unknown } | null)?.id;
    if (!uuid(id) || await this.rpc("crm_staff_authorized_v1", {}, bearer) !== true) throw new Error("forbidden");
    return id;
  }
  claim(actionId: string, userId: string) { return this.rpc<ClaimedAction | null>("ops_claim_action", { p_action_id: actionId, p_user_id: userId }); }
  async enqueue(action: ActionName, payload: Record<string, unknown>, bearer: string) {
    if (!uuid(payload.clientRequestId)) throw new Error("invalid_request_key");
    try { return await this.rpc<SafeAction>("ops_request_action", { p_action: action, p_payload: payload }, bearer); }
    catch (error) {
      // Recover a lost acknowledgement by its exact client key, never by time/action
      // guesses and never by issuing a second enqueue request.
      const history = await this.rpc<{ items: SafeAction[] }>("ops_actions_v", {}, bearer);
      const recovered = history.items.find(item => item.request_key === payload.clientRequestId && item.action === action);
      if (!recovered) throw error;
      return recovered;
    }
  }
  snapshot() { return this.rpc<{ metrics: MetricSnapshot[]; previous: MetricSnapshot[]; scheduler: Record<string, unknown>; capabilities: string[] }>("ops_internal_snapshot_v"); }
  async finish(action: ClaimedAction, status: "done" | "failed" | "not_connected", result: SafeResult, metrics: readonly MetricSnapshot[] = [], connections: readonly CollectorResult[] = []) {
    return this.rpc<boolean>("ops_finish_action", { p_action_id: action.id, p_claim_token: action.claim_token, p_status: status, p_result: result, p_metrics: metrics, p_connections: connections.map(item => ({ source: item.source, status: item.status, note: item.note || null, last_error: item.error || null, capabilities: item.capabilities || [] })) });
  }
  reserveExternal() { return this.rpc<boolean>("ops_reserve_external_request"); }
  commitCsv(action: ClaimedAction, data: Record<string, unknown>) { return this.rpc<Commission>("ops_commit_clover_csv", { p_action_id: action.id, p_claim_token: action.claim_token, p_data: data }); }
  setOffer(action: ClaimedAction) { return this.rpc<boolean>("ops_apply_offer_action", { p_action_id: action.id, p_claim_token: action.claim_token }); }
  commission(action: ClaimedAction) { return this.rpc<Commission>("ops_commission_report_data", { p_action_id: action.id, p_claim_token: action.claim_token }); }
  claimValid(action: ClaimedAction) { return this.rpc<boolean>("ops_action_claim_valid", { p_action_id: action.id, p_claim_token: action.claim_token }); }
  async uploadPdf(path: string, bytes: Uint8Array) {
    const response = await this.request(`${projectUrl(this.env)}/storage/v1/object/${OPS_BUCKET}/${path}`, { method: "POST", headers: { ...this.headers(), "Content-Type": "application/pdf", "x-upsert": "false" }, body: bytes as unknown as BodyInit, signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error("report_storage_unavailable");
  }
}
