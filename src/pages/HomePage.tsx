// src/pages/HomePage.tsx
import { useMemo } from "react";
import {
  BUSINESS_NAME,
  TAGLINE,
  ADDRESS_LINE_1,
  ADDRESS_LINE_2,
  PHONE_NUMBER_DISPLAY,
  PHONE_NUMBER_TEL,
  CLOVER_PICKUP_URL,
  DOORDASH_URL,
  UBER_EATS_URL,
  GRUBHUB_URL,
} from "../data/menu";

function cn(...classes: Array<string | false | undefined | null>) {
  return classes.filter(Boolean).join(" ");
}

const QUICK_CATS = [
  { id: "soups", label: "Soups" },
  { id: "kebabs", label: "Kebabs" },
  { id: "lahmacun-pies", label: "Lahmacun & Pies" },
  { id: "sandwiches-wraps", label: "Sandwiches & Wraps" },
  { id: "breakfast", label: "Breakfast (New)" },
  { id: "desserts", label: "Desserts" },
  { id: "bakery", label: "Bakery" },
];

export default function HomePage() {
  // Buttons
const orderBtnBase =
  "inline-flex items-center justify-center gap-2 rounded-full px-6 h-11 font-extrabold shadow-sm hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-offset-2";

  const orderBtnText = "text-white drop-shadow-sm";
  const ghostBtn =
    "inline-flex items-center justify-center rounded-full px-6 h-11 min-w-[190px] border border-zinc-300 bg-white text-zinc-900 font-extrabold hover:bg-zinc-50";

  // Build stamp

  // Maps
  const addressLine1 = ADDRESS_LINE_1 || "";
  const addressLine2 = ADDRESS_LINE_2 || "";

  const mapsQuery = useMemo(
    () => encodeURIComponent(`${addressLine1}, ${addressLine2}`),
    [addressLine1, addressLine2]
  );

  const mapsUrl = useMemo(
    () => `https://www.google.com/maps/search/?api=1&query=${mapsQuery}`,
    [mapsQuery]
  );

  const mapsEmbedUrl = useMemo(
    () => `https://www.google.com/maps?q=${mapsQuery}&output=embed`,
    [mapsQuery]
  );

  // Popular cards (your existing approach)
  // ✅ Keep using heroImg for now (as your comment says)
  const popular = [
    { title: "Lentil Soup", sub: "Mercimek", img: "/images/menu/soups/lentil-soup.jpg" },
    { title: "Mixed Grill", sub: "Karışık Izgara", img: "/images/menu/kebabs/mixed-grill.jpg" },
    { title: "Lahmacun", sub: "Lahmacun", img: "/images/menu/lahmacun-and-pides/lahmacun.jpg" },
  ];

  return (
    <div className="bg-transparent">
      {/* HERO */}
      <section className="border-b border-brand-border bg-brand-bg">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <div>
<div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:items-start">
  {/* Left */}
  <div>
    <h1 className="text-4xl font-extrabold tracking-tight text-zinc-900">
      {BUSINESS_NAME}
    </h1>

    <p className="mt-3 text-lg font-semibold text-zinc-700">{TAGLINE}</p>

    <p className="mt-2 text-sm font-semibold text-zinc-500">
      West Haven, CT • Turkish cuisine • Fresh bakery
    </p>


{/* Phone + Address (boxed, stacked) */}
{/* Phone + Address (separate boxes, stacked) */}
<div className="mt-4 w-full max-w-md space-y-3">
  {/* Phone box */}
  <div className="rounded-2xl border border-zinc-200 bg-white p-4">
    <a
      href={`tel:${PHONE_NUMBER_TEL}`}
      className="block text-md font-semibold text-zinc-900 hover:underline"
    >
      {PHONE_NUMBER_DISPLAY}
    </a>
  </div>

  {/* Address box */}
  <div className="rounded-2xl border border-zinc-200 bg-white p-4">
    <a
      href={mapsUrl}
      target="_blank"
      rel="noreferrer"
      className="block text-md font-semibold text-zinc-900 hover:underline"
    >
      {ADDRESS_LINE_1}, {ADDRESS_LINE_2}
    </a>
  </div>
</div>


    {/* Uber + Grubhub */}
    <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2 place-items-center sm:place-items-stretch">
      <a
        href={UBER_EATS_URL}
        target="_blank"
        rel="noreferrer"
        className={cn(
          orderBtnBase,
          "w-full max-w-[260px] sm:max-w-none",
          "bg-[#059669]",
          orderBtnText
        )}
      >
        Delivery (Uber Eats)
      </a>

      <a
        href={GRUBHUB_URL}
        target="_blank"
        rel="noreferrer"
        className={cn(
          orderBtnBase,
          "w-full max-w-[260px] sm:max-w-none",
          "bg-[#D97706]",
          orderBtnText
        )}
      >
        Delivery (Grubhub)
      </a>

      <p className="col-span-full -mt-1 text-center text-sm font-semibold text-zinc-700">
        Prices/availability may vary by platform.
      </p>

      <a href="/menu" className={cn(ghostBtn, "w-full sm:col-span-2")}>
        View Menu
      </a>
    </div>
  </div>

  {/* Right */}
  <div className="flex flex-col gap-4">
    {/* Phone + Address moved here */}


    {/* Image */}
    <div className="overflow-hidden rounded-3xl border border-brand-border">
<img
  src="/images/hero.jpg"
  alt="Nazar food"
  className="h-72 w-full object-cover md:h-96"
  loading="eager"
  fetchPriority="high"
  decoding="async"
/>

    </div>
  </div>
</div>
          </div>
        </div>
      </section>

{/* QUICK CATEGORY CHIPS */}
{/* QUICK CATEGORY CHIPS */}
<section className="bg-transparent">
  <div className="mx-auto max-w-6xl px-4 py-8">
    <div className="rounded-3xl border border-brand-border bg-brand-bg p-5">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-extrabold text-zinc-900">Explore</h2>
        <a href="/menu" className="text-sm font-extrabold text-orange-600">
          Full menu →
        </a>
      </div>

      <div className="mt-4 flex gap-2 overflow-x-auto pb-2">
        {QUICK_CATS.map((c) => (
          <a
            key={c.id}
            href="/menu"
            className={cn(
              "flex-shrink-0 rounded-full border border-brand-border bg-white px-4 py-2 text-sm font-bold text-zinc-900",
              "hover:bg-zinc-50"
            )}
          >
            {c.label}
          </a>
        ))}
      </div>
    </div>
  </div>
</section>

{/* POPULAR ITEMS */}
<section className="bg-transparent">
  <div className="mx-auto max-w-6xl px-4 py-10">
    <div className="flex items-end justify-between gap-4">
      <div>
        <h2 className="text-2xl font-extrabold text-zinc-900">Popular</h2>
        <p className="mt-1 text-sm font-semibold text-zinc-600">
          Best sellers and customer favorites.
        </p>
      </div>
      <a href="/menu" className="text-sm font-extrabold text-orange-600">
        Browse menu →
      </a>
    </div>

    <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {popular.map((x) => (
        <a
          key={x.title}
          href="/menu"
          className="overflow-hidden rounded-2xl border border-zinc-200 bg-white hover:bg-zinc-50"
        >
          <div className="h-44 bg-zinc-100">
            <img
              src={x.img}
              alt={x.title}
              className="h-full w-full object-cover"
            />
          </div>

          <div className="p-4">
            <p className="text-sm font-extrabold text-zinc-900">{x.title}</p>
            <p className="mt-0.5 text-xs font-bold text-zinc-600">{x.sub}</p>
            <p className="mt-3 text-xs font-extrabold text-orange-600">
              View on menu →
            </p>
          </div>
        </a>
      ))}
    </div>
  </div>
</section>


      {/* VISIT US */}
      <section className="bg-transparent">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <h2 className="text-2xl font-extrabold text-zinc-900">Visit us</h2>

          <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
            {/* Left */}
            <div className="rounded-2xl border border-zinc-200 bg-white p-6">
              <p className="text-sm font-extrabold text-zinc-900">Address</p>

              <a
                href={mapsUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-2 block text-sm font-semibold text-zinc-700 hover:underline"
              >
                {ADDRESS_LINE_1}
                <br />
                {ADDRESS_LINE_2}
              </a>

              <p className="mt-5 text-sm font-extrabold text-zinc-900">Phone</p>
              <a
                href={`tel:${PHONE_NUMBER_TEL}`}
                className="mt-2 block text-sm font-semibold text-zinc-700 hover:underline"
              >
                {PHONE_NUMBER_DISPLAY}
              </a>

              <div className="mt-6 flex gap-2">
                <a
                  href={CLOVER_PICKUP_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full bg-brand-primary px-4 py-2 text-sm font-extrabold text-white"
                >
                  Pickup
                </a>
                <a
                  href={DOORDASH_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full bg-brand-dark px-4 py-2 text-sm font-extrabold text-white"
                >
                  Delivery
                </a>
              </div>

              <div className="mt-6">
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-extrabold text-brand-primary hover:underline"
                >
                  Open in Google Maps →
                </a>
              </div>
            </div>

            {/* Right: Map */}
            <div className="overflow-hidden rounded-2xl border border-zinc-200 bg-white">
              <iframe
                title="Nazar on Google Maps"
                src={mapsEmbedUrl}
                className="h-[300px] w-full"
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Mobile sticky CTA bar */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-white">
        <div className="mx-auto flex max-w-6xl gap-2 px-4 py-3">
          <a
            href={CLOVER_PICKUP_URL}
            target="_blank"
            rel="noreferrer"
            className="flex-1 rounded-full bg-orange-500 py-3 text-center font-extrabold text-white"
          >
            Pickup
          </a>
          <a
            href={DOORDASH_URL}
            target="_blank"
            rel="noreferrer"
            className="flex-1 rounded-full bg-zinc-900 py-3 text-center font-extrabold text-white"
          >
            Delivery
          </a>
        </div>
      </div>
    </div>
  );
}
