/** Read-only, prospective campaign check. A result never reserves a benefit. */
export type CampaignCheck = {
  known: boolean;
  eligible: boolean | null;
  reason: string;
  checkedAt: string;
  snapshotAt: string | null;
  campaign: { id: string; name: string; benefitType: "item" | "discount"; targetItemId: string | null } | null;
  remaining: { person: number | null; total: number | null; perOrder: number } | null;
};
export type CampaignCheckState =
  | { status: "loading" }
  | { status: "ready"; check: CampaignCheck }
  | { status: "denied" | "unavailable" };
export type CampaignCheckRpc = (name: string, params: Record<string, unknown>) => PromiseLike<{
  data: unknown; error: { code?: string; status?: number } | null;
}>;

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const quota = (value: unknown) => value === null || (Number.isSafeInteger(value) && Number(value) >= 0);
const validTime = (value: unknown) => typeof value === "string" && Number.isFinite(new Date(value).getTime());

export function validCampaignCheck(value: unknown): value is CampaignCheck {
  if (!record(value) || typeof value.known !== "boolean" || typeof value.reason !== "string"
    || !/^[a-z][a-z0-9_]{0,79}$/.test(value.reason)
    || !validTime(value.checkedAt) || !(value.snapshotAt === null || validTime(value.snapshotAt))
    || (value.known ? typeof value.eligible !== "boolean" : value.eligible !== null)) return false;
  const campaign = value.campaign;
  if (campaign !== null && (!record(campaign) || typeof campaign.id !== "string" || !campaign.id
    || typeof campaign.name !== "string" || !campaign.name
    || !["item", "discount"].includes(String(campaign.benefitType))
    || !(campaign.targetItemId === null || typeof campaign.targetItemId === "string"))) return false;
  const remaining = value.remaining;
  if (remaining !== null && (!record(remaining) || !quota(remaining.person) || !quota(remaining.total)
    || !Number.isSafeInteger(remaining.perOrder) || Number(remaining.perOrder) < 0)) return false;
  return value.eligible !== true || (value.reason === "eligible" && record(campaign)
    && campaign.benefitType === "item" && typeof campaign.targetItemId === "string" && !!campaign.targetItemId
    && record(remaining) && remaining.person !== 0 && remaining.total !== 0 && Number(remaining.perOrder) > 0);
}

/** Name matching is presentation only; eligibility is always the database result. */
export function campaignCheckLabel(check: CampaignCheck | null): "simit" | "item" {
  return !check?.campaign || (check.campaign.benefitType === "item"
    && /(?:^|[^\p{L}\p{N}])simit(?:$|[^\p{L}\p{N}])/u.test(check.campaign.name.toLocaleLowerCase("tr-TR"))) ? "simit" : "item";
}

export function campaignCheckTime(value: string | null) {
  return value && validTime(value) ? new Intl.DateTimeFormat("tr-TR", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "America/New_York",
  }).format(new Date(value)) : "—";
}

/** No writer, service key, provider request, or fallback to a guessed result. */
export async function loadCampaignCheck(rpc: CampaignCheckRpc, businessId: string, cloverOrderId: string): Promise<CampaignCheckState> {
  if (!businessId || !cloverOrderId) return { status: "unavailable" };
  try {
    const { data, error } = await rpc("campaign_eligibility_check_v1", {
      p_business_id: businessId, p_clover_order_id: cloverOrderId,
    });
    if (error?.code === "42501" || error?.code === "PGRST301" || error?.status === 401 || error?.status === 403) return { status: "denied" };
    return error || !validCampaignCheck(data) ? { status: "unavailable" } : { status: "ready", check: data };
  } catch { return { status: "unavailable" }; }
}

/** Small read batches avoid firing fifty simultaneous per-order RPCs. */
export async function readCampaignChecks(
  rpc: CampaignCheckRpc, businessId: string, orderIds: string[],
  accept: (orderId: string, result: CampaignCheckState) => void, current: () => boolean,
) {
  const ids = [...new Set(orderIds)];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, ids.length) }, async () => {
    while (current() && next < ids.length) {
      const id = ids[next++];
      const result = await loadCampaignCheck(rpc, businessId, id);
      if (current()) accept(id, result);
    }
  }));
}
