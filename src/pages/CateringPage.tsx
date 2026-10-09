// src/pages/CateringPage.tsx
import React from "react";
import CateringRequestForm from "../components/CateringRequestForm";
import { useLang } from "../components/Language";
import { t } from "../components/i18n";
import { CATERING_CUSTOM_ITEM_IDS, CATERING_PACKAGES, CATERING_SIZES, CATERING_TRAYS, cateringItemName } from "../data/cateringMenus";
import { PHONE_NUMBER_DISPLAY, PHONE_NUMBER_TEL } from "../data/menu";
import { useSeo } from "../hooks/useSeo";
import type { CateringChoice } from "../lib/signup";

const HIGHLIGHTS = [
  {
    en: "Standard catering for 10–60 guests; ask us about larger events",
    tr: "Standart catering 10–60 kişi; daha büyük etkinlikler için bize yazın",
    ar: "التموين المعتاد من 10 إلى 60 ضيفًا؛ راسلنا للمناسبات الأكبر",
  },
  {
    en: "Ask about halal, vegetarian and kid-friendly options",
    tr: "Helal, vejetaryen ve çocuklara uygun seçenekleri sorun",
    ar: "اسأل عن الخيارات الحلال والنباتية والمناسبة للأطفال",
  },
  {
    en: "Pickup or drop-off across the New Haven area",
    tr: "New Haven bölgesinde teslim alma veya adrese bırakma",
    ar: "استلام أو توصيل في منطقة نيوهيفن",
  },
] as const;

const TRAY_GROUPS = [
  { id: "soup-salad", title: { en: "Soups & salads", tr: "Çorbalar ve salatalar", ar: "الشوربات والسلطات" } },
  { id: "appetizers", title: { en: "Appetizers", tr: "Mezeler", ar: "المقبلات" } },
  { id: "grill", title: { en: "From the grill", tr: "Izgaradan", ar: "من الشواية" } },
  { id: "gyro", title: { en: "Gyro by weight", tr: "Ağırlıkla döner", ar: "الجيرو حسب الوزن" } },
] as const;

const TRAY_UNITS = {
  servings: { en: "servings", tr: "porsiyon", ar: "حصة" },
  pieces: { en: "pieces", tr: "adet", ar: "قطعة" },
  wings: { en: "wings", tr: "kanat", ar: "جناح" },
  skewers: { en: "skewers", tr: "şiş", ar: "سيخ" },
  lb: { en: "lb", tr: "lb", ar: "رطل" },
} as const;

export default function CateringPage() {
  useSeo("Turkish Catering in West Haven", "Turkish platters, fresh bread and baklava. Standard catering for 10 to 60 guests; ask us about larger events in West Haven and New Haven.", "/catering");

  const { lang } = useLang();
  const [choice, setChoice] = React.useState<CateringChoice | null>(null);

  function choosePackage(id: string) {
    setChoice({ type: "package", id });
  }

  function toggleCustomItem(id: string) {
    setChoice((current) => {
      const ids = current?.type === "custom" || current?.type === "trays" ? current.itemIds : [];
      const next = ids.includes(id) ? ids.filter((itemId) => itemId !== id) : [...ids, id];
      if (current?.type === "trays") return { ...current, itemIds: next };
      return next.length ? { type: "custom", itemIds: next } : null;
    });
  }

  function selectTray(id: string, size: 10 | 20 | 30 | 50) {
    setChoice((current) => {
      const selections = current?.type === "trays" ? current.selections : [];
      const itemIds = current?.type === "trays" || current?.type === "custom" ? current.itemIds : [];
      const selected = selections.some((item) => item.id === id && item.size === size);
      const next = selected ? selections.filter((item) => item.id !== id) : [
        ...selections.filter((item) => item.id !== id), { id, size },
      ];
      return next.length ? { type: "trays", selections: next, itemIds } :
        itemIds.length ? { type: "custom", itemIds } : null;
    });
  }

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10">
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:items-start">
        {/* Pitch */}
        <div>
          <p className="text-xs font-extrabold uppercase tracking-widest text-[#1E7A3A]">
            Nazar
          </p>

          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-zinc-900 sm:text-4xl">
            {t("catering.title", lang)}
          </h1>

          <p className="mt-3 text-lg font-semibold text-zinc-700">
            {t("catering.subtitle", lang)}
          </p>

          <ul className="mt-6 space-y-3">
            {HIGHLIGHTS.map((item) => (
              <li
                key={item.en}
                className="flex items-start gap-3 text-sm font-semibold text-zinc-700"
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#1E7A3A] text-[11px] font-extrabold text-white"
                >
                  ✓
                </span>
                <span>{item[lang] ?? item.en}</span>
              </li>
            ))}
          </ul>

          <p className="mt-6 text-sm font-semibold text-zinc-700">
            {t("catering.menusTeaserStart", lang)}
            <a href="#catering-menus" className="font-extrabold text-[#1E7A3A] underline underline-offset-2 hover:text-emerald-800">
              {t("catering.menusLinkLabel", lang)}
            </a>
            {t("catering.menusTeaserEnd", lang)}
          </p>

          <p className="mt-6 text-sm font-semibold text-zinc-600">
            <a
              href={`tel:${PHONE_NUMBER_TEL}`}
              className="font-extrabold text-[#1E7A3A] underline underline-offset-2"
            >
              {PHONE_NUMBER_DISPLAY}
            </a>
          </p>
        </div>

        {/* Form */}
        <div id="catering-request" className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <CateringRequestForm menuChoice={choice} onSuccess={() => setChoice(null)} />
        </div>
      </div>

      <div id="catering-menus" className="mt-14 scroll-mt-24">
        <p className="text-xs font-extrabold uppercase tracking-widest text-[#1E7A3A]">Nazar catering</p>
        <h2 className="mt-2 text-2xl font-extrabold text-zinc-900 sm:text-3xl">{t("catering.menusTitle", lang)}</h2>
        <p className="mt-2 max-w-3xl text-sm text-zinc-600">{t("catering.menusIntro", lang)}</p>

        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {CATERING_PACKAGES.map((menu) => {
            const selected = choice?.type === "package" && choice.id === menu.id;
            return (
              <article key={menu.id} className={`overflow-hidden rounded-2xl border bg-white shadow-sm ${selected ? "border-[#1E7A3A] ring-2 ring-[#1E7A3A]" : "border-zinc-200"}`}>
                <img src={menu.image} alt="" className="h-40 w-full object-cover" loading="lazy" />
                <div className="p-5">
                  <h3 className="text-lg font-extrabold text-zinc-900">{menu.title[lang]}</h3>
                  <p className="mt-1 text-sm text-zinc-600">{menu.description[lang]}</p>
                  <ul className="mt-3 space-y-1 text-sm text-zinc-700">
                    {menu.itemIds.map((id) => <li key={id}>• {cateringItemName(id, lang)}</li>)}
                  </ul>
                  <button type="button" aria-pressed={selected} onClick={() => choosePackage(menu.id)} className="mt-5 rounded-full border border-[#1E7A3A] px-5 py-2 text-sm font-bold text-[#1E7A3A] hover:bg-emerald-50 focus:outline-none focus:ring-2 focus:ring-[#1E7A3A] focus:ring-offset-2">
                    {selected ? t("catering.selected", lang) : t("catering.chooseMenu", lang)}
                  </button>
                </div>
              </article>
            );
          })}
        </div>

        <div id="catering-trays" className="mt-12 scroll-mt-24 rounded-3xl bg-[#faf5eb] p-5 sm:p-8">
          <p className="text-xs font-extrabold uppercase tracking-widest text-[#1E7A3A]">Nazar catering</p>
          <h3 className="mt-2 text-2xl font-extrabold text-zinc-900">{t("catering.traysTitle", lang)}</h3>
          <p className="mt-2 max-w-3xl text-sm text-zinc-700">{t("catering.traysIntro", lang)}</p>
          <p className="mt-2 max-w-3xl text-xs text-zinc-600">{t("catering.traysDetails", lang)}</p>

          <div className="mt-6 space-y-8">
            {TRAY_GROUPS.map((group) => (
              <div key={group.id}>
                <h4 className="border-b border-[#d7cbbb] pb-2 text-base font-extrabold text-zinc-900">{group.title[lang]}</h4>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  {CATERING_TRAYS.filter((tray) => tray.group === group.id).map((tray) => (
                    <article key={tray.id} className="rounded-2xl border border-[#e7dccb] bg-white p-4 shadow-sm">
                      <h5 className="font-extrabold text-zinc-900">{tray.title[lang]}</h5>
                      {tray.id === "cold-appetizers-platter" && (
                        <p className="mt-1 text-xs text-zinc-600">{t("catering.platterNote", lang)}</p>
                      )}
                      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-2 lg:grid-cols-4">
                        {CATERING_SIZES.map((size, index) => {
                          const quantity = "quantities" in tray ? tray.quantities[index] : size;
                          const price = tray.prices?.[index];
                          const selected = choice?.type === "trays" && choice.selections.some((item) => item.id === tray.id && item.size === size);
                          return (
                            <button key={size} type="button" aria-pressed={selected} onClick={() => selectTray(tray.id, size)}
                              className={`rounded-xl border px-2 py-2 text-left text-xs focus:outline-none focus:ring-2 focus:ring-[#1E7A3A] ${selected ? "border-[#1E7A3A] bg-emerald-50" : "border-zinc-200 hover:border-[#1E7A3A]"}`}>
                              <span className="block text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{size} {t("catering.guestsShort", lang)}</span>
                              <span className="block font-extrabold text-zinc-900">{quantity} {TRAY_UNITS[tray.unit][lang]}</span>
                              <span className="mt-1 block text-zinc-600">{price === undefined ? t("catering.requestPrice", lang) : `$${price}`}</span>
                            </button>
                          );
                        })}
                      </div>
                    </article>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="mt-6 text-sm text-zinc-700">{t("catering.traysQuoteNote", lang)}</p>
        </div>

        <div className="mt-6 rounded-2xl border border-zinc-200 bg-emerald-50/50 p-5 sm:p-6">
          <h3 className="text-xl font-extrabold text-zinc-900">{t("catering.customTitle", lang)}</h3>
          <p className="mt-1 text-sm text-zinc-600">{t("catering.customIntro", lang)}</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {CATERING_CUSTOM_ITEM_IDS.map((id) => (
              <label key={id} className="flex cursor-pointer items-start gap-2 rounded-xl border border-zinc-200 bg-white p-3 text-sm font-semibold text-zinc-800">
                <input type="checkbox" checked={(choice?.type === "custom" || choice?.type === "trays") && choice.itemIds.includes(id)} onChange={() => toggleCustomItem(id)} className="mt-0.5 accent-[#1E7A3A]" />
                {cateringItemName(id, lang)}
              </label>
            ))}
          </div>
        </div>
        <p className="mt-4 text-sm text-zinc-600">{t("catering.menuNote", lang)}</p>
        <button type="button" onClick={() => document.getElementById("catering-request")?.scrollIntoView({ behavior: "smooth" })} className="mt-4 rounded-full bg-[#1E7A3A] px-6 py-3 text-sm font-extrabold text-white hover:opacity-95">
          {t("catering.continueToQuote", lang)}
        </button>
      </div>
    </section>
  );
}
