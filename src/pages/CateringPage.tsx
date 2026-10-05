// src/pages/CateringPage.tsx
import React from "react";
import CateringRequestForm from "../components/CateringRequestForm";
import { useLang } from "../components/Language";
import { t } from "../components/i18n";
import { CATERING_CUSTOM_ITEM_IDS, CATERING_PACKAGES, cateringItemName } from "../data/cateringMenus";
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

export default function CateringPage() {
  useSeo("Turkish Catering in West Haven", "Turkish platters, fresh bread and baklava. Standard catering for 10 to 60 guests; ask us about larger events in West Haven and New Haven.", "/catering");

  const { lang } = useLang();
  const [choice, setChoice] = React.useState<CateringChoice | null>(null);

  function choosePackage(id: string) {
    setChoice({ type: "package", id });
  }

  function toggleCustomItem(id: string) {
    setChoice((current) => {
      const ids = current?.type === "custom" ? current.itemIds : [];
      return {
        type: "custom",
        itemIds: ids.includes(id) ? ids.filter((itemId) => itemId !== id) : [...ids, id],
      };
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

        <div className="mt-6 rounded-2xl border border-zinc-200 bg-emerald-50/50 p-5 sm:p-6">
          <h3 className="text-xl font-extrabold text-zinc-900">{t("catering.customTitle", lang)}</h3>
          <p className="mt-1 text-sm text-zinc-600">{t("catering.customIntro", lang)}</p>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {CATERING_CUSTOM_ITEM_IDS.map((id) => (
              <label key={id} className="flex cursor-pointer items-start gap-2 rounded-xl border border-zinc-200 bg-white p-3 text-sm font-semibold text-zinc-800">
                <input type="checkbox" checked={choice?.type === "custom" && choice.itemIds.includes(id)} onChange={() => toggleCustomItem(id)} className="mt-0.5 accent-[#1E7A3A]" />
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
