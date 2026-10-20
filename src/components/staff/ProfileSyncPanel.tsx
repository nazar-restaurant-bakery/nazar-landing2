import { useCallback, useEffect, useRef, useState } from "react";
import {
  checkProfileSyncConnection, profileSyncConnectionErrorLabel,
  profileSyncDate, profileSyncShortId, profileSyncStatusLabel, readProfileSyncQueue, runProfileSync,
  type ProfileSyncConnectionCheck, type ProfileSyncFetch, type ProfileSyncQueue, type ProfileSyncRun,
} from "../../lib/profileSyncUi";

type ReadState = ({ status: "loading" | "denied" | "unavailable" } | { status: "ready"; data: ProfileSyncQueue })
  & { accessToken: string; fetcher: ProfileSyncFetch };
const defaultFetch: ProfileSyncFetch = (input, options) => fetch(input, options);

export default function ProfileSyncPanel({ accessToken, fetcher = defaultFetch }: {
  accessToken: string;
  fetcher?: ProfileSyncFetch;
}) {
  const [state, setState] = useState<ReadState>({ status: "loading", accessToken, fetcher });
  const [running, setRunning] = useState(false);
  const [checking, setChecking] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [runResult, setRunResult] = useState<ProfileSyncRun | null>(null);
  const [checkResult, setCheckResult] = useState<ProfileSyncConnectionCheck | null>(null);
  const [message, setMessage] = useState("");
  const generation = useRef(0);
  const active = useRef(false);
  const operation = useRef<{ kind: "refresh" | "run" | "check"; generation: number } | null>(null);
  const sameScope = state.accessToken === accessToken && state.fetcher === fetcher;
  const readStatus = sameScope ? state.status : "loading";
  const ready = sameScope && state.status === "ready" ? state.data : null;

  const refresh = useCallback(async () => {
    if (!active.current || operation.current) return;
    const current = { kind: "refresh" as const, generation: generation.current };
    operation.current = current;
    setState({ status: "loading", accessToken, fetcher });
    setCheckResult(null);
    const result = await readProfileSyncQueue(fetcher, accessToken);
    if (!active.current || operation.current !== current || current.generation !== generation.current) return;
    operation.current = null;
    if (result.status === "ok") {
      setState({ status: "ready", data: result.data, accessToken, fetcher }); setNeedsRefresh(false); setMessage("");
    } else {
      setState({ status: result.status, accessToken, fetcher });
      if (result.status === "denied") { setRunResult(null); setMessage(""); }
    }
  }, [accessToken, fetcher]);

  useEffect(() => {
    active.current = true;
    const current = ++generation.current;
    operation.current = null;
    queueMicrotask(() => {
      if (!active.current || current !== generation.current) return;
      setRunning(false); setChecking(false); setNeedsRefresh(false); setRunResult(null); setCheckResult(null); setMessage("");
      void refresh();
    });
    return () => { active.current = false; generation.current += 1; operation.current = null; };
  }, [refresh]);

  async function run() {
    if (!active.current || operation.current || running || checking || needsRefresh || !ready || ready.mode === "disabled") return;
    const current = { kind: "run" as const, generation: generation.current };
    operation.current = current; setRunning(true); setNeedsRefresh(true); setRunResult(null); setCheckResult(null); setMessage("");
    const result = await runProfileSync(fetcher, accessToken);
    if (!active.current || operation.current !== current || current.generation !== generation.current) return;
    operation.current = null;
    setRunning(false);
    if (result.status === "denied") {
      setState({ status: "denied", accessToken, fetcher }); setRunResult(null); setMessage("");
    } else if (result.status !== "ok") {
      setMessage("İşlem sonucu doğrulanamadı. Yeniden çalıştırmadan önce Yenile ile kuyruğu kontrol et.");
    } else {
      setRunResult(result.data);
      if (result.data.mode === "disabled") setMessage("Bağlantı bekliyor. Senkron işlemi etkin değil.");
      await refresh();
    }
  }

  async function checkConnection() {
    if (!active.current || operation.current || running || checking || !ready || ready.mode !== "live") return;
    const current = { kind: "check" as const, generation: generation.current };
    operation.current = current; setChecking(true); setCheckResult(null); setMessage("");
    const result = await checkProfileSyncConnection(fetcher, accessToken);
    if (!active.current || operation.current !== current || current.generation !== generation.current) return;
    operation.current = null; setChecking(false);
    if (result.status === "denied") {
      setState({ status: "denied", accessToken, fetcher }); setRunResult(null); setMessage("");
    } else if (result.status === "ok") {
      setCheckResult(result.data);
    } else {
      setMessage(profileSyncConnectionErrorLabel(result.status === "failed" ? result.code : "connection_unavailable"));
    }
  }

  const enabled = ready && ready.mode !== "disabled" && !running && !checking && !needsRefresh;
  const checkEnabled = ready?.mode === "live" && !running && !checking;
  const knownCounts = ready ? Object.entries(ready.counts).filter(([key]) => ["pending", "queued", "processing", "running", "retry", "failed", "blocked", "succeeded"].includes(key)) : [];

  return <section aria-labelledby="profile-sync-heading" className="rounded-lg border border-brand-border bg-white p-4 sm:p-6">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h1 id="profile-sync-heading" className="text-2xl font-bold">Profil senkronu</h1>
        <p className="mt-1 text-sm text-stone-600">Kalıcı senkron kuyruğu ve yeniden deneme durumu.</p></div>
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={running || checking || readStatus === "loading"} onClick={() => void refresh()}
          className="min-h-11 rounded-lg border border-brand px-4 py-2 font-semibold text-brand disabled:opacity-50">Yenile</button>
        <button type="button" aria-describedby="profile-sync-connection-help" disabled={!checkEnabled} onClick={() => void checkConnection()}
          className="min-h-11 rounded-lg border border-brand px-4 py-2 font-semibold text-brand disabled:opacity-50">{checking ? "Bağlantı kontrol ediliyor…" : "Bağlantıyı doğrula"}</button>
        <button type="button" disabled={!enabled} onClick={() => void run()}
          className="min-h-11 rounded-lg bg-brand px-4 py-2 font-semibold text-white disabled:opacity-50">{running ? "Senkron bekleniyor…" : "Şimdi senkronla"}</button>
      </div>
    </div>
    <p id="profile-sync-connection-help" className="mt-3 text-sm text-stone-600">Bağlantıyı doğrula yalnız bağlantıyı kontrol eder; profil veya e-posta oluşturmaz.</p>
    {readStatus === "loading" && <div role="status" className="mt-5 space-y-3"><span className="sr-only">Senkron kuyruğu yükleniyor.</span>{[0, 1, 2].map(row => <div key={row} aria-hidden="true" className="h-16 animate-pulse rounded-lg bg-brand-bg" />)}</div>}
    {readStatus === "denied" && <p role="alert" className="mt-5 rounded-lg border border-brand-border p-4">Erişim yok. Yalnız aktif, yetkili personel bu kuyruğu görebilir.</p>}
    {readStatus === "unavailable" && <p role="alert" className="mt-5 rounded-lg border border-brand-border p-4">Bağlantı bekliyor. Senkron kuyruğu yüklenemedi; kayıt sayısı doğrulanmadı. Yenile ile tekrar kontrol et.</p>}
    {ready && <>
      <p role="status" className="mt-4 rounded-lg border border-brand-border bg-brand-bg p-3 text-sm">{ready.mode === "disabled"
        ? "Bağlantı bekliyor. Profil senkronu etkin değil."
        : ready.mode === "mock" ? "Deneme modu — dış sisteme kayıt gönderilmez." : "Canlı mod — düğme profil senkronunu çalıştırır."}</p>
      {ready.mode !== "disabled" && <>
        {knownCounts.length > 0 && <dl aria-label="Senkron kuyruk toplamları" className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">{knownCounts.map(([key, value]) => <div key={key} className="rounded-lg border border-brand-border p-3"><dt className="text-sm text-stone-600">{profileSyncStatusLabel(key)}</dt><dd className="text-xl font-bold">{value}</dd></div>)}</dl>}
        <h2 className="mt-5 font-semibold">Kuyruk kayıtları <span className="text-sm font-normal text-stone-600">({ready.jobs.length} gösteriliyor)</span></h2>
        <p className="mt-1 text-xs text-stone-600">Tüm saatler America/New_York. Yalnız güvenli hata kodu gösterilir.</p>
        {ready.jobs.length === 0 ? <p className="mt-3">Henüz senkron kaydı yok.</p> : <ul aria-label="Profil senkron kuyruğu" className="mt-3 space-y-3">{ready.jobs.map(job => <li key={job.id} className="rounded-lg border border-brand-border p-4">
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">İş {profileSyncShortId(job.id)}</h3><span className="rounded-lg bg-brand-bg px-2 py-1 text-sm">{profileSyncStatusLabel(job.status)}</span></div>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <div><dt className="text-stone-600">Profil</dt><dd>{profileSyncShortId(job.profileId)}</dd></div>
            <div><dt className="text-stone-600">Deneme sayısı</dt><dd>{job.attempts}</dd></div>
            <div className="min-w-0"><dt className="text-stone-600">Son hata kodu</dt><dd className="break-all">{job.lastErrorCode || "—"}</dd></div>
            <div><dt className="text-stone-600">Sonraki deneme</dt><dd>{profileSyncDate(job.nextAttemptAt)}</dd></div>
            <div><dt className="text-stone-600">Güncellendi</dt><dd>{profileSyncDate(job.updatedAt)}</dd></div>
          </dl>
        </li>)}</ul>}
      </>}
    </>}
    {ready && checkResult && <p role="status" className="mt-4 rounded-lg border border-brand-border p-3 text-sm">Klaviyo bağlantısı doğrulandı (HTTP 200). Profil veya e-posta oluşturulmadı. <span className="block">Kontrol: {profileSyncDate(checkResult.checkedAt)}</span></p>}
    {sameScope && runResult && runResult.mode !== "disabled" && <p role="status" className="mt-4 rounded-lg border border-brand-border p-3 text-sm">Son işlem: {runResult.processed} işlendi · {runResult.succeeded} tamamlandı · {runResult.blocked} engellendi · {runResult.retry} tekrar bekliyor · {runResult.failed} başarısız.</p>}
    {sameScope && message && <p role="alert" className="mt-4 rounded-lg border border-brand-border p-3 text-sm">{message}</p>}
  </section>;
}
