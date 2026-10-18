// src/pages/ReviewsPage.tsx
// Review links resolve to the Google listing so ratings stay current there.

import { Link } from "react-router-dom";
import { useLang } from "../components/Language";
import { t } from "../components/i18n";
import { useSeo } from "../hooks/useSeo";

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
      {/* Review navigation */}
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

      {/* Google maintains the current rating, review count and customer reviews. */}
      <div className="mt-8 rounded-3xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
        <h2 className="text-2xl font-extrabold text-zinc-900">
          {t("reviews.googleTitle", lang)}
        </h2>
        <p className="mx-auto mt-3 max-w-2xl text-sm font-semibold text-zinc-600">
          {t("reviews.googleBody", lang)}
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
