// Presentation-only grouping. Database authorization remains the source of truth.
export const restaurantTabs = ["customers", "catering", "tasks", "offers", "orders", "coupons", "ops"] as const;
export const platformTabs = ["profile-sync", "system", "team"] as const;

export function visibleStaffTab(tab: string, platformOperator: boolean): boolean {
  return (restaurantTabs as readonly string[]).includes(tab) ||
    (platformOperator && (platformTabs as readonly string[]).includes(tab));
}

