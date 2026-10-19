import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import StaffOffersPanel from "../components/StaffOffersPanel";
import { browserDeployment } from "../lib/supabase";
import { getStaffSupabase } from "../lib/staffSupabase";
import type { StaffOffersRpc } from "../lib/staffOffers";

// This page only calls Auth and read-only public RPCs. Existing CRM provider
// routes remain blocked in isolated Preview by StaffPage and the middleware.
// Default Supabase session storage is shared with the existing staff login.
export default function StaffOffersPage() {
  // Lazily create the isolated Auth client only when this provider-free page is
  // actually opened, never while public pages or the blocked legacy CRM load.
  const [client] = useState(getStaffSupabase);
  const offersRpc: StaffOffersRpc = useCallback((name, params) => client
    ? client.rpc(name, params)
    : Promise.resolve({ data: null, error: { code: "MISSING_CONFIG" } }), [client]);
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    document.title = "Nazar personel | Teklifler";
    const robots = document.createElement("meta");
    robots.name = "robots"; robots.content = "noindex,nofollow";
    document.head.appendChild(robots);
    if (!client) return () => robots.remove();
    let active = true;
    let authObserved = false;
    const { data: listener } = client.auth.onAuthStateChange((_event, next) => {
      authObserved = true;
      if (!active) return;
      setSession(next); setChecked(true); setMessage("");
      if (!next) { setEmail(""); setPassword(""); setBusy(false); }
    });
    void client.auth.getSession().then(({ data, error }) => {
      if (!active || authObserved) return;
      setSession(error ? null : data.session); setChecked(true);
      if (error) setMessage("Oturum kontrol edilemedi. Sayfayı yenileyin.");
    }).catch(() => {
      if (!active || authObserved) return;
      setChecked(true); setMessage("Oturum kontrol edilemedi. Sayfayı yenileyin.");
    });
    return () => { active = false; listener.subscription.unsubscribe(); robots.remove(); };
  }, [client]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    if (!client || busy) return;
    setBusy(true); setMessage("");
    try {
      const { data, error } = await client.auth.signInWithPassword({ email: email.trim(), password });
      if (error) setMessage(error.status === 429 ? "Giriş denemesi sınırına ulaşıldı. Daha sonra deneyin." : "Giriş yapılamadı. Personel email ve password bilgilerinizi kontrol edin.");
      else { setSession(data.session); setEmail(""); }
    } catch { setMessage("Giriş doğrulanamadı. Daha sonra tekrar deneyin."); }
    finally { setPassword(""); setBusy(false); }
  }

  async function signOut() {
    if (!client || busy) return;
    // Unmount the private catalogue immediately, including an in-flight read.
    setSession(null); setEmail(""); setPassword(""); setMessage(""); setBusy(true);
    try {
      const { error } = await client.auth.signOut({ scope: "local" });
      if (error) setMessage("Çıkış doğrulanamadı. Bu sayfadaki özel bilgiler temizlendi.");
    } catch { setMessage("Çıkış doğrulanamadı. Bu sayfadaki özel bilgiler temizlendi."); }
    finally { setBusy(false); }
  }

  return <main className="min-h-screen bg-brand-bg px-4 py-6 text-brand-ink sm:px-6">
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <a href="/staff" className="text-lg font-bold">Nazar personel</a>
        <nav aria-label="Personel sayfaları" className="flex flex-wrap items-center gap-3 text-sm">
          <a href="/staff" className="min-h-11 py-3 underline">Takip</a>
          <a href="/staff/crm" className="min-h-11 py-3 underline">CRM</a>
          <a href="/staff/offers" aria-current="page" className="min-h-11 py-3 font-bold">Teklifler</a>
          {session && <button type="button" disabled={busy} onClick={() => void signOut()}
            className="min-h-11 rounded-lg border border-brand-border bg-white px-3 py-2 disabled:opacity-50">Çıkış</button>}
        </nav>
      </header>
      {!client ? <p role="alert">Personel bağlantısı yapılandırılmadı.</p>
        : !checked ? <p role="status">Oturum kontrol ediliyor.</p>
        : session ? <StaffOffersPanel key={session.user.id} rpc={offersRpc} businessId={browserDeployment.businessId} />
        : <form onSubmit={signIn} className="max-w-md space-y-4 rounded-lg border border-brand-border bg-white p-5">
          <h1 className="text-2xl font-bold">Personel girişi</h1>
          <p className="text-sm text-stone-600">Tekliflerin tam listesi yalnız yetkili personele açıktır. Mevcut personel hesabınızı kullanın.</p>
          <label className="block font-medium">Email<input type="email" autoComplete="username" required value={email}
            onChange={(event) => setEmail(event.target.value)} className="mt-1 w-full rounded-lg border border-brand-border p-3" /></label>
          <label className="block font-medium">Password<input type="password" autoComplete="current-password" required value={password}
            onChange={(event) => setPassword(event.target.value)} className="mt-1 w-full rounded-lg border border-brand-border p-3" /></label>
          <button disabled={busy} className="min-h-11 rounded-lg bg-brand px-4 py-3 font-semibold text-white disabled:opacity-50">{busy ? "Giriş bekleniyor…" : "Giriş yap"}</button>
        </form>}
      {message && <p role="status" className="mt-4 rounded-lg border border-brand-border bg-white p-3">{message}</p>}
    </div>
  </main>;
}
