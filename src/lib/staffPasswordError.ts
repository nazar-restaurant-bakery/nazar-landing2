// Only fixed categories leave Auth; never render or log provider messages.
export function staffPasswordError(error: unknown) {
  const value = error && typeof error === "object" ? error as { code?: unknown; status?: unknown; name?: unknown } : {};
  const code = typeof value.code === "string" ? value.code : "";
  if (["insufficient_aal", "reauthentication_needed", "reauthentication_not_valid", "current_password_required"].includes(code)) return "reauthentication";
  if (["session_not_found", "session_expired", "refresh_token_not_found", "refresh_token_already_used", "bad_jwt"].includes(code) || value.name === "AuthSessionMissingError" || value.status === 401) return "session";
  if (code === "same_password") return "same";
  if (code === "weak_password") return "weak";
  if (value.status === 429) return "limit";
  if (value.status === 403) return "denied";
  return "unknown";
}
