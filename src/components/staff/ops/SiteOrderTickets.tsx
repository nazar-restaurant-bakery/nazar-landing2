import { useCallback, useEffect, useRef, useState } from "react";
import { staffClient } from "../../../lib/crmData";
import { nextTicketStatus, ticketLineLabel, validSiteOrderQueue, type SiteOrderTicket } from "../../../lib/siteOrderTickets";

type View = { status: "loading" | "ready" | "missing" | "denied" | "error"; items: SiteOrderTicket[] };
const initial: View = { status: "loading", items: [] };
const labels: Record<SiteOrderTicket["ticket_status"], string> = {
  new: "Yeni", needs_reschedule: "Tarih yeniden kararlaştırılacak", accepted: "Kabul edildi",
  preparing: "Hazırlanıyor", ready: "Hazır",
};

export default function SiteOrderTickets({ businessId, identity }: { businessId: string; identity: string }) {
  const [view, setView] = useState<View>(initial);
  const [writing, setWriting] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState("");
  const epoch = useRef(0);
  const writePending = useRef(false);

  const read = useCallback(async (manual = false) => {
    const current = ++epoch.current;
    setView(previous => ({ ...previous, status: "loading" }));
    if (!staffClient || !businessId) { setView({ status: "missing", items: [] }); return; }
    try {
      const result = await staffClient.rpc("site_order_ops_queue_v1", { p_business_id: businessId });
      if (current !== epoch.current) return;
      if (result.error?.code === "42501" || result.error?.code === "403") {
        setView({ status: "denied", items: [] }); return;
      }
      if (result.error?.code === "PGRST202") { setView({ status: "missing", items: [] }); return; }
      if (result.error || !validSiteOrderQueue(result.data, businessId)) {
        setView({ status: "error", items: [] }); return;
      }
      setView({ status: "ready", items: result.data.items });
      if (manual) { setUncertain(false); setMessage(""); }
    } catch {
      if (current === epoch.current) setView({ status: "error", items: [] });
    }
  }, [businessId]);

  useEffect(() => {
    queueMicrotask(() => { void read(); });
    return () => { epoch.current++; }; // eslint-disable-line react-hooks/exhaustive-deps -- invalidate the current request generation
  }, [read, identity]);

  async function advance(ticket: SiteOrderTicket) {
    const next = nextTicketStatus(ticket.ticket_status);
    if (!staffClient || !next || view.status !== "ready" || writePending.current || uncertain) return;
    writePending.current = true; setWriting(true); setMessage("");
    const current = epoch.current;
    try {
      const result = await staffClient.rpc("site_order_ticket_advance_v1", {
        p_business_id: businessId, p_ticket_id: ticket.ticket_id,
        p_expected_status: ticket.ticket_status, p_next_status: next,
      });
      if (current !== epoch.current) return;
      if (result.error || !result.data || typeof result.data !== "object" ||
          (result.data as { ticket_id?: string }).ticket_id !== ticket.ticket_id ||
          (result.data as { status?: string }).status !== next) {
        setUncertain(true); setMessage("Kayıt sonucu doğrulanamadı. Yenileyip güncel durumu kontrol edin.");
        return;
      }
      setMessage(next === "completed" ? "Teslim kaydedildi." : "Bilet güncellendi.");
      await read();
    } catch {
      if (current === epoch.current) {
        setUncertain(true); setMessage("Kayıt sonucu doğrulanamadı. Yenileyip güncel durumu kontrol edin.");
      }
    } finally {
      writePending.current = false; setWriting(false);
    }
  }

  return <section className="staff-panel p-4" aria-label="Site siparişleri ve mutfak biletleri" data-testid="site-order-tickets">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div><h2 className="text-lg font-semibold">Site siparişleri · mutfak</h2>
        <p className="text-xs text-stone-600">Yalnız doğrulanmış ödemeler. Tarih sorunu olanlar ayrıca görünür.</p></div>
      <button type="button" className="staff-button staff-secondary" disabled={writing} onClick={() => void read(true)}>Yenile</button>
    </div>
    {message && <p role="status" className="mt-3 text-sm">{message}</p>}
    {view.status === "loading" && <p role="status" className="mt-3">Siparişler okunuyor…</p>}
    {view.status === "missing" && <p role="status" className="mt-3">Mutfak işlem yolu henüz kurulmadı.</p>}
    {view.status === "denied" && <p role="status" className="mt-3">Bu işletmenin siparişlerine erişim yok.</p>}
    {view.status === "error" && <p role="status" className="mt-3">Siparişler doğrulanamadı. Yenileyin.</p>}
    {view.status === "ready" && view.items.length === 0 && <p className="mt-3 text-sm">Açık, ödemesi doğrulanmış site siparişi yok.</p>}
    {view.status === "ready" && <ul className="mt-3 grid gap-3 md:grid-cols-2">
      {view.items.map(ticket => {
        const next = ticket.order_status === "paid" ? nextTicketStatus(ticket.ticket_status) : null;
        return <li key={ticket.ticket_id} className="rounded-lg border border-brand-border p-4">
          <div className="flex justify-between gap-3"><strong>#{ticket.site_order_id.slice(0, 8)} · {ticket.customer_name}</strong><span>{labels[ticket.ticket_status]}</span></div>
          <p className="mt-1 text-sm">{ticket.department} · {ticket.fulfillment_method} · {new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "America/New_York" }).format(new Date(ticket.requested_at))}</p>
          <ul className="mt-2 list-disc pl-5 text-sm">{ticket.lines.map((line, i) => <li key={i}>{ticketLineLabel(line)}</li>)}</ul>
          {ticket.preparation_note && <p className="mt-2 text-sm">Not: {ticket.preparation_note}</p>}
          {ticket.order_status === "needs_reschedule" && <p role="status" className="mt-2 text-sm text-amber-800">Ödeme var; teslim zamanı yeniden kararlaştırılmalı. Hazırlık ilerletilemez.</p>}
          {next && <button type="button" className="staff-button mt-3" disabled={writing || uncertain} onClick={() => void advance(ticket)}>
            {next === "preparing" ? "Hazırlanıyor" : next === "ready" ? "Hazırlandı" : "Teslim edildi"}
          </button>}
        </li>;
      })}
    </ul>}
  </section>;
}
