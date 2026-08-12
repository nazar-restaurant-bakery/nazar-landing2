import React from "react";
import { MENU_CATEGORIES } from "../data/menuData";
import type { MenuCategory, MenuItem, MenuTag } from "../data/menuData";
import { CLOVER_PICKUP_URL } from "../data/menu";

const PH = "/images/placeholder.jpg";

const CATEGORY_FALLBACK: Record<string, string> = {
  soups: "/images/menu/soups/lentil-soup.jpg",
  kebabs: "/images/menu/kebabs/adana-shish.jpg",
  "lahmacun-and-pides": "/images/menu/lahmacun-and-pides/lahmacun.jpg",
  sandwiches: "/images/menu/sandwiches/kokorec.jpg",
  salads: "/images/menu/salads/caesar-salad.jpg",
  "cold-appetizers": "/images/menu/cold-appetizers/humus.jpg",
  "hot-appetizers": "/images/menu/hot-appetizers/french-fries.jpg",
  beverages: "/images/menu/beverages/NazarRestaurant&Bakery_Ayran_2880x2304.jpg",
  kids: "/images/menu/kids/kids-kofte.jpg",
};

function getItemImg(categoryId: string, itemImage?: string) {
  const src = (itemImage || "").trim();
  // If item.image is PH or empty, fall back to category image
  if (!src || src === PH) return CATEGORY_FALLBACK[categoryId] || PH;
  return src;
}

const FILTERS: MenuTag[] = ["Vegetarian", "Spicy", "Best Seller", "New"];

function cn(...classes: Array<string | false | undefined | null>) {
  return classes.filter(Boolean).join(" ");
}

function TagPill({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-brand-border bg-brand-bg px-2 py-1 text-[11px] font-bold text-zinc-700">
      {children}
    </span>
  );
}

function formatPrice(n?: number) {
  if (typeof n !== "number") return "";
  return `$${n.toFixed(2)}`;
}

function itemTitle(item: MenuItem) {
  return item.nameTr ? `${item.nameEn} (${item.nameTr})` : item.nameEn;
}

function cardPriceLine(item: MenuItem) {
  if (typeof item.price === "number" && typeof item.price2 === "number") {
    return `From ${formatPrice(Math.min(item.price, item.price2))}`;
  }
  if (typeof item.price === "number") return formatPrice(item.price);
  if (typeof item.price2 === "number") return formatPrice(item.price2);
  return "";
}

function modalPriceBlock(item: MenuItem) {
  const hasP1 = typeof item.price === "number";
  const hasP2 = typeof item.price2 === "number";
  if (!hasP1 && !hasP2) return null;

  if (hasP1 && hasP2) {
    return (
      <div className="mt-3 rounded-xl border border-brand-border bg-brand-bg p-3">
        <p className="text-xs font-extrabold text-zinc-900">Prices</p>
        <div className="mt-2 grid grid-cols-2 gap-2 text-sm font-semibold text-zinc-800">
          <div className="rounded-lg border border-brand-border bg-white p-2">
            <div className="text-xs font-bold text-zinc-500">
              {item.priceLabel ?? "Small"}
            </div>
            <div className="text-base font-extrabold">{formatPrice(item.price)}</div>
          </div>
          <div className="rounded-lg border border-brand-border bg-white p-2">
            <div className="text-xs font-bold text-zinc-500">
              {item.price2Label ?? "Large"}
            </div>
            <div className="text-base font-extrabold">{formatPrice(item.price2)}</div>
          </div>
        </div>
      </div>
    );
  }

  const singleLabel = hasP1 ? item.priceLabel : item.price2Label;
  const singlePrice = hasP1 ? item.price : item.price2;

  return (
    <div className="mt-3 rounded-xl border border-brand-border bg-brand-bg p-3">
      <p className="text-xs font-extrabold text-zinc-900">Price</p>
      <p className="mt-1 text-base font-extrabold text-zinc-900">
        {singleLabel ? `${singleLabel}: ` : ""}
        {formatPrice(singlePrice)}
      </p>
    </div>
  );
}

function DetailsModal({
  open,
  item,
  categoryTitle,
  categoryId,
  onClose,
}: {
  open: boolean;
  item: MenuItem | null;
  categoryTitle: string | null;
  categoryId: string;
  onClose: () => void;
}) {
  if (!open || !item) return null;

  // Clover covers pickup AND delivery, so one link carries the whole order
  // flow. item.pickupUrl stays as a per-item override if one is ever needed.
  const orderHref = item.pickupUrl ?? CLOVER_PICKUP_URL;

  // Optional fields (if you add later)
  const comesWith = (item as any).comesWith as string | undefined;
  const allergens = (item as any).allergens as string | undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-2xl">
        <div className="grid grid-cols-1 md:grid-cols-2">
          <div className="h-64 bg-brand-bg md:h-full">
            <img
              src={getItemImg(categoryId, item.image)}
              alt={itemTitle(item)}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </div>

          <div className="p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-xl font-extrabold tracking-tight text-zinc-900">
                  {item.nameEn}
                </h3>

                {item.nameTr ? (
                  <p className="mt-1 text-sm font-bold text-zinc-600">{item.nameTr}</p>
                ) : null}

                <p className="mt-2 text-xs font-semibold text-zinc-500">{categoryTitle}</p>
              </div>

              <button
                onClick={onClose}
                className="rounded-full border border-brand-border bg-white px-3 py-1.5 text-sm font-extrabold hover:bg-brand-bg"
                type="button"
                aria-label="Close"
              >
                ✕
              </button>
            </div>

            <div className="mt-3">
              {item.description ? (
                <p className="text-sm leading-relaxed text-zinc-700">{item.description}</p>
              ) : (
                <p className="text-sm text-zinc-500">No description yet.</p>
              )}
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              {(item.tags || []).map((tg) => (
                <TagPill key={tg}>{tg}</TagPill>
              ))}
            </div>

            {modalPriceBlock(item)}

            {comesWith ? (
              <div className="mt-4">
                <p className="text-xs font-extrabold text-zinc-900">What comes with it</p>
                <p className="mt-1 text-sm text-zinc-700">{comesWith}</p>
              </div>
            ) : null}

            {allergens ? (
              <div className="mt-3">
                <p className="text-xs font-extrabold text-zinc-900">Allergens</p>
                <p className="mt-1 text-sm text-zinc-700">{allergens}</p>
              </div>
            ) : null}

            <p className="mt-3 text-xs text-zinc-500">
              Ordering (pickup time, quantity, special instructions, payment) continues on Clover.
            </p>

            <div className="mt-4">
              <a
                href={orderHref}
                target="_blank"
                rel="noopener noreferrer"
                className="block w-full rounded-full bg-[#1E7A3A] py-2 text-center text-sm font-extrabold text-white hover:opacity-95"
              >
                Order Online — Pickup or Delivery
              </a>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function MenuPage() {
  const [activeCatId, setActiveCatId] = React.useState<string>(MENU_CATEGORIES[0]?.id ?? "");
  const [search, setSearch] = React.useState("");
  const [activeFilters, setActiveFilters] = React.useState<Set<MenuTag>>(new Set());
  const [modalItem, setModalItem] = React.useState<MenuItem | null>(null);
  const [modalCatTitle, setModalCatTitle] = React.useState<string | null>(null);

  function toggleFilter(f: MenuTag) {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });
  }

  const filteredCategories: MenuCategory[] = React.useMemo(() => {
    const q = search.trim().toLowerCase();

    const matches = (item: MenuItem) => {
      const text = `${item.nameEn} ${item.nameTr ?? ""} ${item.description ?? ""}`.toLowerCase();
      if (q && !text.includes(q)) return false;

      for (const f of activeFilters) {
        if (!(item.tags ?? []).includes(f)) return false;
      }
      return true;
    };

    return MENU_CATEGORIES
      .map((c) => ({
        ...c,
        subcategories: c.subcategories?.map((sc) => ({
          ...sc,
          items: (sc.items ?? []).filter(matches),
        })),
        items: (c.items ?? []).filter(matches),
      }))
      .filter((c) => {
        const hasItems = c.items?.length > 0;
        const hasSubItems = c.subcategories?.some((sc) => sc.items?.length > 0);
        return q || activeFilters.size ? (hasItems || hasSubItems) : true;
      });
  }, [search, activeFilters]);

  const activeCategory =
    filteredCategories.find((c) => c.id === activeCatId) ?? filteredCategories[0];

  const groups =
    activeCategory?.subcategories?.length
      ? activeCategory.subcategories
      : [
          {
            id: activeCategory?.id ?? "cat",
            title: "",
            items: activeCategory?.items ?? [],
          },
        ];

  return (
    <div className="bg-brand-bg">
      {/* Sticky header */}
      <section className="sticky top-0 z-30 border-b border-brand-border bg-brand-bg/90 backdrop-blur">
        <div className="mx-auto max-w-6xl px-4 py-4">
          <div className="flex flex-col gap-3">
            <h1 className="text-3xl font-extrabold tracking-tight text-brand-ink">
              Menu

            </h1>

            <div className="mt-2 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div className="flex w-full items-center gap-2 rounded-full border border-brand-border bg-white px-4 py-2 shadow-sm md:max-w-md">
                <span className="text-zinc-500">🔎</span>
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search menu items…"
                  className="w-full bg-transparent text-sm outline-none"
                />
              </div>

              <div className="flex flex-wrap gap-2">
                {FILTERS.map((f) => (
                  <button
                    key={f}
                    type="button"
                    onClick={() => toggleFilter(f)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-sm font-semibold transition",
                      activeFilters.has(f)
                        ? "border-orange-300 bg-orange-50 text-orange-900"
                        : "border-brand-border bg-white text-zinc-800 hover:bg-brand-bg"
                    )}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>

            {/* Category chips */}
            <div className="mt-2 flex gap-2 overflow-x-auto pb-2">
              {MENU_CATEGORIES.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setActiveCatId(c.id)}
                  className={cn(
                    "flex-shrink-0 rounded-full border px-4 py-2 text-sm font-extrabold transition",
                    activeCatId === c.id
                      ? "border-orange-300 bg-orange-50 text-orange-900"
                      : "border-brand-border bg-white text-zinc-800 hover:bg-brand-bg"
                  )}
                >
                  {c.title}
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Cards */}
      <div className="mx-auto max-w-6xl px-4 py-6">
        {activeCategory ? (
          <>
            <h2 className="mb-3 text-lg font-extrabold text-zinc-900">
              {activeCategory.title}
            </h2>

            {groups.map((g) => (
              <div key={g.id} className="w-full">
                {g.title ? (
                  <h3 className="mb-3 mt-6 text-lg font-extrabold text-zinc-900">
                    {g.title}
                  </h3>
                ) : null}

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {g.items.map((item) => {
                    const priceLine = cardPriceLine(item);

                    return (
                      <button
                        key={item.id}
                        type="button"
                        className="text-left overflow-hidden rounded-2xl border border-brand-border bg-white"
                        onClick={() => {
                          setModalItem(item);
                          setModalCatTitle(activeCategory.title);
                        }}
                      >
                        <div className="h-44 bg-brand-bg flex items-center justify-center overflow-hidden">
                          <img
                            src={getItemImg(activeCategory.id, item.image)}
                            alt={itemTitle(item)}
                            className="h-full w-full object-contain"
                            loading="lazy"
                          />
                        </div>

                        <div className="p-4">
                          <h3 className="text-sm font-extrabold text-zinc-900">{item.nameEn}</h3>

                          {item.nameTr ? (
                            <p className="mt-0.5 text-xs font-bold text-zinc-600">{item.nameTr}</p>
                          ) : null}

                          {item.description ? (
                            <p className="mt-2 text-sm text-zinc-500 line-clamp-2">
                              {item.description}
                            </p>
                          ) : (
                            <p className="mt-2 text-sm text-zinc-500">—</p>
                          )}

                          <div className="mt-3 flex flex-wrap gap-2">
                            {(item.tags || []).slice(0, 3).map((tg) => (
                              <TagPill key={tg}>{tg}</TagPill>
                            ))}
                          </div>

                          {priceLine ? (
                            <p className="mt-3 text-xs font-extrabold text-zinc-800">{priceLine}</p>
                          ) : null}

                          <p className="mt-3 text-xs font-extrabold text-orange-700">View details →</p>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

{groups.reduce((sum, g) => sum + (g.items?.length ?? 0), 0) === 0 ? (
  <p className="mt-6 text-sm font-semibold text-zinc-600">
    No items match your search/filters.
  </p>
) : null}

          </>
        ) : (
          <p className="text-sm font-semibold text-zinc-600">No menu data found.</p>
        )}
      </div>

      {/* No sticky bar here — Layout renders the one global GlobalOrderStickyBar. */}

      <DetailsModal
        open={!!modalItem}
        item={modalItem}
        categoryTitle={modalCatTitle}
        categoryId={activeCategory?.id ?? "soups"}
        onClose={() => {
          setModalItem(null);
          setModalCatTitle(null);
        }}
      />
    </div>
  );
}

