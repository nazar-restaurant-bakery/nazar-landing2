// src/pages/CateringPage.tsx
import CateringRequestForm from "../components/CateringRequestForm";
import { useLang } from "../components/Language";
import { t } from "../components/i18n";
import { PHONE_NUMBER_DISPLAY, PHONE_NUMBER_TEL } from "../data/menu";

const HIGHLIGHTS = [
  {
    en: "Trays for 10 to 200 — kebabs, lahmacun, mezes, bakery boxes",
    tr: "10’dan 200 kişiye tepsiler — kebap, lahmacun, meze, fırın kutuları",
    ar: "صواني من 10 إلى 200 شخص — كباب، لحم بعجين، مقبلات، علب مخبوزات",
  },
  {
    en: "Halal, vegetarian and kid-friendly options on every menu",
    tr: "Her menüde helal, vejetaryen ve çocuk dostu seçenekler",
    ar: "خيارات حلال ونباتية ومناسبة للأطفال في كل قائمة",
  },
  {
    en: "Pickup or drop-off across the New Haven area",
    tr: "New Haven bölgesinde teslim alma veya adrese bırakma",
    ar: "استلام أو توصيل في منطقة نيوهيفن",
  },
] as const;

export default function CateringPage() {
  const { lang } = useLang();

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
        <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <CateringRequestForm />
        </div>
      </div>
    </section>
  );
}
