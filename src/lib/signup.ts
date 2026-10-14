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

export async function submitSignup(payload: SignupPayload): Promise<boolean> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 15000);
  try {
    const result = await fetch("/api/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return result.ok;
  } catch {
    return false;
  } finally {
    window.clearTimeout(timeout);
  }
}
