import { freshOps, opsActor } from "../fixtures/opsDashboard.mjs";
const clone = value => structuredClone(value);
export function createOpsMock(getState, remember) {
  const data = freshOps();
  const payloads = new Map();
  const claimed = new Set();
  let sequence = 1;
  const response = (value, error = null) => ({ data: clone(value), error });
  function sourceReady(action) { return data.connections.some(c => c.capabilities.includes(action)); }
  function publicAction(row) { return clone(row); }
  function finish(id) {
    const row = data.actions.find(a => a.id === id);
    if (!row || row.status !== "running") return;
    row.status = "done"; row.finished_at = new Date().toISOString(); row.result = { message: "SYNTHETIC — tamamlandı" };
    if (row.action === "offer_set_active") {
      const payload = payloads.get(id);
      const offer = data.dashboard.offers.find(o => o.id === payload.offerId);
      if (offer) offer.active = payload.active;
    }
    payloads.delete(id);
  }
  function enqueue(action, payload) {
    remember("ops_request_action", { p_action: action, p_payload: payload });
    if (data.actions.some(row => row.action === action && ["queued", "running"].includes(row.status))) return response(null, { code: "23505" });
    const row = { id: "eeeeeeee-eeee-4eee-8eee-" + String(sequence++).padStart(12,"0"),
      request_key: payload.clientRequestId, action, requested_by: opsActor, requested_at: new Date().toISOString(),
      status: sourceReady(action) ? "queued" : "not_connected", result: {}, finished_at: sourceReady(action) ? null : new Date().toISOString() };
    data.actions.unshift(row); payloads.set(row.id, clone(payload));
    return response(publicAction(row));
  }
  async function invoke(body) {
    remember("edge.ops_collect", clone(body));
    let row;
    if (body.actionId) {
      row = data.actions.find(item => item.id === body.actionId && item.requested_by === opsActor);
      if (!row || row.status !== "queued") return response(null, { code: "ALREADY_CLAIMED" });
    } else {
      const queued = enqueue(body.action, body.payload);
      if (queued.error) return queued;
      row = data.actions.find(item => item.id === queued.data.id);
      if (getState().mode === "ops-enqueue-lost") throw Error("SYNTHETIC — queue reply lost before claim");
    }
    if (row.status === "not_connected") return response({ action: publicAction(row) });
    if (claimed.has(row.id)) return response(null, { code: "ALREADY_CLAIMED" });
    claimed.add(row.id); row.status = "running";
    if (getState().mode !== "ops-running") setTimeout(() => finish(row.id), 30);
    if (getState().mode === "ops-lost") throw Error("SYNTHETIC — running acknowledgement lost");
    return response({ action: publicAction(row) });
  }
  function rpc(name) {
    if (!["ops_dashboard_v","ops_connections_v","ops_actions_v"].includes(name)) return undefined;
    const mode = getState().mode;
    if (mode === "ops-denied") return response(null, { code:"42501" });
    if (mode === "ops-pending") return response(null, { code:"PGRST202" });
    if (mode === "ops-read-error") return response(null, { code:"NETWORK_ERROR" });
    if (name === "ops_dashboard_v") return response(mode === "ops-malformed" ? { metrics:null } : data.dashboard);
    if (name === "ops_connections_v") return response({ items:data.connections });
    return response({ items:data.actions.slice(0,50).map(publicAction) });
  }
  function seedQueued(otherActor = false) {
    const row = { id:"eeeeeeee-eeee-4eee-8eee-000000000099",request_key:"12121212-1212-4212-8212-121212121212",
      action:"collect",requested_by:otherActor?"ffffffff-ffff-4fff-8fff-ffffffffffff":opsActor,
      requested_at:new Date().toISOString(),status:"queued",result:{},finished_at:null };
    data.actions.unshift(row); payloads.set(row.id,{});
  }
  if (getState().mode === "ops-queued") seedQueued();
  if (getState().mode === "ops-other-queued") seedQueued(true);
  window.__opsMock = { snapshot: () => clone(data), finish, seedQueued };
  return { rpc, invoke };
}
