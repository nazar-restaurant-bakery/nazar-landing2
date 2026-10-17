import { useEffect, useState, type ReactNode } from "react";

type Stage = "new" | "reviewing" | "approved" | "sent" | "accepted";

const stageLabel: Record<Stage, string> = {
  new: "New request",
  reviewing: "Menu and price review",
  approved: "Quote ready",
  sent: "Quote sent",
  accepted: "Customer accepted",
};

const example = {
  reference: "CAT-DEMO-001",
  customer: "Preview Customer",
  contact: "preview-customer@example.com",
  eventDate: "October 20, 2026",
  pickup: "Pickup at Nazar; time to be confirmed",
  selection: ["Mixed Grill tray · 30 guests · 1", "Rice Pilav tray · 20 guests · 1"],
  message: "Please suggest a vegetarian option for five guests.",
};

function panel(title: string, children: ReactNode) {
  return <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
    <h2 className="text-lg font-bold text-stone-900">{title}</h2>
    <div className="mt-4">{children}</div>
  </section>;
}

export default function CateringOpsPreviewPage() {
  const [stage, setStage] = useState<Stage>("new");
  const [menu, setMenu] = useState("");
  const [price, setPrice] = useState("");
  const [customerReply, setCustomerReply] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    document.title = "Nazar catering quote workflow preview";
    const robots = document.createElement("meta");
    robots.name = "robots";
    robots.content = "noindex,nofollow";
    document.head.appendChild(robots);
    return () => robots.remove();
  }, []);

  function saveDecision() {
    const amount = Number(price);
    if (!menu.trim() || !Number.isFinite(amount) || amount <= 0) {
      setNotice("Enter the final menu and a valid price first.");
      return;
    }
    setStage("approved");
    setNotice("Yücel's menu and price decision is ready for customer review in this preview.");
  }

  function advance(next: Stage) {
    setStage(next);
    setNotice(next === "sent"
      ? "Preview only: no customer message was sent."
      : next === "accepted"
        ? "Preview only: customer acceptance was simulated; no payment was started."
        : "Request moved to menu and price review.");
  }

  return <main className="min-h-screen bg-[#f6f7f4] px-4 py-7 text-stone-900">
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-widest text-green-800">Nazar catering · local preview</p>
          <h1 className="mt-1 text-3xl font-bold">Quote management</h1>
          <p className="mt-2 max-w-3xl text-sm text-stone-600">A customer quote request belongs here first. The customer follow-up view tracks the same request after Nazar acts on it.</p>
        </div>
        <span className="rounded-full bg-amber-100 px-3 py-2 text-xs font-bold text-amber-900">Sample data · no emails or payments</span>
      </header>

      <div className="mb-5 grid gap-2 sm:grid-cols-5">
        {(["new", "reviewing", "approved", "sent", "accepted"] as Stage[]).map((item, index) =>
          <div key={item} className={`rounded-xl border px-3 py-3 text-sm ${stage === item ? "border-green-800 bg-green-50 font-bold text-green-900" : "border-stone-200 bg-white text-stone-600"}`}>
            <span className="mr-2 text-xs">{index + 1}</span>{stageLabel[item]}
          </div>)}
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(280px,1fr)]">
        <div className="space-y-5">
          {panel("Incoming catering request", <>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold">{example.reference}</span>
              <span className="rounded-full bg-amber-100 px-3 py-1 text-xs font-bold text-amber-900">{stageLabel[stage]}</span>
            </div>
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-stone-500">Customer</dt><dd className="font-semibold">{example.customer}</dd></div>
              <div><dt className="text-stone-500">Contact</dt><dd className="font-semibold">{example.contact}</dd></div>
              <div><dt className="text-stone-500">Event date</dt><dd className="font-semibold">{example.eventDate}</dd></div>
              <div><dt className="text-stone-500">Delivery method</dt><dd className="font-semibold">{example.pickup}</dd></div>
            </dl>
            <h3 className="mt-5 text-sm font-bold">Requested items</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{example.selection.map((item) => <li key={item}>{item}</li>)}</ul>
            <div className="mt-4 rounded-xl bg-stone-50 p-3 text-sm"><strong>Customer message:</strong> {example.message}</div>
            <p className="mt-3 text-xs text-stone-500">A form-only request would show the message here even with no trays selected. Tray and form choices appear together when combined.</p>
            {stage === "new" && <button type="button" onClick={() => advance("reviewing")} className="mt-4 rounded-lg bg-green-800 px-4 py-2 font-semibold text-white">Start review</button>}
          </>)}

          {panel("Yücel's menu and price decision", <>
            <label className="block text-sm font-semibold">Final menu
              <textarea value={menu} onChange={(event) => setMenu(event.target.value)} disabled={stage === "sent" || stage === "accepted"} placeholder="Enter the approved menu and quantities" className="mt-1 min-h-24 w-full rounded-lg border p-3 font-normal disabled:bg-stone-50" />
            </label>
            <label className="mt-3 block text-sm font-semibold">Final price ($)
              <input type="number" min="0.01" step="0.01" value={price} onChange={(event) => setPrice(event.target.value)} disabled={stage === "sent" || stage === "accepted"} placeholder="0.00" className="mt-1 block w-full rounded-lg border p-3 font-normal disabled:bg-stone-50" />
            </label>
            {(stage === "reviewing" || stage === "approved") && <button type="button" onClick={saveDecision} className="mt-4 rounded-lg bg-green-800 px-4 py-2 font-semibold text-white">Save Yücel's decision</button>}
            {stage === "new" && <p className="mt-3 text-sm text-stone-500">Review the incoming request before preparing a price.</p>}
          </>)}

          {panel("Customer quote", <>
            {stage === "approved" || stage === "sent" || stage === "accepted" ? <>
              <p className="whitespace-pre-wrap text-sm"><strong>Final menu:</strong> {menu.trim()}</p>
              <p className="mt-2 text-sm"><strong>Price:</strong> ${Number(price).toFixed(2)}</p>
              <p className="mt-2 text-xs text-stone-500">The customer quote needs the confirmed menu, price, pickup details and an acceptance action. Payment is a later step.</p>
              {stage === "approved" && <button type="button" onClick={() => advance("sent")} className="mt-4 rounded-lg bg-green-800 px-4 py-2 font-semibold text-white">Mark quote sent · preview</button>}
              {stage === "sent" && <button type="button" onClick={() => advance("accepted")} className="mt-4 rounded-lg border border-green-800 px-4 py-2 font-semibold text-green-800">Simulate customer acceptance</button>}
            </> : <p className="text-sm text-stone-500">No quote can be sent until Yücel confirms the menu and price.</p>}
          </>)}
        </div>

        <div className="space-y-5">
          {panel("Talip's customer follow-up view", <>
            <p className="text-sm">This is the same request, shown for tracking rather than price approval.</p>
            <dl className="mt-4 space-y-3 text-sm">
              <div><dt className="text-stone-500">Request</dt><dd className="font-semibold">{example.reference}</dd></div>
              <div><dt className="text-stone-500">Current stage</dt><dd className="font-semibold">{stageLabel[stage]}</dd></div>
              <div><dt className="text-stone-500">Yücel's decision</dt><dd className="font-semibold">{stage === "new" || stage === "reviewing" ? "Pending" : `$${Number(price).toFixed(2)} · ${menu.trim()}`}</dd></div>
              <div><dt className="text-stone-500">Next follow-up</dt><dd className="font-semibold">{stage === "approved" ? "Send approved quote" : stage === "sent" ? "Await customer reply" : stage === "accepted" ? "Coordinate next order step" : "Await menu and price decision"}</dd></div>
            </dl>
            <label className="mt-4 block text-sm font-semibold">Customer reply or follow-up note
              <textarea value={customerReply} onChange={(event) => setCustomerReply(event.target.value)} placeholder="Preview note" className="mt-1 min-h-24 w-full rounded-lg border p-3 font-normal" />
            </label>
          </>)}
          {notice && <p role="status" className="rounded-xl border border-green-200 bg-green-50 p-3 text-sm text-green-900">{notice}</p>}
          <button type="button" onClick={() => { setStage("new"); setMenu(""); setPrice(""); setCustomerReply(""); setNotice("Preview reset."); }} className="rounded-lg border border-stone-300 bg-white px-4 py-2 text-sm font-semibold">Reset preview</button>
        </div>
      </div>
    </div>
  </main>;
}
