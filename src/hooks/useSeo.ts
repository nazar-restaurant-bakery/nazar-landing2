import { useEffect } from "react";

const SITE = "Nazar Restaurant & Bakery";
const BASE = "https://www.nazarrestaurantandbakery.com";

function setMeta(selector: string, attr: string, value: string) {
  let el = document.head.querySelector<HTMLMetaElement | HTMLLinkElement>(selector);
  if (!el) return;
  el.setAttribute(attr, value);
}

export function useSeo(title: string, description: string, path: string) {
  useEffect(() => {
    document.title = title === SITE ? title : `${title} — ${SITE}`;
    setMeta('meta[name="description"]', "content", description);
    setMeta('meta[property="og:title"]', "content", document.title);
    setMeta('meta[property="og:description"]', "content", description);
    setMeta('meta[property="og:url"]', "content", `${BASE}${path}`);
    setMeta('link[rel="canonical"]', "href", `${BASE}${path}`);
  }, [title, description, path]);
}
