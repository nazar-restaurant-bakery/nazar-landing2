import { useMemo, useState } from "react";

type Segment = "all" | "vip" | "catering" | "kevin";
type Entry = { date: string; title: string; detail: string };
type Customer = {
  id: string; name: string; email: string; phone: string;
  vip: boolean; catering: boolean; kevin: boolean;
  consent: "confirmed" | "pending" | "none";
  orders: { number: string; total: string; date: string; detail: string }[];
  history: Entry[]; notes: string[]; followUp: string; owner: string;
};

// Synthetic records only. This page is mounted exclusively by Vite's local dev server.
const sampleCustomers: Customer[] = [
  {
    id: "deniz", name: "Deniz Kaya", email: "deniz@example.com", phone: "(203) 555-0142",
    vip: true, catering: true, kevin: true, consent: "confirmed",
    orders: [{ number: "#1048", total: "$186.00", date: "12 Oct", detail: "Catering tray · pickup 16 Oct" }],
    history: [
      { date: "12 Oct", title: "Catering order paid", detail: "20-guest tray · $186.00" },
      { date: "11 Oct", title: "VIP email confirmed", detail: "Confirmed through Klaviyo email link" },
      { date: "11 Oct", title: "Website signup", detail: "Facebook · Kevin campaign" },
    ],
    notes: ["Pack spicy sauce separately. Customer requested phone confirmation."],
    followUp: "Confirm catering pickup details", owner: "Yücel",
  },
  {
    id: "selin", name: "Selin Demir", email: "selin@example.com", phone: "(203) 555-0189",
    vip: true, catering: false, kevin: true, consent: "pending", orders: [],
    history: [{ date: "12 Oct", title: "VIP form submitted", detail: "Facebook · Kevin campaign" }],
    notes: [], followUp: "Wait for email confirmation", owner: "Talip",
  },
  {
    id: "ali", name: "Ali Arslan", email: "ali@example.com", phone: "(203) 555-0116",
    vip: false, catering: false, kevin: false, consent: "none",
    orders: [{ number: "#1041", total: "$29.98", date: "10 Oct", detail: "Restaurant menu · pickup" }],
    history: [{ date: "10 Oct", title: "Online order paid", detail: "Pickup · $29.98" }],
    notes: ["Prefers a pickup text message."], followUp: "No follow-up scheduled", owner: "—",
  },
];

const segments: { id: Segment; label: string }[] = [
  { id: "all", label: "All" }, { id: "vip", label: "VIP" },
  { id: "catering", label: "Catering" }, { id: "kevin", label: "Kevin" },
];

export default function CrmPreviewPage() {
  const [query, setQuery] = useState("");
  const [segment, setSegment] = useState<Segment>("all");
  const [selectedId, setSelectedId] = useState(sampleCustomers[0].id);
  const [notes, setNotes] = useState<Record<string, string[]>>({});
  const [draft, setDraft] = useState("");
  const [followUps, setFollowUps] = useState<Record<string, string>>({});
  const [showFollowUp, setShowFollowUp] = useState(false);

  const filtered = useMemo(() => sampleCustomers.filter((customer) => {
    const matches = `${customer.name} ${customer.email} ${customer.phone}`.toLowerCase().includes(query.trim().toLowerCase());
    return matches && (segment === "all" || customer[segment]);
  }), [query, segment]);
  const current = sampleCustomers.find((customer) => customer.id === selectedId) ?? filtered[0];
  const noteList = current ? [...current.notes, ...(notes[current.id] ?? [])] : [];
  const pending = sampleCustomers.filter((customer) => customer.followUp !== "No follow-up scheduled").length;

  function saveNote() {
    if (!current || !draft.trim()) return;
    setNotes((previous) => ({ ...previous, [current.id]: [...(previous[current.id] ?? []), draft.trim()] }));
    setDraft("");
  }

  return <main className="min-h-screen bg-[#f6f7f4] text-[#17231b]">
    <header className="border-b border-[#dfe7df] bg-white px-5 py-4">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-lg bg-[#176b3a] text-xl font-black text-white">N</span><strong>NAZAR STAFF</strong><span className="text-[#64736a]">/ Customers</span></div>
        <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-950">Local preview · sample data only</span>
      </div>
    </header>
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
      <div className="mb-5"><h1 className="text-2xl font-bold sm:text-3xl">Customer relationships</h1><p className="text-sm text-[#64736a]">A future single view of VIP, catering, ordering and staff follow-up</p></div>
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ["Customers", sampleCustomers.length], ["Confirmed VIP", sampleCustomers.filter((c) => c.consent === "confirmed").length],
          ["Follow-ups", pending], ["Kevin campaign", sampleCustomers.filter((c) => c.kevin).length],
        ].map(([label, value]) => <div key={label} className="rounded-xl border border-[#dfe7df] bg-white p-4"><span className="text-xs text-[#64736a]">{label}</span><strong className="mt-1 block text-2xl">{value}</strong></div>)}
      </div>
      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        <section className="rounded-xl border border-[#dfe7df] bg-white p-4" aria-label="Customer list">
          <h2 className="mb-3 text-lg font-semibold">Customers</h2>
          <input aria-label="Search customers" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search name, email or phone" className="mb-3 w-full rounded-lg border border-[#dfe7df] bg-[#f6f7f4] p-3" />
          <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Customer filters">{segments.map((item) => <button key={item.id} type="button" aria-pressed={segment === item.id} onClick={() => { setSegment(item.id); setSelectedId(""); setShowFollowUp(false); }} className={`rounded-lg border px-2.5 py-2 text-sm ${segment === item.id ? "border-[#176b3a] bg-[#176b3a] text-white" : "border-[#dfe7df] bg-white"}`}>{item.label}</button>)}</div>
          <div className="space-y-2">{filtered.map((customer) => <button key={customer.id} type="button" onClick={() => { setSelectedId(customer.id); setShowFollowUp(false); }} className={`w-full rounded-lg border p-3 text-left ${current?.id === customer.id ? "border-[#176b3a] bg-[#eaf6ee]" : "border-[#dfe7df] bg-white hover:bg-[#f6f7f4]"}`}><strong className="block">{customer.name}</strong><span className="text-xs text-[#64736a]">{[customer.vip && "VIP", customer.catering && "Catering", customer.kevin && "Kevin"].filter(Boolean).join(" · ") || "Restaurant customer"}</span></button>)}{filtered.length === 0 && <p className="text-sm text-[#64736a]">No matching customers.</p>}</div>
        </section>
        {current ? <section className="rounded-xl border border-[#dfe7df] bg-white p-4 sm:p-5" aria-label="Customer profile">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#dfe7df] pb-4"><div><h2 className="text-xl font-bold">{current.name}</h2><p className="break-all text-sm text-[#64736a]">{current.email} · {current.phone}</p></div><button type="button" onClick={() => setShowFollowUp((value) => !value)} className="rounded-lg bg-[#176b3a] px-3 py-2 font-semibold text-white">+ Follow-up task</button></div>
          {showFollowUp && <form onSubmit={(event) => { event.preventDefault(); setShowFollowUp(false); }} className="mt-3 flex flex-wrap gap-2 rounded-lg bg-[#f6f7f4] p-3"><input aria-label="Follow-up task" value={followUps[current.id] ?? ""} onChange={(event) => setFollowUps((previous) => ({ ...previous, [current.id]: event.target.value }))} placeholder="Follow-up task" className="min-w-48 flex-1 rounded-lg border p-2" required /><button className="rounded-lg bg-[#176b3a] px-3 py-2 text-white">Save locally</button></form>}
          <div className="my-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-lg bg-[#f6f7f4] p-3"><span className="text-xs text-[#64736a]">Relationship</span><strong className="mt-1 block">{[current.vip && "VIP", current.catering && "Catering"].filter(Boolean).join(" · ") || "Restaurant customer"}</strong></div>
            <div className="rounded-lg bg-[#f6f7f4] p-3"><span className="text-xs text-[#64736a]">Email consent · Klaviyo</span><strong className="mt-1 block">{current.consent === "confirmed" ? "Confirmed subscription" : current.consent === "pending" ? "Confirmation pending" : "No subscription"}</strong><span className="text-xs text-[#64736a]">Example status; live sync not connected</span></div>
            <div className="rounded-lg bg-[#f6f7f4] p-3"><span className="text-xs text-[#64736a]">Source</span><strong className="mt-1 block">{current.kevin ? "Facebook · Kevin campaign" : "Nazar website"}</strong></div>
            <div className="rounded-lg bg-[#f6f7f4] p-3"><span className="text-xs text-[#64736a]">Last order</span><strong className="mt-1 block">{current.orders[0] ? `${current.orders[0].number} · ${current.orders[0].total}` : "No linked order"}</strong><span className="text-xs text-[#64736a]">Example history; order sync not connected</span></div>
          </div>
          <div className="grid gap-5 md:grid-cols-[1.1fr_.9fr]"><div><h3 className="mb-2 font-semibold">Customer history</h3>{current.history.map((entry) => <div key={entry.title} className="border-t border-[#dfe7df] py-2"><strong className="block text-sm">{entry.date} · {entry.title}</strong><span className="text-xs text-[#64736a]">{entry.detail}</span></div>)}</div><div><h3 className="mb-2 font-semibold">Staff follow-up</h3><div className="rounded-lg bg-amber-50 p-3 text-sm"><strong>Next action</strong><p>{followUps[current.id] || current.followUp}</p><span className="text-xs">Owner: {current.owner}</span></div><h3 className="mb-2 mt-4 font-semibold">Internal notes</h3>{noteList.map((item, index) => <p key={`${index}-${item}`} className="border-t border-[#dfe7df] py-2 text-sm">{item}</p>)}<div className="mt-2 flex gap-2"><input aria-label="New internal note" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Add a note" className="min-w-0 flex-1 rounded-lg border border-[#dfe7df] p-2" /><button type="button" onClick={saveNote} disabled={!draft.trim()} className="rounded-lg bg-[#176b3a] px-3 py-2 text-white disabled:opacity-50">Add</button></div></div></div>
        </section> : <section className="rounded-xl border border-[#dfe7df] bg-white p-5">Select a customer to see a profile.</section>}
      </div>
      <p className="mt-5 text-xs text-[#64736a]">Preview actions remain in this browser session. They do not update Nazar customers or send messages.</p>
    </div>
  </main>;
}
