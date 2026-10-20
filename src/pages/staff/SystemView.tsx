import type { CateringNotification, CateringRequest, FormErrors } from "../../lib/crmData";
import { staffCopy as c } from "../../lib/staffCopy";
import { staffDisplayDate } from "../../lib/staffUi";

type Props = {
  errors: FormErrors | null; loading: boolean;
  notifications: CateringNotification[] | null;
  requests: CateringRequest[]; email: string; authorized: boolean;
  onResolve: (id: string) => Promise<boolean>;
  busy: boolean; writeBlocked: boolean;
};

export default function SystemView({ errors, loading, notifications, requests, email,
  authorized, onResolve, busy, writeBlocked }: Props) {
  const visibleRequests = new Map(requests.map(request => [request.id, request]));
  const visibleNotifications = notifications?.filter(item => visibleRequests.has(item.request_id)) ?? [];
  const alertLabels: Record<string, string> = {
    not_requested: c.alertNotRequested, suppressed: c.alertSuppressed,
    claimed: c.alertClaimed, accepted: c.alertAccepted, failed: c.alertFailed,
  };

  return <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(15rem,1fr)]">
    <section className="staff-panel p-4 sm:p-5 min-w-0" aria-labelledby="staff-errors-title">
      <h1 id="staff-errors-title" className="text-xl font-semibold">{c.formErrors}</h1>
      <p className="mt-2 text-sm text-stone-600">{c.errorScope}</p>
      {loading ? <div className="mt-4 space-y-3" role="status" aria-label={c.loading}>
        {[0, 1, 2].map(value => <div key={value} className="h-20 animate-pulse rounded-lg bg-brand-primarySoft" />)}
      </div> : errors === null ? <p role="status" className="mt-4">{c.unavailable}</p>
        : errors.total_open === 0 ? <p className="mt-4">{c.noErrors}</p>
          : <>
            <p className="mt-3 text-xs text-stone-600">{errors.items.length} {c.records} · {c.total}: {errors.total_open}</p>
            <div className="mt-3 space-y-3">{errors.items.map(error => <article key={error.id} className="rounded-lg border border-brand-border p-3 text-sm">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <h2 className="font-semibold">{error.form_kind === "catering" ? c.catering : error.form_kind === "vip" ? "VIP" : "—"}</h2>
                  <p className="mt-1 text-xs text-stone-600">{staffDisplayDate(error.occurred_at)}</p>
                  <dl className="mt-2 grid gap-1">
                    <div><dt className="inline font-medium">{c.stage}: </dt><dd className="inline break-words">{error.stage}</dd></div>
                    <div><dt className="inline font-medium">{c.errorCode}: </dt><dd className="inline break-all">{error.error_code}</dd></div>
                    <div><dt className="inline font-medium">{c.alert}: </dt><dd className="inline">{alertLabels[error.alert_status] || "—"}</dd></div>
                  </dl>
                  <p className="mt-2 break-all text-xs text-stone-600">{c.errorReference}: {error.id}</p>
                </div>
                <button type="button" className="staff-button staff-secondary" disabled={busy || writeBlocked || !authorized}
                  onClick={() => { void onResolve(error.id); }}>{c.resolve}</button>
              </div>
            </article>)}</div>
          </>}
    </section>

    <div className="min-w-0 space-y-4">
      <section className="staff-panel p-4 sm:p-5" aria-labelledby="staff-session-title">
        <h2 id="staff-session-title" className="font-semibold">{c.session}</h2>
        <dl className="mt-3 space-y-3 text-sm">
          <div><dt className="text-xs text-stone-600">{c.email}</dt><dd className="mt-1 break-all">{email || "—"}</dd></div>
          <div><dt className="text-xs text-stone-600">{c.status}</dt><dd className="mt-1">{authorized ? c.authorized : c.accessDenied}</dd></div>
          <div><dt className="text-xs text-stone-600">{c.role}</dt><dd className="mt-1">—</dd></div>
        </dl>
        <p className="mt-3 text-xs text-stone-600">{c.roleUnavailable}</p>
      </section>

      <section className="staff-panel p-4 sm:p-5" aria-labelledby="staff-notifications-title">
        <h2 id="staff-notifications-title" className="font-semibold">{c.notification}</h2>
        <p className="mt-2 text-xs text-stone-600">{c.notificationsScope}</p>
        <p className="mt-2 text-xs text-stone-600">{c.notificationScopeLimit}</p>
        <dl className="mt-3 text-sm"><dt className="text-xs text-stone-600">{c.notificationConfig}</dt><dd className="mt-1" title={c.notProvided}>—</dd></dl>
        {loading ? <div role="status" aria-label={c.loading} className="mt-3 h-12 animate-pulse rounded-lg bg-brand-primarySoft" />
          : notifications === null ? <p role="status" className="mt-3 text-sm">{c.unavailable}</p>
            : visibleNotifications.length === 0 ? <p className="mt-3 text-sm">{c.noNotifications}</p>
              : <div className="mt-3 space-y-3">{visibleNotifications.map(notification => {
                const request = visibleRequests.get(notification.request_id);
                const label = !notification.tracked ? c.notificationUnknown : notification.sent_at
                  ? c.notificationSent : notification.error ? c.notificationFailed : c.notificationPending;
                return <article key={notification.request_id} className="rounded-lg border border-brand-border p-3 text-sm">
                  <h3 className="break-words font-medium">{request?.name || request?.email || request?.phone || c.noName}</h3>
                  <p className="mt-1">{label}</p>
                  <p className="mt-1 text-xs text-stone-600">{staffDisplayDate(notification.sent_at || notification.attempted_at)}</p>
                  <p className="mt-2 break-all text-xs text-stone-600">{c.requestReference}: {notification.request_id}</p>
                </article>;
              })}</div>}
      </section>
    </div>
  </div>;
}
