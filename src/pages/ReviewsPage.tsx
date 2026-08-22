// src/pages/ReviewsPage.tsx
//
// Static content — no database. Everything Talip needs to edit is in the
// PLACEHOLDERS block directly below.

import { Link } from "react-router-dom";
import { useLang } from "../components/Language";
import { t } from "../components/i18n";
import { useSeo } from "../hooks/useSeo";

/* ========================================================================== */
/* PLACEHOLDERS — edit these, nothing else on this page needs touching        */
/* ========================================================================== */

/** Current Google star rating. */
const GOOGLE_RATING = 4.7;

/** How many Google reviews that rating is based on. */
const GOOGLE_REVIEW_COUNT = 46;

/**
 * The Google Maps listing — this is where the reviews live. Official Maps URLs
 * API format, pinned with `query_place_id` so it resolves to this exact record
 * rather than whatever a name search happens to rank first.
 */
const GOOGLE_PROFILE_URL =
  "https://www.google.com/maps/search/?api=1&query=Nazar%20Restaurant%20%26%20Bakery&query_place_id=ChIJKTmeJADZ54kRvLZoaDaB9J4";

/**
 * Google Place ID for Nazar Restaurant & Bakery, 39 Elm St, West Haven CT.
 * Derived from feature-id 0x89e7d900249e3929:0x9ef481366868b6bc (CID
 * 11453921822989924028). Set, so WRITE_REVIEW_URL below is the one-click
 * review dialog; blanking it falls back to the profile link.
 */
const GOOGLE_PLACE_ID: string = "ChIJKTmeJADZ54kRvLZoaDaB9J4";

/** "Leave a Review" link. */
const WRITE_REVIEW_URL = GOOGLE_PLACE_ID
  ? `https://search.google.com/local/writereview?placeid=${GOOGLE_PLACE_ID}`
  : GOOGLE_PROFILE_URL;

// NOTE: no testimonial quotes live on this page. We do not write our own
// reviews. TODO(Talip): if you want snippets here, copy them verbatim from the
// real Google listing (reviewer name + text as written) and add them below.

/* ========================================================================== */

/**
 * Fractional star bar: a grey row of five stars with an amber row clipped over
 * it. Uses only the ★ glyph — a dedicated half-star character renders as a tofu
 * box in plenty of fonts, and 4.7 needs a partial star to be honest.
 */
function Stars({ value, className }: { value: number; className?: string }) {
  const pct = Math.max(0, Math.min(100, (value / 5) * 100));

  return (
    <span
      className={`relative inline-block whitespace-nowrap ${className ?? ""}`}
      role="img"
      aria-label={`${value} out of 5 stars`}
    >
      <span aria-hidden="true" className="text-zinc-300">
        ★★★★★
      </span>
      <span
        aria-hidden="true"
        className="absolute inset-0 overflow-hidden text-amber-500"
        style={{ width: `${pct}%` }}
      >
        ★★★★★
      </span>
    </span>
  );
}

export default function ReviewsPage() {
  useSeo("Reviews", "What our neighbors say about Nazar Restaurant & Bakery in West Haven, CT.", "/reviews");

  const { lang } = useLang();

  const primaryBtn =
    "inline-flex h-11 items-center justify-center rounded-full bg-[#1E7A3A] px-6 " +
    "text-sm font-extrabold text-white shadow-sm hover:opacity-95 " +
    "focus:outline-none focus:ring-2 focus:ring-[#1E7A3A] focus:ring-offset-2";

  const ghostBtn =
    "inline-flex h-11 items-center justify-center rounded-full border border-zinc-300 " +
    "bg-white px-6 text-sm font-extrabold text-zinc-900 hover:bg-zinc-50";

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10">
      {/* Rating summary */}
      <header>
        <h1 className="text-3xl font-extrabold tracking-tight text-zinc-900 sm:text-4xl">
          {t("reviews.title", lang)}
        </h1>

        <div className="mt-6 flex flex-wrap gap-3">
          <a
            href={GOOGLE_PROFILE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={ghostBtn}
          >
            {t("reviews.readOnGoogle", lang)}
          </a>

          <a
            href={WRITE_REVIEW_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={primaryBtn}
          >
            {t("reviews.leaveReview", lang)}
          </a>

          <Link to="/contact" className={ghostBtn}>
            {t("reviews.contactUs", lang)}
          </Link>
        </div>
      </header>

      {/* Rating summary — real Google numbers, no quotes we wrote ourselves. */}
      <div className="mt-8 rounded-3xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <Stars value={GOOGLE_RATING} className="text-3xl leading-none" />

        <p className="mt-3 text-4xl font-extrabold text-zinc-900">
          {GOOGLE_RATING.toFixed(1)}
        </p>

        <p className="mt-1 text-sm font-semibold text-zinc-600">
          {t("reviews.ratedOn", lang)} • {GOOGLE_REVIEW_COUNT}{" "}
          {t("reviews.reviewCount", lang)}
        </p>

        <a
          href={GOOGLE_PROFILE_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={`${primaryBtn} mt-6`}
        >
          {t("reviews.readOurReviews", lang)}
        </a>
      </div>

      {/* CTA */}
      <div className="mt-8 rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
        <p className="text-base font-extrabold text-zinc-900">
          {t("reviews.ctaTitle", lang)}
        </p>
        <p className="mt-2 max-w-2xl text-sm font-semibold text-zinc-600">
          {t("reviews.ctaBody", lang)}
        </p>

        <a
          href={WRITE_REVIEW_URL}
          target="_blank"
          rel="noopener noreferrer"
          className={`${primaryBtn} mt-4`}
        >
          {t("reviews.leaveReview", lang)}
        </a>
      </div>
    </section>
  );
}
