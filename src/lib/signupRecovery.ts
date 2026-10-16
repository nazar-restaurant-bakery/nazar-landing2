export const SIGNUP_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Draft<T> = {
  version: 1;
  savedAt: number;
  fields: T;
  requestId?: string;
  signature?: string;
  pendingEmail?: PendingVipEmail;
};
export type PendingVipEmail = { email: string; name: string; campaign: string | null; requestId: string };

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readSignupDraft<T>(storage: DraftStorage | null, key: string, now = Date.now()): Draft<T> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const draft: unknown = JSON.parse(raw);
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) return null;
    const record = draft as Partial<Draft<T>>;
    if (record.version !== 1 || !Number.isFinite(record.savedAt) || typeof record.savedAt !== "number" ||
        now - record.savedAt > SIGNUP_DRAFT_MAX_AGE_MS || now < record.savedAt ||
        !record.fields || typeof record.fields !== "object") {
      storage.removeItem(key);
      return null;
    }
    return record as Draft<T>;
  } catch {
    return null;
  }
}

export function saveSignupDraft<T>(storage: DraftStorage | null, key: string, fields: T, now = Date.now()): void {
  if (!storage) return;
  try {
    const previous = readSignupDraft<T>(storage, key, now);
    storage.setItem(key, JSON.stringify({
      version: 1, savedAt: now, fields,
      requestId: previous?.requestId, signature: previous?.signature,
      pendingEmail: previous?.pendingEmail,
    } satisfies Draft<T>));
  } catch {
    // Private browsing or a full storage quota must not block the form.
  }
}

export function requestIdForSignup(
  storage: DraftStorage | null,
  key: string,
  submission: unknown,
  memory: { signature?: string; requestId?: string },
  makeId: () => string = () => crypto.randomUUID(),
): string {
  const signature = JSON.stringify(submission);
  const saved = readSignupDraft<unknown>(storage, key);
  const existingId = saved?.signature === signature ? saved.requestId :
    memory.signature === signature ? memory.requestId : undefined;
  const requestId = existingId || makeId();
  memory.signature = signature;
  memory.requestId = requestId;
  if (storage) {
    try {
      storage.setItem(key, JSON.stringify({
        version: 1, savedAt: Date.now(), fields: saved?.fields ?? {}, signature, requestId,
        pendingEmail: saved?.requestId === requestId ? saved.pendingEmail : undefined,
      } satisfies Draft<unknown>));
    } catch {
      // The in-memory ID still protects immediate retries in this tab.
    }
  }
  return requestId;
}

export function clearSignupDraft(storage: DraftStorage | null, key: string): void {
  try { storage?.removeItem(key); } catch { /* Storage can be unavailable. */ }
}

export function savePendingVipEmail(storage: DraftStorage | null, key: string, details: PendingVipEmail) {
  const saved = readSignupDraft(storage, key);
  if (!saved || saved.requestId !== details.requestId) return;
  try { storage?.setItem(key, JSON.stringify({ ...saved, savedAt: Date.now(), pendingEmail: details })); }
  catch { /* The current component retains the pending step in memory. */ }
}
export function readPendingVipEmail(storage: DraftStorage | null, key: string): PendingVipEmail | null {
  const saved = readSignupDraft<{name?: string;email?: string;consentEmail?: boolean}>(storage, key);
  const pending = saved?.pendingEmail;
  if (!pending || saved?.requestId !== pending.requestId || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pending.requestId)
    || typeof pending.email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(pending.email)
    || typeof pending.name !== "string" || pending.name.length > 200
    || !(pending.campaign === null || typeof pending.campaign === "string" && pending.campaign.length <= 100)
    || saved.fields.consentEmail !== true || typeof saved.fields.email !== "string" || saved.fields.email.trim().toLowerCase() !== pending.email
    || typeof saved.fields.name !== "string" || saved.fields.name.trim() !== pending.name) return null;
  return pending;
}

export function currentSignupStorage(): DraftStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}
