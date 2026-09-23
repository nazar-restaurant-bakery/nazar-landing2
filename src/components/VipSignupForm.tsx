// src/components/VipSignupForm.tsx
import React from "react";
import { captureUtm, getUtmOrNull } from "../lib/utm";
import { submitSignup } from "../lib/signup";
import TurnstileWidget from "./TurnstileWidget";
import { turnstileSiteKey } from "../lib/formConfig";
// Shared with CateringRequestForm so both forms validate identically.
import { cn, EMAIL_RE, normalizePhone } from "../lib/form";
import { useLang } from "./Language";
import { t } from "./i18n";
import { PHONE_NUMBER_DISPLAY, PHONE_NUMBER_TEL } from "../data/menu";

type Status = "idle" | "submitting" | "success" | "error";

type Props = {
  className?: string;
};

export default function VipSignupForm({
  className,
}: Props) {
  const { lang } = useLang();

  const [name, setName] = React.useState("");
  const [email, setEmail] = React.useState("");
  const [phone, setPhone] = React.useState("");
  const [consentEmail, setConsentEmail] = React.useState(false);

  const [status, setStatus] = React.useState<Status>("idle");
  const [errorKey, setErrorKey] = React.useState<string | null>(null);

  // Bots fill every field they can see; humans never touch a hidden one.
  const [honeypot, setHoneypot] = React.useState("");
  const [turnstileToken, setTurnstileToken] = React.useState("");
  const [resetSignal, setResetSignal] = React.useState(0);

  React.useEffect(() => {
    captureUtm();
  }, []);

  const submitting = status === "submitting";

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;

    const trimmedName = name.trim();
    const trimmedEmail = email.trim();
    const trimmedPhone = phone.trim();

    if (!turnstileSiteKey) {
      setStatus("error");
      setErrorKey("vip.errorOffline");
      return;
    }

    if (!trimmedEmail && !trimmedPhone) {
      setStatus("error");
      setErrorKey("vip.errorContact");
      return;
    }

    if (trimmedEmail && !EMAIL_RE.test(trimmedEmail)) {
      setStatus("error");
      setErrorKey("vip.errorEmail");
      return;
    }

    const normalizedPhone = trimmedPhone ? normalizePhone(trimmedPhone) : null;
    if (trimmedPhone && !normalizedPhone) {
      setStatus("error");
      setErrorKey("vip.errorPhone");
      return;
    }

    if (!consentEmail || !trimmedEmail) {
      setStatus("error");
      setErrorKey("vip.errorConsent");
      return;
    }

    if (!turnstileToken) {
      setStatus("error");
      setErrorKey("vip.errorVerification");
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
      kind: "vip",
      name: trimmedName,
      email: trimmedEmail.toLowerCase(),
      phone: normalizedPhone || "",
      consentEmail,
      turnstileToken,
      extra: honeypot,
      utm: getUtmOrNull(),
    });
    setTurnstileToken("");
    setResetSignal((value) => value + 1);
    if (!ok) {
      setStatus("error");
      setErrorKey("vip.errorGeneric");
      return;
    }

    setStatus("success");
    setName("");
    setEmail("");
    setPhone("");
    setConsentEmail(false);
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
          {t("vip.success", lang)}
        </p>
        <button
          type="button"
          onClick={() => setStatus("idle")}
          className="mt-3 text-xs font-bold text-emerald-800 underline underline-offset-2"
        >
          {t("vip.submit", lang)}
        </button>
      </div>
    );
  }

  const fieldClass =
    "w-full rounded-xl border border-zinc-300 bg-white px-4 py-2.5 text-sm text-zinc-900 " +
    "placeholder:text-zinc-400 focus:border-zinc-400 focus:outline-none focus:ring-2 focus:ring-zinc-200";

  const labelClass = "block text-xs font-extrabold uppercase tracking-wide text-zinc-700";

  return (
    <form
      onSubmit={handleSubmit}
      noValidate
      className={cn("space-y-4", className)}
    >
      <div>
        <label htmlFor="vip-name" className={labelClass}>
          {t("vip.name", lang)}{" "}
          <span className="font-semibold normal-case text-zinc-500">
            {t("vip.optional", lang)}
          </span>
        </label>
        <input
          id="vip-name"
          name="name"
          type="text"
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={cn(fieldClass, "mt-1.5")}
        />
      </div>

      <div>
        <label htmlFor="vip-email" className={labelClass}>
          {t("vip.email", lang)}
        </label>
        <input
          id="vip-email"
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
        <label htmlFor="vip-phone" className={labelClass}>
          {t("vip.phone", lang)}{" "}
          <span className="font-semibold normal-case text-zinc-500">
            {t("vip.optional", lang)}
          </span>
        </label>
        <input
          id="vip-phone"
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

      {/* Honeypot — hidden from people, irresistible to bots.
          The id/name must stay a neutral token: anything resembling "company"
          matches the browser's `organization` autofill heuristic, and a
          password manager filling it in silently fails the bot check for a
          real customer. */}
      <div aria-hidden="true" className="absolute left-[-9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="nzr-extra">Leave this field empty</label>
        <input
          id="nzr-extra"
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

      <div className="space-y-2 pt-1">
        <label className="flex items-start gap-2.5 text-sm font-semibold text-zinc-700">
          <input
            type="checkbox"
            checked={consentEmail}
            onChange={(e) => setConsentEmail(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-zinc-300"
          />
          <span>{t("vip.consentEmail", lang)}</span>
        </label>

      </div>

      <TurnstileWidget onToken={setTurnstileToken} resetSignal={resetSignal} />

      {errorKey && (
        <p role="alert" className="text-sm font-bold text-red-700">
          {t(errorKey, lang)}
          {errorKey === "vip.errorOffline" || errorKey === "vip.errorGeneric" ? (
            <>
              {" "}
              <a
                href={`tel:${PHONE_NUMBER_TEL}`}
                className="underline underline-offset-2"
              >
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
        {submitting ? t("vip.submitting", lang) : t("vip.submit", lang)}
      </button>

      <p className="text-center text-xs font-semibold text-zinc-500">
        {t("vip.privacy", lang)}
      </p>
    </form>
  );
}
