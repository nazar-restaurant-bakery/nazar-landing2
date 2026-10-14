// Public Klaviyo client endpoint: this is called only from the visitor's browser.
// Both IDs are public. Never put a private Klaviyo API key in this file.
import { isTestLead } from "./testLead.ts";
const SITE_ID = "W6Kr7z";
const VIP_LIST_ID = "UeJynm";
const REVISION = "2026-07-15";

type VipEmail = {
  email: string;
  name: string;
  campaign: string | null;
};

export async function subscribeVipEmail({ email, name, campaign }: VipEmail): Promise<boolean> {
  if (isTestLead({ email, name })) return false;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const source = campaign
      ? `Nazar website VIP form (${campaign.slice(0, 100)})`
      : "Nazar website VIP form";
    const result = await fetch(
      `https://a.klaviyo.com/client/subscriptions/?company_id=${SITE_ID}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/vnd.api+json",
          Accept: "application/vnd.api+json",
          revision: REVISION,
        },
        body: JSON.stringify({
          data: {
            type: "subscription",
            attributes: {
              custom_source: source,
              profile: {
                data: {
                  type: "profile",
                  attributes: {
                    email,
                    ...(name ? { properties: { "Nazar VIP Name": name } } : {}),
                    subscriptions: {
                      email: { marketing: { consent: "SUBSCRIBED" } },
                    },
                  },
                },
              },
            },
            relationships: {
              list: { data: { type: "list", id: VIP_LIST_ID } },
            },
          },
        }),
        signal: controller.signal,
      },
    );
    return result.status === 202;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
