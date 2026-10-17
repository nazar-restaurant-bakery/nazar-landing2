export type CateringChoice =
  | { type: "package"; id: string }
  | { type: "custom"; itemIds: string[]; quantities: Record<string, number> }
  | { type: "trays"; selections: { id: string; size: 10 | 20 | 30 | 50 }[]; itemIds: string[]; quantities: Record<string, number> };

export type SignupPayload = {
  kind: "vip" | "catering";
  requestId: string;
  name: string;
  email: string;
  phone: string;
  consentEmail: boolean;
  turnstileToken: string;
  extra: string;
  utm: Record<string, string> | null;
  eventDate?: string;
  guests?: string;
  message?: string;
  menuChoice?: CateringChoice | null;
};

export async function submitSignup(payload: SignupPayload, onErrorReference?: (reference: string) => void): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const result = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!result.ok && onErrorReference) {
      // Display only the server's opaque reference, never arbitrary response text.
      try {
        const data = await result.json() as { error_id?: unknown };
        if (typeof data.error_id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.error_id)) onErrorReference(data.error_id);
      } catch { /* A proxy failure may not contain JSON or a reference. */ }
    }
    return result.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}
