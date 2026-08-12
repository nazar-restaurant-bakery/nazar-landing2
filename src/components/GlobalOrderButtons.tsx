// src/components/GlobalOrderButtons.tsx
import { CLOVER_PICKUP_URL, MARKETPLACE_LINKS } from "../data/menu";
import { useLang } from "./Language";
import { t } from "./i18n";

function cn(...classes: Array<string | false | undefined | null>) {
  return classes.filter(Boolean).join(" ");
}

type Props = {
  variant?: "top" | "bottom";
  className?: string;
};

/**
 * Clover is the primary ordering channel — it covers pickup *and* delivery, so
 * it gets the one prominent button. The marketplaces sit underneath as small
 * text links.
 */
export default function OrderButtonsRow({ variant = "top", className }: Props) {
  const { lang } = useLang();
  const isTop = variant === "top";

  const wrap = cn(
    "mx-auto w-full max-w-4xl flex flex-col items-center",
    isTop ? "gap-3" : "gap-2",
    className
  );

  const primaryBtn = cn(
    "inline-flex items-center justify-center rounded-full font-extrabold shadow-sm",
    "bg-[#1E7A3A] text-white drop-shadow-sm",
    "hover:opacity-95 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-[#1E7A3A]",
    "w-full text-center",
    isTop
      ? "h-12 px-8 text-base max-w-[420px]"
      : "h-11 px-6 text-sm max-w-[380px]"
  );

  return (
    <div className={wrap}>
      <a
        href={CLOVER_PICKUP_URL}
        target="_blank"
        rel="noreferrer"
        className={primaryBtn}
      >
        {t("buttons.orderOnline", lang)}
      </a>

      <MarketplaceLinks />
    </div>
  );
}

/** Small secondary "Also on:" row of marketplace text links. */
export function MarketplaceLinks({ className }: { className?: string }) {
  const { lang } = useLang();

  return (
    <p
      className={cn(
        "flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-zinc-500",
        className
      )}
    >
      <span className="font-semibold">{t("buttons.alsoOn", lang)}</span>

      {MARKETPLACE_LINKS.map((m, i) => (
        <span key={m.label} className="inline-flex items-center gap-2">
          {i > 0 && <span aria-hidden="true">·</span>}
          <a
            href={m.url}
            target="_blank"
            rel="noreferrer"
            className="font-semibold underline underline-offset-2 hover:text-zinc-800"
          >
            {m.label}
          </a>
        </span>
      ))}
    </p>
  );
}

// ✅ This named export must exist because Layout imports it.
export function GlobalOrderStickyBar() {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-white">
      <div className="px-2 py-3">
        <OrderButtonsRow variant="bottom" />
      </div>
    </div>
  );
}
