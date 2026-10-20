import { staffClient } from "./crmData";
import { safeCrmRequest } from "./crmUi";
import type { OpsActionName } from "./opsUi";
export * from "./opsUi";

const rpc = (name: string, params?: Record<string, unknown>) => safeCrmRequest(async () => {
  if (!staffClient) return { data: null, error: { code: "MISSING_CONFIG" } };
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 18_000);
  try {
    const query = staffClient.rpc(name, params);
    return await (query.abortSignal?.(controller.signal) ?? query);
  } finally { window.clearTimeout(timer); }
});
async function invoke(body: Record<string, unknown>) {
  if (!staffClient) return { data: null, error: { code: "MISSING_CONFIG" } };
  try {
    const response = await staffClient.functions.invoke("ops-collect", { body, timeout: 20_000 });
    if (response.error) {
      const context = (response.error as { context?: unknown }).context;
      return { data: null, error: { code: context instanceof Response && context.status === 403 ? "403" : "FUNCTION_UNAVAILABLE" } };
    }
    return { data: response.data?.action as unknown, error: null };
  } catch { return { data: null, error: { code: "NETWORK_ERROR" } }; }
}
export const opsData = {
  dashboard: () => rpc("ops_dashboard_v"),
  connections: () => rpc("ops_connections_v"),
  actions: () => rpc("ops_actions_v"),
  // The function calls ops_request_action with the user's JWT, then claims the
  // row before acknowledging it. A lost reply never creates a second queue row.
  request: (action: OpsActionName, payload: Record<string, unknown>) => invoke({ action, payload }),
  resume: (actionId: string) => invoke({ actionId }),
};
