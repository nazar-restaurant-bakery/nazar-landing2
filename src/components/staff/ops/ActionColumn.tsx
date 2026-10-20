import { useState, type FormEvent } from "react";
import type { OpsAction, OpsActionName, OpsConnection, OpsDashboard } from "../../../lib/opsData";
import { opsCopy as c } from "../../../lib/staffCopy";
import CsvUploadDialog from "./CsvUploadDialog";

const actionNames: [OpsActionName, string, string][] = [["sync_clover_csv", c.syncClover, c.uploadHelp], ["retry_failed_job", c.retry, c.confirmRetry], ["offer_set_active", c.offer, c.confirmOffer], ["ads_set_status", c.ads, c.confirmAds], ["product_set_channel", c.product, c.confirmProduct], ["commission_report", c.report, c.confirmReport]];
export default function ActionColumn({ dashboard, connections, actions, selectedAction, onSelectAction, onRequest, busy, blocked, backendPending }: { dashboard: OpsDashboard | null; connections: OpsConnection[] | null; actions: OpsAction[] | null; selectedAction: OpsActionName | null; onSelectAction: (action: OpsActionName | null) => void; onRequest: (action: OpsActionName, payload: Record<string, unknown>) => Promise<boolean>; busy: boolean; blocked: boolean; backendPending: boolean }) {
  const [record, setRecord] = useState("");
  const [target, setTarget] = useState(false);
  const [month, setMonth] = useState("");
  const [approval, setApproval] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const pending = (name: OpsActionName) => !!actions?.some(action => action.action === name && ["queued", "running"].includes(action.status));
  const capable = (name: OpsActionName) => !!connections?.some(connection => connection.capabilities.includes(name));
  const disabled = busy || blocked || submitting || backendPending || !!(selectedAction && pending(selectedAction));
  const offers = dashboard?.offers.filter(offer => offer.approved || offer.is_test) || [];
  function select(action: OpsActionName) { setRecord(""); setTarget(false); setError(""); setApproval(""); onSelectAction(action === selectedAction ? null : action); }
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!selectedAction || disabled) return;
    let payload: Record<string, unknown> = {};
    if (capable(selectedAction)) {
      if (selectedAction === "retry_failed_job") {
        if (!dashboard?.failed_jobs.some(job => job.id === record)) { setError(c.chooseRequired); return; } payload = { actionId: record };
      } else if (selectedAction === "offer_set_active") {
        const offer = offers.find(item => item.id === record); if (!offer) { setError(c.chooseRequired); return; } payload = { offerId: offer.id, active: target, ...(approval.trim() ? { approvalReference: approval.trim() } : {}) };
      } else if (selectedAction === "ads_set_status") {
        const campaign = dashboard?.campaigns.find(item => item.id === record); if (!campaign) { setError(c.chooseRequired); return; } payload = { campaignId: campaign.id, source: campaign.source, status: target ? "ENABLED" : "PAUSED" };
      } else if (selectedAction === "product_set_channel") {
        const product = dashboard?.products.find(item => item.id === record); if (!product) { setError(c.chooseRequired); return; } payload = { productId: product.id, channel: product.channel, available: target };
      } else if (selectedAction === "commission_report") {
        if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { setError(c.chooseRequired); return; } payload = { month };
      }
    }
    setSubmitting(true); setError("");
    try { if (await onRequest(selectedAction, payload)) onSelectAction(null); }
    catch { setError(c.unknownAction); }
    finally { setSubmitting(false); }
  }
  const details = selectedAction === "collect" ? c.confirmCollect : actionNames.find(([name]) => name === selectedAction)?.[2];
  const title = selectedAction === "collect" ? c.collect : actionNames.find(([name]) => name === selectedAction)?.[1];
  const connected = selectedAction ? capable(selectedAction) : false;
  return <section className="staff-panel p-4" aria-label={c.actions}><h2 className="font-semibold">{c.actions}</h2><p className="mt-2 text-xs text-stone-500">{c.actionHelp}</p><div className="mt-4 space-y-2">{actionNames.map(([name, label]) => <button type="button" key={name} data-testid={`ops-action-${name}`} disabled={busy || submitting || pending(name)} aria-expanded={selectedAction === name} onClick={() => select(name)} className={`w-full rounded-lg border px-3 py-3 text-left text-sm font-medium ${capable(name) ? "border-brand-border bg-white text-brand-ink hover:bg-brand-bg" : "border-stone-200 bg-stone-50 text-stone-500"}`}>{pending(name) ? c.working : label}{!capable(name) && <span className="mt-1 block text-[11px] font-normal">{c.waiting}</span>}</button>)}</div>
    {selectedAction && <div className="mt-4 rounded-lg border border-brand-border bg-brand-bg p-3" data-testid="ops-action-confirmation"><h3 className="text-sm font-semibold">{title}</h3><p className="mt-2 text-xs text-stone-600">{details}</p>{backendPending ? <p className="mt-3 text-xs text-stone-500">{c.missingMigration}</p> : !connected && <p className="mt-3 text-xs text-stone-500">{c.actionDisabled}</p>}
      {selectedAction === "sync_clover_csv" && connected && !backendPending ? <CsvUploadDialog busy={busy || submitting} blocked={blocked || pending(selectedAction)} onUpload={payload => onRequest("sync_clover_csv", payload)} onClose={() => onSelectAction(null)} /> : <form onSubmit={submit} className="mt-3 space-y-3">
        {connected && selectedAction === "retry_failed_job" && <label className="block text-xs">{c.selectJob}<select required className="staff-input mt-1" disabled={disabled} value={record} onChange={event => setRecord(event.target.value)}><option value="">{c.choose}</option>{dashboard?.failed_jobs.map(job => <option key={job.id} value={job.id}>{job.name}</option>)}</select>{!dashboard?.failed_jobs.length && <span className="mt-1 block text-stone-500">{c.noChoices}</span>}</label>}
        {connected && selectedAction === "offer_set_active" && <><label className="block text-xs">{c.selectOffer}<select required className="staff-input mt-1" disabled={disabled} value={record} onChange={event => { setRecord(event.target.value); setTarget(!(offers.find(offer => offer.id === event.target.value)?.active)); }}><option value="">{c.choose}</option>{offers.map(offer => <option key={offer.id} value={offer.id}>{offer.name}</option>)}</select>{!offers.length && <span className="mt-1 block text-stone-500">{c.noChoices}</span>}</label><TargetChoice disabled={disabled} value={target} onChange={setTarget} positive={c.offerActive} negative={c.offerInactive} /><label className="block text-xs">{c.approvalReference}<input maxLength={200} className="staff-input mt-1" disabled={disabled} value={approval} onChange={event => setApproval(event.target.value)} /></label><p className="text-[11px] text-stone-500">{c.offerApproval}</p></>}
        {connected && selectedAction === "ads_set_status" && <><label className="block text-xs">{c.selectCampaign}<select required className="staff-input mt-1" disabled={disabled} value={record} onChange={event => setRecord(event.target.value)}><option value="">{c.choose}</option>{dashboard?.campaigns.map(campaign => <option key={`${campaign.source}-${campaign.id}`} value={campaign.id}>{campaign.name} · {campaign.source === "google_ads" ? "Google Ads" : "Meta"}</option>)}</select>{!dashboard?.campaigns.length && <span className="mt-1 block text-stone-500">{c.noChoices}</span>}</label><TargetChoice disabled={disabled} value={target} onChange={setTarget} positive={c.adsEnabled} negative={c.adsPaused} /></>}
        {connected && selectedAction === "product_set_channel" && <><label className="block text-xs">{c.selectProduct}<select required className="staff-input mt-1" disabled={disabled} value={record} onChange={event => setRecord(event.target.value)}><option value="">{c.choose}</option>{dashboard?.products.map(product => <option key={`${product.id}-${product.channel}`} value={product.id}>{product.name} · {product.channel}</option>)}</select>{!dashboard?.products.length && <span className="mt-1 block text-stone-500">{c.noChoices}</span>}</label><TargetChoice disabled={disabled} value={target} onChange={setTarget} positive={c.productVisible} negative={c.productHidden} /></>}
        {connected && selectedAction === "commission_report" && <label className="block text-xs">{c.reportMonth}<input className="staff-input mt-1" type="month" required value={month} disabled={disabled} onChange={event => setMonth(event.target.value)} /></label>}
        {error && <p role="alert" className="text-xs text-red-800">{error}</p>}<div className="flex flex-wrap gap-2"><button type="submit" className="staff-button" disabled={disabled}>{submitting ? c.working : c.run}</button><button type="button" className="staff-button staff-secondary" disabled={busy || submitting} onClick={() => onSelectAction(null)}>{c.cancel}</button></div>
      </form>}
    </div>}
  </section>;
}

function TargetChoice({ value, onChange, positive, negative, disabled }: { value: boolean; onChange: (value: boolean) => void; positive: string; negative: string; disabled: boolean }) { return <label className="block text-xs">{c.targetState}<select className="staff-input mt-1" value={String(value)} disabled={disabled} onChange={event => onChange(event.target.value === "true")}><option value="false">{negative}</option><option value="true">{positive}</option></select></label>; }
