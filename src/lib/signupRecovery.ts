export const SIGNUP_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

type Draft<T> = {
  version: 1;
  savedAt: number;
  fields: T;
  requestId?: string;
  signature?: string;
};

type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export function readSignupDraft<T>(storage: DraftStorage | null, key: string, now = Date.now()): Draft<T> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const draft: unknown = JSON.parse(raw);
    if (!draft || typeof draft !== "object" || Array.isArray(draft)) return null;
    const record = draft as Partial<Draft<T>>;
    if (record.version !== 1 || typeof record.savedAt !== "number" ||
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

export function currentSignupStorage(): DraftStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; }
  catch { return null; }
}
