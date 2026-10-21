// The real SDK cannot enter this synthetic entry; unknown calls fail the test.
const state = { calls: [], failures: [], responses: {}, held: [], hold: false };
const clone = value => structuredClone(value);
export function getStaffSupabase() {
  return { async rpc(name, params) {
    state.calls.push({ name, params: clone(params) });
    if (name !== 'campaign_eligibility_check_v1'
      || params.p_business_id !== '11111111-1111-4111-8111-111111111111'
      || !/^SYNTHETICORDER\d+$/.test(params.p_clover_order_id)) {
      state.failures.push({ name, params: clone(params) }); throw Error('Unexpected RPC');
    }
    if (state.hold) await new Promise(resolve => state.held.push(resolve));
    const response = state.responses[params.p_clover_order_id];
    if (!response) { state.failures.push('Missing synthetic response'); throw Error('Missing response'); }
    return clone(response);
  } };
}
window.__eligibilityMock = {
  snapshot: () => clone({ calls: state.calls, failures: state.failures, held: state.held.length }),
  responses(value) { state.responses = clone(value); },
  hold() { state.hold = true; },
  release() { state.hold = false; const held = state.held.splice(0); for (const resolve of held) resolve(); },
};
