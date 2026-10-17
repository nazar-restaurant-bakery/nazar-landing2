// A customer recovery limit, not a server-side rate limit or access control.
export const MAX_SIGNUP_ATTEMPTS = 2;
const MAX_AGE = 24 * 60 * 60 * 1000;
type Store = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
export type AttemptMemory = { requestId?: string; count?: number; startedAt?: number };
function read(storage: Store, key: string, requestId: string | undefined, memory: AttemptMemory, now: number) {
  const valid = (entry: AttemptMemory) => entry.requestId === requestId && Number.isInteger(entry.count)
    && entry.count! >= 0 && entry.count! <= MAX_SIGNUP_ATTEMPTS && Number.isFinite(entry.startedAt)
    && now >= entry.startedAt! && now - entry.startedAt! <= MAX_AGE;
  let saved: AttemptMemory = {};
  try { saved = JSON.parse(storage?.getItem(key) || "{}"); } catch { /* Memory still works. */ }
  if (!saved || typeof saved !== "object") saved = {};
  if (requestId && valid(memory) && (!valid(saved) || memory.count! >= saved.count!)) return memory;
  if (requestId && valid(saved)) return saved;
  return { requestId, count: 0, startedAt: now };
}
export function signupAttemptsExhausted(storage: Store, key: string, requestId?: string, memory: AttemptMemory = {}, now = Date.now()) {
  return read(storage, key, requestId, memory, now).count! >= MAX_SIGNUP_ATTEMPTS;
}
export function takeSignupAttempt(storage: Store, key: string, requestId: string, memory: AttemptMemory, now = Date.now()) {
  const previous = read(storage, key, requestId, memory, now);
  if (previous.count! >= MAX_SIGNUP_ATTEMPTS) return false;
  Object.assign(memory, { ...previous, count: previous.count! + 1 });
  try { storage?.setItem(key, JSON.stringify(memory)); } catch { /* Keep the in-memory limit. */ }
  return true;
}
export function clearSignupAttempts(storage: Store, key: string, memory: AttemptMemory) {
  delete memory.requestId; delete memory.count; delete memory.startedAt;
  try { storage?.removeItem(key); } catch { /* The form already succeeded. */ }
}
