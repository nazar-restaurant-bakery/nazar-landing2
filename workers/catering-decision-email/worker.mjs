import PostalMime from "postal-mime";
import { parseDecisionReply } from "./core.mjs";

const SUPABASE_URL = "https://khgczybubufouraqyrcj.supabase.co";
const CAPTURE_ADDRESS = "crm-decisions@nazarrestaurantandbakery.com";

export default {
  async email(message, env) {
    if (message.to.toLowerCase() !== CAPTURE_ADDRESS) return;
    if (message.rawSize > 1_000_000) {
      console.warn("Decision email exceeded size limit");
      return;
    }
    if (!env.SUPABASE_SECRET_KEY?.startsWith("sb_secret_")) {
      throw new Error("Decision email database connection is unavailable");
    }

    const mail = await PostalMime.parse(message.raw);
    const payload = parseDecisionReply({
      recipient: message.to,
      envelopeFrom: message.from,
      headerFrom: mail.from?.address,
      subject: mail.subject,
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo,
      body: mail.text,
    });
    if (!payload) return; // Unrelated mail cannot change CRM.

    const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/crm_import_catering_decision_email_v1`, {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`Decision email import failed: ${response.status}`);
    if (await response.json() !== true) {
      console.warn("Decision email did not match a pending request");
      return;
    }
    // Keep a copy in the shared inbox as well as the private CRM record.
    await message.forward("ctnazarbakery@gmail.com");
  },
};
