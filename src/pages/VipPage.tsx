// src/pages/VipPage.tsx
import VipSignupForm from "../components/VipSignupForm";
import { useLang } from "../components/Language";
import { t } from "../components/i18n";
import { useSeo } from "../hooks/useSeo";

const PERKS = [
  {
    en: "First look at weekly specials and seasonal bakery items",
    tr: "Haftalık fırsatları ve mevsimlik fırın ürünlerini ilk siz görün",
    ar: "اطّلع أولًا على عروض الأسبوع ومخبوزات الموسم",
  },
  {
    en: "Members-only offers you won’t find on delivery apps",
    tr: "Teslimat uygulamalarında olmayan, yalnızca üyelere özel fırsatlar",
    ar: "عروض حصرية للأعضاء لا تجدها على تطبيقات التوصيل",
  },
  {
    en: "A heads-up when catering slots and holiday orders open",
    tr: "Catering ve bayram siparişleri açıldığında haber verelim",
    ar: "تنبيه عند فتح حجوزات التموين وطلبات الأعياد",
  },
] as const;

export default function VipPage() {
  useSeo("VIP List", "Join the VIP list and get our weekly special first. One message a week, always an offer, never spam.", "/vip");

  const { lang } = useLang();

  return (
    <section className="mx-auto w-full max-w-6xl px-4 py-10">
      <div className="grid grid-cols-1 gap-8 md:grid-cols-2 md:items-start">
        {/* Pitch */}
        <div>
          <p className="text-xs font-extrabold uppercase tracking-widest text-[#1E7A3A]">
            Nazar VIP
          </p>

          <h1 className="mt-2 text-3xl font-extrabold tracking-tight text-zinc-900 sm:text-4xl">
            {t("vip.title", lang)}
          </h1>

          <p className="mt-3 text-lg font-semibold text-zinc-700">
            {t("vip.subtitle", lang)}
          </p>

          <ul className="mt-6 space-y-3">
            {PERKS.map((perk) => (
              <li
                key={perk.en}
                className="flex items-start gap-3 text-sm font-semibold text-zinc-700"
              >
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#1E7A3A] text-[11px] font-extrabold text-white"
                >
                  ★
                </span>
                <span>{perk[lang] ?? perk.en}</span>
              </li>
            ))}
          </ul>
        </div>

        {/* Form */}
        <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm sm:p-8">
          <VipSignupForm source="website_vip_page" />
        </div>
      </div>
    </section>
  );
}
