import { useEffect, useRef, useState } from "react";

type Draft = { to: string; cc: string; subject: string; body: string };

export default function DecisionEmailDraft({ decisionId, accessToken }: { decisionId: string; accessToken: string }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setDraft(null); setBusy(false); setError(false); return () => { generation.current++; }; // eslint-disable-line react-hooks/exhaustive-deps -- mutable request generation
  }, [decisionId, accessToken]);
  async function prepare() {
    if (busy) return;
    const current = ++generation.current;
    setBusy(true); setDraft(null); setError(false);
    try {
      const response = await fetch("/api/staff/decision-email-draft", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
        body: JSON.stringify({ decisionId }),
      });
      if (!response.ok) throw new Error("Unavailable");
      const value = await response.json() as Draft;
      if (!value || ![value.to, value.cc, value.subject, value.body].every(item => typeof item === "string")) throw new Error("Invalid draft");
      if (current === generation.current) setDraft(value);
    } catch { if (current === generation.current) setError(true); }
    finally { if (current === generation.current) setBusy(false); }
  }
  return <div className="mt-2 space-y-2">
    <button type="button" className="staff-button staff-secondary" disabled={busy} onClick={() => void prepare()}>{busy ? "Taslak hazırlanıyor…" : "Karar e-postası taslağını hazırla"}</button>
    <p className="text-xs">E-posta gönderilmez; hazırlanan taslağı e-posta uygulamanızda açabilirsiniz.</p>
    {error && <p role="alert">Karar e-postası taslağı hazırlanamadı. Tekrar deneyin.</p>}
    {draft && <a className="block underline" href={`mailto:${encodeURIComponent(draft.to)}?${new URLSearchParams({ cc: draft.cc, subject: draft.subject, body: draft.body })}`}>E-posta uygulamasında aç</a>}
  </div>;
}
