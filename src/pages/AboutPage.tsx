// src/pages/AboutPage.tsx
import { Link } from "react-router-dom";
import {
  BUSINESS_NAME,
  CLOVER_PICKUP_URL,
  PHONE_NUMBER_DISPLAY,
  PHONE_NUMBER_TEL,
} from "../data/menu";

// Images (make sure these filenames match your folder exactly)
const donerImg = "/images/about/doner.jpg";
const simitPogacaImg = "/images/about/simit-pogaca.jpg";
const lahmacunImg = "/images/about/lahmacun.jpg";
const breadOvenImg = "/images/about/bread-oven.jpg";
const pideImg = "/images/about/pide.jpg";
const ayranImg = "/images/about/ayran.jpg";

type StoryBlock = {
  title: string;
  subtitle: string;
  body: string;
  image: string;
  alt: string;
  reverse?: boolean;
};

const blocks: StoryBlock[] = [
  {
    title: "Döner Kebab",
    subtitle: "Slow-roasted, sliced fresh",
    body:
      "Döner is one of Turkey’s most iconic street foods—seasoned meat layered and cooked slowly until the outside turns beautifully caramelized. We slice it thin, serve it hot, and pair it with fresh salad and house sauces for a comforting, satisfying bite.",
    image: donerImg,

    alt: "Döner kebab on the rotisserie",
  },
  {
    title: "Lahmacun",
    subtitle: "Thin, crispy, and full of flavor",
    body:
      "Often called “Turkish flatbread,” lahmacun is a thin crust topped with a savory blend of spices and minced meat. It’s baked until crisp around the edges, then enjoyed with lemon, herbs, and a fresh salad—simple ingredients, big flavor.",
    image: lahmacunImg,
    alt: "Lahmacun served with herbs and lemon",
    reverse: true,
  },
  {
    title: "Fresh Bread",
    subtitle: "Baked daily, served warm",
    body:
      "Bread is at the heart of Turkish tables. From the oven to your plate, we aim for that perfect balance: a golden crust and a soft, airy inside. Whether you’re eating with breakfast, kebabs, or mezze—fresh bread makes everything better.",
    image: breadOvenImg,
    alt: "Bread baking in an oven",
  },
  {
    title: "Pide",
    subtitle: "A bakery classic, perfect for sharing",
    body:
      "Pide is Turkey’s beloved baked favorite—warm, hearty, and made to gather around. It’s simple, satisfying, and pairs perfectly with tea, ayran, or a full meal. When it’s fresh, the aroma alone feels like home.",
    image: pideImg,
    alt: "Freshly baked pide",
    reverse: true,
  },
  {
    title: "Simit & Poğaça",
    subtitle: "Tea-time essentials",
    body:
      "Simit is the famous sesame-crusted ring—crisp outside, soft inside. Poğaça is the cozy companion: tender, rich pastry that’s perfect with tea. Together, they’re a classic Turkish snack—quick, familiar, and always comforting.",
    image: simitPogacaImg,
    alt: "Simit and poğaça assortment",
  },
  {
    title: "Ayran",
    subtitle: "Cool, creamy, and refreshing",
    body:
      "Ayran is a traditional yogurt drink—lightly salted, chilled, and incredibly refreshing. It’s a perfect match with grilled foods, döner, and spicy dishes, bringing balance to every bite.",
    image: ayranImg,
    alt: "Ayran in a copper cup",
    reverse: true,
  },
];

export default function AboutPage() {
  return (
    <main className="bg-brand-bg">
      {/* Header / Intro */}
      <section className="border-b bg-white">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <div className="max-w-3xl">
            <h1 className="text-3xl font-bold tracking-tight text-neutral-900 md:text-4xl">
  About
</h1>
            <h1 className="mt-3 max-w-3xl text-4xl font-semibold tracking-tight text-zinc-900 md:text-5xl">
  A taste of Turkey, baked and served with care.
</h1>

            <p className="mt-4 text-zinc-600">
              At <span className="font-semibold text-zinc-900">{BUSINESS_NAME}</span>, we
              bring together Turkish bakery traditions and charcoal-grilled favorites—simple,
              fresh, and made to enjoy with family and friends.
            </p>

            <div className="mt-6 flex flex-wrap gap-3">
              <a
                href={`tel:${PHONE_NUMBER_TEL}`}
                className="inline-flex items-center justify-center rounded-xl border border-brand-border bg-white px-5 py-3 text-sm font-semibold text-zinc-900 hover:bg-brand-bg"
              >
                Phone pickup: {PHONE_NUMBER_DISPLAY}
              </a>
              <Link
                to="/menu"
                className="inline-flex items-center justify-center rounded-xl border border-brand-border bg-white px-5 py-3 text-sm font-semibold text-zinc-900 hover:bg-brand-bg"
              >
                View menu
              </Link>
            </div>
          </div>
        </div>
      </section>

      {/* Story Blocks */}
      <section className="mx-auto max-w-6xl px-4 py-10 md:py-14">
        <div className="grid gap-6">
          {blocks.map((b) => (
            <div
              key={b.title}
              className="rounded-3xl border border-brand-border bg-white p-4 shadow-sm md:p-6"
            >
              <div
                className={[
                  "grid items-center gap-6 md:grid-cols-2 md:gap-10",
                  b.reverse ? "md:[&>*:first-child]:order-2" : "",
                ].join(" ")}
              >
                <div className="overflow-hidden rounded-2xl border border-brand-border bg-brand-bg">
                  <img
                    src={b.image}
                    alt={b.alt}
                    className="h-64 w-full object-cover md:h-80"
                    loading="lazy"
                  />
                </div>

                <div>
                  <p className="text-sm font-semibold text-brand">{b.subtitle}</p>
                  <h2 className="mt-2 text-2xl font-extrabold tracking-tight text-zinc-900">
                    {b.title}
                  </h2>
                  <p className="mt-3 text-zinc-600 leading-relaxed">{b.body}</p>

                  <div className="mt-5 flex flex-wrap gap-3">
                    <a
                      href={CLOVER_PICKUP_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center rounded-xl bg-brand px-4 py-2.5 text-sm font-semibold text-white hover:bg-brand-dark"
                    >
                      Order online
                    </a>
                    <Link
                      to="/menu"
                      className="inline-flex items-center justify-center rounded-xl border border-brand-border bg-white px-4 py-2.5 text-sm font-semibold text-zinc-900 hover:bg-brand-bg"
                    >
                      See menu
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Bottom CTA */}
      <section className="border-t bg-white">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <div className="rounded-3xl bg-brand-bg p-6 md:p-8">
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="text-xl font-extrabold text-zinc-900">
                  Ready to order?
                </h3>
                <p className="mt-1 text-zinc-600">
                  Order online or call for pickup — we’ll have it ready.
                </p>
              </div>
              <div className="flex flex-wrap gap-3">
                <a
                  href={CLOVER_PICKUP_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center rounded-xl bg-brand px-5 py-3 text-sm font-semibold text-white hover:bg-brand-dark"
                >
                  Order online
                </a>
                <a
                  href={`tel:${PHONE_NUMBER_TEL}`}
                  className="inline-flex items-center justify-center rounded-xl border border-brand-border bg-white px-5 py-3 text-sm font-semibold text-zinc-900 hover:bg-brand-bg"
                >
                  Call {PHONE_NUMBER_DISPLAY}
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
