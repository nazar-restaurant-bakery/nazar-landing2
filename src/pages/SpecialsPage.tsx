// src/pages/SpecialsPage.tsx
import React from "react";
import { supabase, isSupabaseConfigured, NAZAR_BUSINESS_ID, type Offer } from "../lib/supabase";
import { cn } from "../lib/form";
import { CLOVER_PICKUP_URL } from "../data/menu";
import { MarketplaceLinks } from "../components/GlobalOrderButtons";
import { useLang } from "../components/Language";
import { t, type Lang } from "../components/i18n";

/** Same green pill as the main order button. */
const CLOVER_BTN =
  "inline-flex items-center justify-center rounded-full bg-[#1E7A3A] font-extrabold " +
  "text-white shadow-sm drop-shadow-sm hover:opacity-95 focus:outline-none " +
  "focus:ring-2 focus:ring-[#1E7A3A] focus:ring-offset-2";

const LOCALES: Record<Lang, string> = { tr: "tr-TR", en: "en-US", ar: "ar" };

/**
 * `starts_at` / `ends_at` are DATE columns, so "2026-08-11" means that calendar
 * day — not an instant. Parsing it with `new Date()` lands on UTC midnight,
 * which formats as the previous day anywhere west of Greenwich, so pin both the
 * parse and the format to UTC.
 */
function formatDate(iso: string, lang: Lang): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;

  return new Intl.DateTimeFormat(LOCALES[lang], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

type State =
  | { status: "loading" }
  | { status: "ready"; offers: Offer[] }
  | { status: "error" };

export default function SpecialsPage() {
  const { lang } = useLang();
  const [state, setState] = React.useState<State>({ status: "loading" });

  React.useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!isSupabaseConfigured || !supabase) {
        setState({ status: "error" });
        return;
      }

      const { data, error } = await supabase.rpc("get_active_offers", {
        p_business_id: NAZAR_BUSINESS_ID,
      });

      if (cancelled) return;

      if (error) {
        console.error("[specials] get_active_offers failed", error);
        setState({ status: "error" });
        return;
      }

      setState({ status: "ready", offers: data ?? [] });
    }

    void load();

    // The page is cheap to leave; don't set state on an unmounted component.
    return () => {
      cancelled = true;
    };
  }, []);

  // An empty list and a failed fetch look the same to a customer on purpose:
  // neither is their problem, and both should end at the Clover button.
  const showFallback =
    state.status === "error" ||
    (state.status === "ready" && state.offers.length === 0);

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10">
      <header>
        <h1 className="text-3xl font-extrabold tracking-tight text-zinc-900 sm:text-4xl">
          {t("specials.title", lang)}
        </h1>
        <p className="mt-3 max-w-2xl text-lg font-semibold text-zinc-700">
          {t("specials.subtitle", lang)}
        </p>
      </header>

      {state.status === "loading" && <SpecialsSkeleton />}

      {showFallback && (
        <div className="mt-8 rounded-3xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
          <p className="text-base font-extrabold text-zinc-900">
            {t("specials.empty", lang)}
          </p>

          <a
            href={CLOVER_PICKUP_URL}
            target="_blank"
            rel="noreferrer"
            className={cn(CLOVER_BTN, "mt-5 h-12 w-full max-w-[420px] px-8 text-base")}
          >
            {t("buttons.orderOnline", lang)}
          </a>

          <MarketplaceLinks className="mt-3" />
        </div>
      )}

      {state.status === "ready" && state.offers.length > 0 && (
        <div className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {state.offers.map((offer) => (
            <OfferCard key={offer.id} offer={offer} lang={lang} />
          ))}
        </div>
      )}
    </section>
  );
}

function OfferCard({ offer, lang }: { offer: Offer; lang: Lang }) {
  return (
    <article className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm">
      <h2 className="text-base font-extrabold text-zinc-900">{offer.name}</h2>

      {offer.description && (
        <p className="mt-2 text-sm font-semibold text-zinc-600">{offer.description}</p>
      )}

      {(offer.code || offer.ends_at) && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {offer.code && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-[#1E7A3A]/30 bg-[#1E7A3A]/10 px-3 py-1 text-xs font-extrabold text-[#1E7A3A]">
              <span className="uppercase tracking-wide">{t("specials.code", lang)}</span>
              <span className="font-mono tracking-tight">{offer.code}</span>
            </span>
          )}

          {offer.ends_at && (
            <span className="text-xs font-bold text-zinc-500">
              {t("specials.ends", lang)} {formatDate(offer.ends_at, lang)}
            </span>
          )}
        </div>
      )}

      {/* mt-auto keeps the button on the bottom edge across uneven cards. */}
      <div className="mt-auto pt-5">
        <a
          href={CLOVER_PICKUP_URL}
          target="_blank"
          rel="noreferrer"
          className={cn(CLOVER_BTN, "h-11 w-full px-6 text-sm")}
        >
          {t("specials.orderOnClover", lang)}
        </a>
      </div>
    </article>
  );
}

function SpecialsSkeleton() {
  return (
    <div
      className="mt-8 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3"
      aria-hidden="true"
    >
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="animate-pulse rounded-2xl border border-zinc-200 bg-white p-5"
        >
          <div className="h-4 w-2/3 rounded bg-zinc-200" />
          <div className="mt-3 h-3 w-full rounded bg-zinc-100" />
          <div className="mt-2 h-3 w-4/5 rounded bg-zinc-100" />
          <div className="mt-4 h-6 w-28 rounded-full bg-zinc-100" />
          <div className="mt-5 h-11 w-full rounded-full bg-zinc-200" />
        </div>
      ))}
    </div>
  );
}
