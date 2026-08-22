// src/pages/GalleryPage.tsx
import { Link } from "react-router-dom";
import { useSeo } from "../hooks/useSeo";

type GalleryItem = {
  title: string;
  subtitle: string;
  image: string; // URL path in /public
  alt: string;
};

const img = (file: string) => `/images/gallery/${file}`;

// Method 5: images served from /public/images/gallery (no Vite imports)
const GALLERY: GalleryItem[] = [
  {
    title: "Welcome to Nazar",
    subtitle: "West Haven, CT",
    image: img("front-picture.jpg"),
    alt: "Front entrance of Nazar Restaurant & Bakery",
  },
  {
    title: "A Turkish Table",
    subtitle: "Shareable favorites",
    image: img("hero.jpg"),
    alt: "A spread of Turkish dishes on the table",
  },
  {
    title: "Adana Shish",
    subtitle: "Charcoal grilled",
    image: img("adana-shish.jpg"),
    alt: "Adana shish plate",
  },
  {
    title: "Chicken Shish",
    subtitle: "Juicy and smoky",
    image: img("chicken-shish.jpg"),
    alt: "Chicken shish plate",
  },
  {
    title: "Beef Gyro",
    subtitle: "Sliced fresh",
    image: img("beef-gyro.jpg"),
    alt: "Beef gyro plate",
  },
  {
    title: "Gyro Sandwich",
    subtitle: "Fast, filling, classic",
    image: img("beef-gyro-sandwich.jpg"),
    alt: "Beef gyro sandwich",
  },
  {
    title: "Turkish Meatballs",
    subtitle: "Grilled & seasoned",
    image: img("grilled-meatballs.jpg"),
    alt: "Grilled Turkish meatballs plate",
  },
  {
    title: "Lahmacun",
    subtitle: "Thin, crispy, bold flavor",
    image: img("lahmacun.jpg"),
    alt: "Lahmacun",
  },
  {
    title: "Pide",
    subtitle: "Baked bakery favorite",
    image: img("pide.jpg"),
    alt: "Pide breads",
  },
  {
    title: "Cold Mezze",
    subtitle: "Fresh & colorful",
    image: img("mixed-cold-appetizers.jpg"),
    alt: "Mixed cold appetizers and mezze",
  },
  {
    title: "Simit, Poğaça & Açma",
    subtitle: "Bakery classics",
    image: img("simit-pogaca-acma.jpg"),
    alt: "Turkish bakery items: simit, pogaca, and acma",
  },
  {
    title: "Şekerpare",
    subtitle: "Sweet finish",
    image: img("sekerpare.jpg"),
    alt: "Turkish dessert sekerpare",
  },
];

export default function GalleryPage() {
  useSeo("Gallery", "Inside the kitchen and the bakery case at Nazar Restaurant & Bakery, West Haven, CT.", "/gallery");

  return (
    <main>
      {/* Header */}
      <section className="border-b bg-gradient-to-b from-zinc-50 to-white">
        <div className="mx-auto max-w-6xl px-4 py-10">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">
            Gallery
          </h1>
          <p className="mt-2 max-w-2xl text-zinc-600">
            A quick look at what we serve.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">

            <Link
              to="/menu"
              className="inline-flex items-center justify-center rounded-xl border border-brand-border bg-white px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-brand-bg"
            >
              View menu
            </Link>
          </div>
        </div>
      </section>

      {/* Grid */}
      <section className="mx-auto max-w-6xl px-4 py-10">
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {GALLERY.map((item) => (
            <div
              key={item.title}
              className="overflow-hidden rounded-2xl border bg-white shadow-sm"
            >
              <div className="aspect-[4/3] w-full bg-brand-bg">
                <img
                  src={item.image}
                  alt={item.alt}
                  className="h-full w-full object-cover"
                  loading="lazy"
                />
              </div>

              <div className="p-4">
                <div className="text-sm font-semibold text-zinc-900">
                  {item.title}
                </div>
                <div className="mt-1 text-xs text-zinc-500">{item.subtitle}</div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
