// src/components/CateringRequestForm.tsx
//
// Modelled on VipSignupForm: same validation rules, same neutral honeypot, same
// success/error UX. The extra catering fields ride along in the RPC's `p_meta`
// rather than needing columns of their own.

import React from "react";
import { cn, EMAIL_RE, normalizePhone } from "../lib/form";
import { captureUtm, getUtmOrNull } from "../lib/utm";
import { submitSignup } from "../lib/signup";
import { trackCateringRequestSubmitted } from "../lib/analytics";
import TurnstileWidget from "./TurnstileWidget";
import { turnstileSiteKey } from "../lib/formConfig";
import { useLang } from "./Language";
import { t } from "./i18n";
import { CATERING_PACKAGES, cateringItemName } from "../data/cateringMenus";
import { PHONE_NUMBER_DISPLAY, PHONE_NUMBER_TEL } from "../data/menu";
import type { CateringChoice } from "../lib/signup";

type Status = "idle" | "submitting" | "success" | "error";

export default function CateringRequestForm({ className, menuChoice, onSuccess }: { className?: string; menuChoice?: CateringChoice | null; onSuccess?: () => void }) {
  const { lang } = useLang();

  React.useEffect(() => {
    captureUtm();
  }, []);

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [eventDate, setEventDate] = React.useState("");
  const [guests, setGuests] = React.useState("");
  const [message, setMessage] = React.useState("");

  const [status, setStatus] = React.useState<Status>("idle");
  const [errorKey, setErrorKey] = React.useState<string | null>(null);

  // Bots fill every field they can see; humans never touch a hidden one.
  const [honeypot, setHoneypot] = React.useState("");
  const [turnstileToken, setTurnstileToken] = React.useState("");
  const [resetSignal, setResetSignal] = React.useState(0);

  const submitting = status === "submitting";
  const overCapacity = Number(guests) > 60;

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();
    const trimmedMessage = message.trim();

    if (!turnstileSiteKey) {
      setStatus("error");
      setErrorKey("catering.errorOffline");
      return;
    }

    if (!trimmedEmail && !trimmedPhone) {
      setStatus("error");
      setErrorKey("catering.errorContact");
      return;
    }

    if (trimmedEmail && !EMAIL_RE.test(trimmedEmail)) {
      setStatus("error");
      setErrorKey("catering.errorEmail");
      return;
    }

    const normalizedPhone = trimmedPhone ? normalizePhone(trimmedPhone) : null;
    if (trimmedPhone && !normalizedPhone) {
      setStatus("error");
      setErrorKey("catering.errorPhone");
      return;
    }

    if (menuChoice?.type === "custom" && menuChoice.itemIds.length === 0) {
      setStatus("error");
      setErrorKey("catering.errorCustomItems");
      return;
    }

    if (!turnstileToken) {
      setStatus("error");
      setErrorKey("catering.errorVerification");
      return;
    }

    // Silently accept the bot so it doesn't retry, but write nothing.
    if (honeypot.trim()) {
      setStatus("success");
      setErrorKey(null);
      return;
    }

    setStatus("submitting");
    setErrorKey(null);

    const ok = await submitSignup({
      kind: "catering",
      name: trimmedName,
      email: trimmedEmail.toLowerCase(),
      phone: normalizedPhone || "",
      consentEmail: false,
      turnstileToken,
      extra: honeypot,
      utm: getUtmOrNull(),
      eventDate,
      guests,
      message: trimmedMessage,
      menuChoice,
    });
    setTurnstileToken("");
    setResetSignal((value) => value + 1);
    if (!ok) {
      setStatus("error");
      setErrorKey("catering.errorGeneric");
      return;
    }

    trackCateringRequestSubmitted();
    setStatus("success");
    setName("");
    setEmail("");
    setPhone("");
    setEventDate("");
    setGuests("");
    setMessage("");
    onSuccess?.();
  }

  if (status === "success") {
    return (
      <div
        className={cn(
          "rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center",
          className
        )}
      >
        <p className="text-base font-extrabold text-emerald-900">
          {t("catering.success", lang)}
        </p>
        <button
          type="button"
          onClick={() => setStatus("idle")}
          className="mt-3 text-xs font-bold text-emerald-800 underline underline-offset-2"
        >
          {t("catering.another", lang)}
        </button>
      </div>
    );
  }

  const fieldClass =
    "w-full rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-900 " +
    "placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-200";

  const labelClass = "block text-xs font-extrabold uppercase tracking-wide text-zinc-700";

  const optional = (
    <span className="font-semibold normal-case text-zinc-500">
      {t("catering.optional", lang)}
    </span>
  );

  return (
    <form onSubmit={handleSubmit} noValidate className={cn("space-y-4", className)}>
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-950" aria-live="polite">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="font-extrabold">{t("catering.selectedMenu", lang)}</p>
          <a href="#catering-menus" className="font-bold text-[#1E7A3A] underline underline-offset-2 hover:text-emerald-800">
            {t("catering.viewMenus", lang)}
          </a>
        </div>
        {menuChoice?.type === "package" ? (
          <p className="mt-1">{CATERING_PACKAGES.find((menu) => menu.id === menuChoice.id)?.title[lang] ?? menuChoice.id}</p>
        ) : menuChoice?.type === "custom" ? (
          <p className="mt-1">{t("catering.customTitle", lang)}: {menuChoice.itemIds.map((id) => cateringItemName(id, lang)).join(", ") || "—"}</p>
        ) : (
          <p className="mt-1">{t("catering.noMenu", lang)}</p>
        )}
      </div>
      <div>
        <label htmlFor="cat-name" className={labelClass}>
          {t("catering.name", lang)}
        </label>
        <input
          id="cat-name"
          name="name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(fieldClass, "mt-1.5")}
        />
      </div>

      <div>
        <label htmlFor="cat-email" className={labelClass}>
          {t("catering.email", lang)}
        </label>
        <input
          id="cat-email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          className={cn(fieldClass, "mt-1.5")}
        />
      </div>

      <div>
        <label htmlFor="cat-phone" className={labelClass}>
          {t("catering.phone", lang)}
        </label>
        <input
          id="cat-phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="(203) 555-0123"
          className={cn(fieldClass, "mt-1.5")}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="cat-date" className={labelClass}>
            {t("catering.eventDate", lang)} {optional}
          </label>
          <input
            id="cat-date"
            name="event_date"
            type="date"
            value={eventDate}
            onChange={(e) => setEventDate(e.target.value)}
            className={cn(fieldClass, "mt-1.5")}
          />
        </div>

        <div>
          <label htmlFor="cat-guests" className={labelClass}>
            {t("catering.guests", lang)} {optional}
          </label>
          <input
            id="cat-guests"
            name="guests"
            type="number"
            inputMode="numeric"
            min={1}
            step={1}
            value={guests}
            onChange={(e) => setGuests(e.target.value)}
            placeholder="40"
            aria-describedby="cat-capacity-note"
            className={cn(fieldClass, "mt-1.5")}
          />
        </div>
      </div>

      <p id="cat-capacity-note" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950">
        {t("catering.overCapacityNote", lang)}
      </p>

      <div>
        <label htmlFor="cat-message" className={labelClass}>
          {t(overCapacity ? "catering.largeEventMessage" : "catering.message", lang)} {optional}
        </label>
        <textarea
          id="cat-message"
          name="message"
          rows={4}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={t(overCapacity ? "catering.largeEventPlaceholder" : "catering.messagePlaceholder", lang)}
          className={cn(fieldClass, "mt-1.5 resize-y")}
        />
      </div>

      {/* Honeypot — hidden from people, irresistible to bots.
          The id/name must stay a neutral token: anything resembling "company"
          matches the browser's `organization` autofill heuristic, and a
          password manager filling it in silently fails the bot check for a
          real customer. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="nzr-extra-catering">Leave this field empty</label>
        <input
          id="nzr-extra-catering"
          name="nzr_extra"
          type="text"
          tabIndex={-1}
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore="true"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
        />
      </div>

      <TurnstileWidget onToken={setTurnstileToken} resetSignal={resetSignal} />

      {errorKey && (
        <p role="alert" className="text-sm font-bold text-red-700">
          {t(errorKey, lang)}
          {errorKey === "catering.errorOffline" || errorKey === "catering.errorGeneric" ? (
            <>
              {" "}
              <a href={`tel:${PHONE_NUMBER_TEL}`} className="underline underline-offset-2">
                {PHONE_NUMBER_DISPLAY}
              </a>
            </>
          ) : null}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting}
        className={cn(
          "inline-flex h-12 w-full items-center justify-center rounded-full px-8",
          "bg-[#1E7A3A] text-base font-extrabold text-white shadow-sm",
          "hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-[#1E7A3A] focus:ring-offset-2",
          "disabled:cursor-not-allowed disabled:opacity-60"
        )}
      >
        {submitting ? t("catering.submitting", lang) : t("catering.submit", lang)}
      </button>

      <p className="text-center text-xs font-semibold text-zinc-500">
        {t("catering.privacy", lang)}
      </p>
    </form>
  );
}
