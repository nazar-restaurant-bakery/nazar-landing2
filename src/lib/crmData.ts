import { createClient } from "@supabase/supabase-js";
import { safeCrmRequest } from "./crmUi";
import { NAZAR_BUSINESS_ID } from "./supabase";
import type { EmailStatusResult } from "./crmEmailStatus";
import type { CrmQueueName } from "./crmQueue";

export type Customer = {
  id: string; name: string | null; email: string | null; phone: string | null;
  email_status: string; created_at: string; signup_count: number;
  last_signup_at: string | null; last_source: string | null;
  vip_signup_count: number; kevin_signup_count: number;
  recent_signups: { id: string; source: string; campaign: string | null; created_at: string }[];
  notes: { id: string; body: string; created_at: string; author_id?: string | null }[];
};
export type CateringRequest = {
  id: string; customer_id: string; name: string | null; email: string | null;
  phone: string | null; event_date: string | null; guests: number | null;
  message: string | null; status: string; assigned_to: string | null;
  follow_up_at: string | null; created_at: string;
};
export type Overview = { customers: Customer[]; requests: CateringRequest[] };
export type FollowUpTask = { id: string; title: string; assigned_to: string; due_at: string; completed_at: string | null; created_at?: string };
export type TaskState = { items: FollowUpTask[]; unavailable: boolean };
export type CateringDecision = {
  id: string; request_id: string; question: string; requested_at: string;
  decision: string | null; recorded_at: string | null; request_status: string; customer_name: string | null;
};
export type CateringNotification = { request_id: string; tracked: boolean; attempted_at: string | null; sent_at: string | null; error: string | null };
export type Offer = { id: string; name: string; description: string | null; code: string | null; channel_target: string | null; starts_at: string | null; ends_at: string | null };
export type FormError = { id: string; occurred_at: string; form_kind: string; stage: string; error_code: string; http_status: number; alert_status: string };
export type FormErrors = { total_open: number; items: FormError[] };
export type MutationResult = Promise<boolean>;
export type EmailState = { loading: boolean; result: EmailStatusResult | null };

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY;
// Same browser Auth and narrow public RPCs as the existing StaffPage. No table reads.
export const staffClient = url && key ? createClient(url, key) : null;
const rpc = (name: string, params?: Record<string, unknown>) => safeCrmRequest(() => staffClient
  ? staffClient.rpc(name, params) : Promise.resolve({ data: null, error: { code: "MISSING_CONFIG" } }));
export const crmData = {
  authorized: () => rpc("crm_staff_authorized_v1"),
  overview: (segment: "all" | "test") => rpc("crm_overview_v2", { p_search: "", p_segment: segment }),
  tasks: (customerId: string) => rpc("crm_customer_tasks_v1", { p_customer_id: customerId }),
  queue: (queue: CrmQueueName, offset: number) => rpc("crm_follow_up_queue_v1", { p_queue: queue, p_offset: offset }),
  decisions: () => rpc("crm_catering_decisions_v1"),
  notifications: () => rpc("crm_catering_notification_status_v1"),
  errors: () => rpc("crm_form_errors_v1"),
  offers: () => rpc("get_active_offers", { p_business_id: NAZAR_BUSINESS_ID }),
  addNote: (customerId: string, body: string) => rpc("crm_add_note", { p_customer_id: customerId, p_body: body }),
  createTask: (customerId: string, title: string, owner: string, due: string) => rpc("crm_create_task_v1", {
    p_customer_id: customerId, p_title: title, p_assigned_to: owner, p_due_at: due,
  }),
  completeTask: (id: string) => rpc("crm_complete_task_v1", { p_task_id: id }),
  updateRequest: (id: string, status: string, owner: string, due: string | null) => rpc("crm_update_catering", {
    p_request_id: id, p_status: status, p_assigned_to: owner, p_follow_up_at: due,
  }),
  requestDecision: (id: string, question: string) => rpc("crm_request_catering_decision_v1", { p_request_id: id, p_question: question }),
  resolveError: (id: string) => rpc("crm_resolve_form_error_v1", { p_id: id }),
};
