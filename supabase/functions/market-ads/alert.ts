// Connection alert for a failed market-ads run. Resend with the transactional domain
// (same pattern as functions/_lib/resendEmail.ts, which is not changed). The database
// decides whether an alert is due (once per New York day per error code).
import { reconnectNeeded } from "./ads.ts";
export const ALERT_FROM = "Nazar Go Growth <notifications@mail.nazarrestaurantandbakery.com>";
export const ALERT_TO = "ctnazarbakery@gmail.com";
export const ALERT_SUBJECT = "Nazar Go Growth · Google Ads bağlantısı durdu";
export type AlertStatus = "sent" | "not_accepted" | "provider_error" | "alert_not_configured";

export function alertText(date: string, code: string): string {
  const action = reconnectNeeded(code)
    ? "Google Ads erişimini yeniden bağlayın: yeni bir yenileme anahtarı alıp Supabase'de GOOGLE_ADS_REFRESH_TOKEN olarak güncelleyin, ardından elle bir çalıştırma yapın."
    : "Supabase'de market-ads kayıtlarına ve GOOGLE_ADS_* ayarlarına bakın, sorun giderilince elle bir çalıştırma yapın; kaçan günler kendiliğinden dolar.";
  return ["Google Ads raporu çekilemedi.", "", "Tarih (New York): " + date, "Hata kodu: " + code, "", action].join("\n");
}

export async function sendAlert(apiKey: string | undefined, date: string, code: string, idempotencyKey: string,
  fetcher: typeof fetch): Promise<AlertStatus> {
  if (!apiKey?.trim()) return "alert_not_configured";
  try {
    const response = await fetcher("https://api.resend.com/emails", { method: "POST", redirect: "error", signal: AbortSignal.timeout(10000),
      headers: { Authorization: "Bearer " + apiKey.trim(), "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({ from: ALERT_FROM, to: [ALERT_TO], subject: ALERT_SUBJECT, text: alertText(date, code) }) });
    if (!response.ok) return "not_accepted";
    const result = await response.json() as { id?: unknown } | null;
    return typeof result?.id === "string" && result.id ? "sent" : "not_accepted";
  } catch {
    return "provider_error";
  }
}
