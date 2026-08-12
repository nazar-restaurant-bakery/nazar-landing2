// src/pages/ReviewsPage.tsx
//
// Static content — no database. Everything Talip needs to edit is in the
// PLACEHOLDERS block directly below.

import { Link } from "react-router-dom";
import { useLang } from "../components/Language";
import { t } from "../components/i18n";

/* ========================================================================== */
/* PLACEHOLDERS — edit these, nothing else on this page needs touching        */
/* ========================================================================== */

/** Current Google star rating, e.g. 4.4 */
const GOOGLE_RATING = 4.4;

/** How many Google reviews that rating is based on. */
const GOOGLE_REVIEW_COUNT = 20;

/**
 * "Leave a Review" link — the write-a-review deep link.
 * Get the real one from Google Business Profile → Ask for reviews → Share
 * review form. It looks like: https://g.page/r/<PLACE_ID>/review
 */
const GOOGLE_REVIEW_URL =
  "https://search.google.com/local/writereview?placeid=REPLACE_WITH_PLACE_ID";

/**
 * "Read on Google" link — the public business profile.
 * Replace with the short link from Google Maps → Share → Copy link.
 */
const GOOGLE_PROFILE_URL =
  "https://www.google.com/search?q=Nazar+Restaurant+%26+Bakery+West+Haven+reviews";

/** Curated quotes. Keep 4–6; `stars` is 1–5. */
const REVIEWS: Array<{ name: string; stars: number; text: string }> = [
  {
    name: "Local Customer",
    stars: 5,
    text: "Great Turkish food, fresh and filling. The kebabs are delicious.",
  },
  {
    name: "DoorDash Customer",
    stars: 5,
    text: "Fast delivery and everything arrived hot. Lahmacun was amazing!",
  },
  {
    name: "First-time Visitor",
    stars: 5,
    text: "Friendly service and fair prices. We’ll be back.",
  },
  {
    name: "Weekend Regular",
    stars: 5,
    text: "The bakery case is the reason I keep coming back. Simit is always fresh.",
  },
  {
    name: "Office Lunch Order",
    stars: 4,
    text: "Ordered trays for the whole team. Everything was ready on time and the portions were generous.",
  },
  {
    name: "Neighbor",
    stars: 5,
    text: "Real Turkish breakfast in West Haven. Feels like home.",
  },
];

/* ========================================================================== */

function Stars({ value, className }: { value: number; className?: string }) {
  const rounded = Math.round(value * 2) / 2;
  const full = Math.floor(rounded);
  const hasHalf = rounded - full >= 0.5;
  const empty = 5 - full - (hasHalf ? 1 : 0);

  return (
    <span
      className={className}
      role="img"
      aria-label={`${value} out of 5 stars`}
    >
      <span aria-hidden="true" className="text-amber-500">
        {"★".repeat(full)}
        {hasHalf ? "⯨" : ""}
        <span className="text-zinc-300">{"★".repeat(Math.max(0, empty))}</span>
      </span>
    </span>
  );
}

export default function ReviewsPage() {
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

        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
          <Stars value={GOOGLE_RATING} className="text-xl leading-none" />
          <span className="text-xl font-extrabold text-zinc-900">
            {GOOGLE_RATING.toFixed(1)}
          </span>
          <span className="text-sm font-semibold text-zinc-600">
            {t("reviews.ratedOn", lang)} • {GOOGLE_REVIEW_COUNT}{" "}
            {t("reviews.reviewCount", lang)}
          </span>
        </div>

        <div className="mt-6 flex flex-wrap gap-3">
          <a
            href={GOOGLE_PROFILE_URL}
            target="_blank"
            rel="noreferrer"
            className={ghostBtn}
          >
            {t("reviews.readOnGoogle", lang)}
          </a>

          <a
            href={GOOGLE_REVIEW_URL}
            target="_blank"
            rel="noreferrer"
            className={primaryBtn}
          >
            {t("reviews.leaveReview", lang)}
          </a>

          <Link to="/contact" className={ghostBtn}>
            {t("reviews.contactUs", lang)}
          </Link>
        </div>
      </header>

      {/* Review cards */}
      <h2 className="mt-10 text-lg font-extrabold text-zinc-900">
        {t("reviews.highlightsTitle", lang)}
      </h2>

      <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
        {REVIEWS.map((r) => (
          <figure
            key={r.name}
            className="flex flex-col rounded-2xl border border-zinc-200 bg-white p-5 shadow-sm"
          >
            <Stars value={r.stars} className="text-sm leading-none" />

            <blockquote className="mt-3 text-sm font-semibold text-zinc-700">
              “{r.text}”
            </blockquote>

            <figcaption className="mt-auto pt-4">
              <div className="text-sm font-extrabold text-zinc-900">{r.name}</div>
              <div className="text-xs font-semibold text-zinc-500">West Haven, CT</div>
            </figcaption>
          </figure>
        ))}
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
          href={GOOGLE_REVIEW_URL}
          target="_blank"
          rel="noreferrer"
          className={`${primaryBtn} mt-4`}
        >
          {t("reviews.leaveReview", lang)}
        </a>
      </div>
    </section>
  );
}
