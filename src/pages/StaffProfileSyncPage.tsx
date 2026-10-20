import { useEffect, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import ProfileSyncPanel from "../components/staff/ProfileSyncPanel";
import { getStaffSupabase } from "../lib/staffSupabase";

// Share the existing staff session. The same-origin API checks active staff
// authorization before reading the queue or accepting a manual run.
export default function StaffProfileSyncPage() {
  const [client] = useState(getStaffSupabase);
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    document.title = "Nazar personel | Profil senkronu";
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
    // Unmount queue data immediately, also ignoring any late read/write result.
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
          <a href="/staff/offers" className="min-h-11 py-3 underline">Teklifler</a>
          <a href="/staff/profile-sync" aria-current="page" className="min-h-11 py-3 font-bold">Profil senkronu</a>
          {session && <button type="button" disabled={busy} onClick={() => void signOut()}
            className="min-h-11 rounded-lg border border-brand-border bg-white px-3 py-2 disabled:opacity-50">Çıkış</button>}
        </nav>
      </header>
      {!client ? <p role="alert">Personel bağlantısı yapılandırılmadı.</p>
        : !checked ? <p role="status">Oturum kontrol ediliyor.</p>
        : session ? <ProfileSyncPanel key={session.user.id} accessToken={session.access_token} />
        : <form onSubmit={signIn} className="max-w-md space-y-4 rounded-lg border border-brand-border bg-white p-5">
          <h1 className="text-2xl font-bold">Personel girişi</h1>
          <p className="text-sm text-stone-600">Profil senkron kuyruğu yalnız aktif, yetkili personele açıktır. Mevcut personel hesabınızı kullanın.</p>
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
