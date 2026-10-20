export type ProfileSyncMode = "mock" | "live" | "disabled";
export type ProfileSyncJob = {
  id: string;
  status: string;
  attempts: number;
  nextAttemptAt: string | null;
  lastErrorCode: string | null;
  updatedAt: string;
  profileId: string | null;
};
export type ProfileSyncQueue = {
  code: "ok";
  mode: ProfileSyncMode;
  jobs: ProfileSyncJob[];
  counts: Record<string, number>;
};
export type ProfileSyncRun = {
  code: "ok";
  mode: ProfileSyncMode;
  processed: number;
  succeeded: number;
  blocked: number;
  retry: number;
  failed: number;
};
export type ProfileSyncResponse<T> = { status: "ok"; data: T } | { status: "denied" | "unavailable" };
export type ProfileSyncFetch = (input: string, options: RequestInit) => Promise<Response>;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const mode = (value: unknown): value is ProfileSyncMode => value === "mock" || value === "live" || value === "disabled";
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const nullableDate = (value: unknown) => value === null || date(value);
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const status = (value: unknown): value is string => typeof value === "string" && /^[a-z_]{1,32}$/.test(value);

export function validProfileSyncQueue(value: unknown): value is ProfileSyncQueue {
  return record(value) && value.code === "ok" && mode(value.mode) && Array.isArray(value.jobs)
    && value.jobs.every(job => record(job) && identifier(job.id) && status(job.status) && count(job.attempts)
      && nullableDate(job.nextAttemptAt) && date(job.updatedAt)
      && (job.profileId === null || identifier(job.profileId))
      && (job.lastErrorCode === null || typeof job.lastErrorCode === "string" && /^[A-Z0-9_]{1,80}$/.test(job.lastErrorCode)))
    && record(value.counts) && Object.entries(value.counts).length <= 20
    && Object.entries(value.counts).every(([key, value]) => status(key) && count(value));
}

export function validProfileSyncRun(value: unknown): value is ProfileSyncRun {
  return record(value) && value.code === "ok" && mode(value.mode)
    && [value.processed, value.succeeded, value.blocked, value.retry, value.failed].every(count);
}

async function request<T>(fetcher: ProfileSyncFetch, accessToken: string, run: boolean,
  valid: (value: unknown) => value is T): Promise<ProfileSyncResponse<T>> {
  if (!accessToken) return { status: "denied" };
  try {
    const response = await fetcher("/api/staff/profile-sync", {
      // A single command includes staff authorization, leased DB checks and two
      // bounded provider requests. Keep its deadline above the server path.
      method: run ? "POST" : "GET", cache: "no-store", signal: AbortSignal.timeout(run ? 45000 : 20000),
      headers: { Authorization: `Bearer ${accessToken}`, ...(run ? { "Content-Type": "application/json" } : {}) },
      ...(run ? { body: JSON.stringify({ action: "run" }) } : {}),
    });
    if (response.status === 401 || response.status === 403) return { status: "denied" };
    if (!response.ok) return { status: "unavailable" };
    const data: unknown = await response.json();
    return valid(data) ? { status: "ok", data } : { status: "unavailable" };
  } catch { return { status: "unavailable" }; }
}

export const readProfileSyncQueue = (fetcher: ProfileSyncFetch, accessToken: string) =>
  request(fetcher, accessToken, false, validProfileSyncQueue);
export const runProfileSync = (fetcher: ProfileSyncFetch, accessToken: string) =>
  request(fetcher, accessToken, true, validProfileSyncRun);

const statusLabels: Record<string, string> = {
  pending: "Bekliyor", queued: "Bekliyor", processing: "İşleniyor", running: "İşleniyor",
  retry: "Tekrar bekliyor", failed: "Başarısız", blocked: "Engellendi", succeeded: "Tamamlandı",
};
export const profileSyncStatusLabel = (value: string) => statusLabels[value] || "Bilinmeyen durum";
export const profileSyncShortId = (value: string | null) => value ? value.slice(0, 8) : "—";
export function profileSyncDate(value: string | null) {
  if (!value) return "—";
  if (!date(value)) return "Geçersiz tarih";
  return new Intl.DateTimeFormat("tr-TR", { day: "numeric", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit", timeZone: "America/New_York" }).format(new Date(value));
}
