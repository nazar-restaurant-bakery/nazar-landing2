import type { Lang } from "../components/i18n";
import { MENU_CATEGORIES } from "./menuData";

export type Localized = Record<Lang, string>;

export const CATERING_PACKAGES = [
  {
    id: "grill-favorites",
    title: { en: "Grill Favorites", tr: "Izgara Favorileri", ar: "مشاوي نازار المفضلة" },
    description: { en: "A hearty table built around the mixed grill.", tr: "Karışık ızgaranın öne çıktığı doyurucu bir sofra.", ar: "مائدة غنية تتمحور حول المشاوي المشكلة." },
    itemIds: ["mixed-grill", "rice-pilav", "mixed-cold-appetizers", "traditional-turkish-bread"],
    image: "/images/menu/kebabs/mixed-grill.jpg",
  },
  {
    id: "doner-gyro",
    title: { en: "Doner & Gyro Table", tr: "Döner Sofrası", ar: "مائدة الدونر والجيرو" },
    description: { en: "Chicken and meat gyro with familiar sides.", tr: "Tavuk ve et döner, sevilen eşlikçilerle.", ar: "جيرو الدجاج واللحم مع الأطباق الجانبية." },
    itemIds: ["chicken-gyro-plate", "meat-gyro-plate", "rice-pilav", "side-salad"],
    image: "/images/menu/kebabs/chicken-gyro.jpg",
  },
  {
    id: "office-wraps",
    title: { en: "Office Wrap Lunch", tr: "Ofis Dürüm Öğle Yemeği", ar: "غداء اللفائف للمكتب" },
    description: { en: "A mix of chicken gyro and falafel wraps, with a sweet finish.", tr: "Tavuk döner ve falafel dürümleri, tatlı bir kapanışla.", ar: "لفائف جيرو الدجاج والفلافل مع حلوى في الختام." },
    itemIds: ["chicken-gyro-sandwich-wrap", "falafel-wrap-4pcs", "side-salad", "baklava-4pcs"],
    image: "/images/menu/sandwiches/chicken-gyro-wrap.jpg",
  },
  {
    id: "lahmacun-pide",
    title: { en: "Lahmacun & Pide", tr: "Lahmacun ve Pide", ar: "لحم بعجين وبيدا" },
    description: { en: "Brick-oven favorites with a meze selection.", tr: "Taş fırın lezzetleri ve meze çeşitleri.", ar: "مخبوزات الفرن مع تشكيلة من المقبلات." },
    itemIds: ["lahmacun-3pcs", "cheese-pie-kasarli", "mixed-vegetable-pie", "mixed-cold-appetizers"],
    image: "/images/menu/lahmacun-and-pides/lahmacun.jpg",
  },
  {
    id: "vegetarian-table",
    title: { en: "Vegetarian Table", tr: "Vejetaryen Sofra", ar: "المائدة النباتية" },
    description: { en: "Falafel, meze, vegetable pide and fresh bread.", tr: "Falafel, meze, sebzeli pide ve taze ekmek.", ar: "فلافل ومقبلات وبيدا الخضار والخبز الطازج." },
    itemIds: ["falafel-6pcs", "mixed-cold-appetizers", "mixed-vegetable-pie", "traditional-turkish-bread"],
    image: "/images/menu/cold-appetizers/humus.jpg",
  },
] as const;

// The custom builder offers only dishes already listed on the restaurant menu.
export const CATERING_CUSTOM_ITEM_IDS = [
  "mixed-grill", "chicken-shish-plate", "chicken-gyro-plate", "meat-gyro-plate",
  "falafel-6pcs", "lahmacun-3pcs", "cheese-pie-kasarli", "mixed-vegetable-pie",
  "mixed-cold-appetizers", "rice-pilav", "side-salad", "traditional-turkish-bread",
  "borek-feta-cheese", "baklava-4pcs",
] as const;

const allMenuItems = MENU_CATEGORIES.flatMap((category) =>
  category.items ?? category.subcategories?.flatMap((subcategory) => subcategory.items) ?? []
);
const menuById = new Map(allMenuItems.map((item) => [item.id, item]));

export function cateringItemName(id: string, lang: Lang): string {
  const item = menuById.get(id);
  if (!item) return id;
  return lang === "tr" ? item.nameTr ?? item.nameEn : item.nameEn;
}
