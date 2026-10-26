import { useEffect, useRef, useState, type FormEvent } from "react";
import { staffClient } from "../../lib/crmData";
import { staffPasswordError } from "../../lib/staffPasswordError";
import { staffCopy as c } from "../../lib/staffCopy";

export default function StaffSignIn({ onSigningIn }: { onSigningIn: () => void }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [method, setMethod] = useState<"password" | "link">("password");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  const [nextLink, setNextLink] = useState(0);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!staffClient || busy) return;
    if (method === "link" && Date.now() < nextLink) { setMessage(c.linkLimit); return; }
    setBusy(true); setMessage(""); onSigningIn();
    try {
      if (method === "link") {
        setNextLink(Date.now() + 60_000);
        const { error } = await staffClient.auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}${window.location.pathname === "/staff/crm" ? "/staff/crm" : "/staff"}` } });
        setMessage(error?.status === 429 ? c.linkLimit : error ? c.linkFailed : c.linkSent);
      } else {
        const { error } = await staffClient.auth.signInWithPassword({ email: email.trim(), password });
        setMessage(error?.status === 429 ? c.loginLimit : error ? c.loginFailed : "");
      }
    } catch { setMessage(c.loginNetwork); }
    finally { setPassword(""); setBusy(false); }
  }
  return <div className="mx-auto max-w-md px-4 py-16"><p className="text-xs font-semibold uppercase tracking-widest text-brand">Nazar Staff</p><h1 className="mt-2 text-3xl font-semibold">{c.loginTitle}</h1><form onSubmit={submit} className="staff-panel mt-6 space-y-4 p-5"><p className="text-sm text-stone-600">{c.loginHelp}</p><div className="flex gap-2">{(["password", "link"] as const).map(value => <button type="button" key={value} className={`staff-button ${method === value ? "" : "staff-secondary"}`} aria-pressed={method === value} disabled={busy} onClick={() => { setMethod(value); setMessage(""); }}>{value === "password" ? c.passwordMethod : c.linkMethod}</button>)}</div><label className="block"><span className="staff-label">{c.email}</span><input className="staff-input" type="email" required autoComplete="username" value={email} onChange={event => setEmail(event.target.value)} /></label>{method === "password" && <label className="block"><span className="staff-label">{c.password}</span><input className="staff-input" type="password" required autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></label>}<button className="staff-button" disabled={busy || !staffClient}>{busy ? c.saving : method === "password" ? c.login : c.sendLink}</button>{!staffClient && <p role="alert" className="text-sm text-red-800">{c.configMissing}</p>}{message && <p role="status" className="text-sm text-amber-800">{message}</p>}</form><p className="mt-5 text-xs text-stone-500">{c.privacy}</p></div>;
}

export function StaffPassword({ userId }: { userId: string }) {
  const alive = useRef(true);
  const pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [password, setPassword] = useState(""); const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault(); if (!staffClient || busy || pending.current) return;
    if (password.length < 12) { setMessage(c.passwordLength); return; }
    if (password !== confirmation) { setMessage(c.passwordMismatch); return; }
    pending.current = true; setBusy(true); setMessage("");
    let submitted = false;
    const errorMessage = (error: unknown) => ({ session: c.passwordSession, reauthentication: c.passwordReauthentication, same: c.passwordSame, weak: c.passwordWeak, limit: c.passwordLimit, denied: c.passwordDenied, unknown: submitted ? c.passwordUnknown : c.passwordCheckFailed })[staffPasswordError(error)];
    try {
      // Cached JWT/CRM authorization does not prove the Auth session still exists.
      const checked = await staffClient.auth.getUser();
      if (!alive.current) return;
      if (checked.error) { setMessage(errorMessage(checked.error)); return; }
      if (checked.data.user?.id !== userId) { setMessage(c.passwordCheckFailed); return; }
      submitted = true;
      const result = await staffClient.auth.updateUser({ password });
      if (alive.current) setMessage(result.error ? errorMessage(result.error) : c.passwordSaved);
      // No refresh, reauthentication email, or repeat PUT after rejection/lost response.
    } catch (error) { if (alive.current) setMessage(errorMessage(error)); }
    finally { pending.current = false; if (alive.current) { setPassword(""); setConfirmation(""); setBusy(false); } }
  }
  return <details className="staff-panel mt-4 p-4"><summary className="cursor-pointer text-sm font-semibold">{c.passwordTitle}</summary><form onSubmit={save} className="mt-4 max-w-md space-y-3"><label className="block"><span className="staff-label">{c.password}</span><input className="staff-input" type="password" autoComplete="new-password" required minLength={12} value={password} onChange={event => setPassword(event.target.value)} /></label><label className="block"><span className="staff-label">{c.passwordConfirm}</span><input className="staff-input" type="password" autoComplete="new-password" required minLength={12} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label><button className="staff-button" disabled={busy}>{busy ? c.saving : c.save}</button>{message && <p role="status" className="text-sm">{message}</p>}</form></details>;
}
