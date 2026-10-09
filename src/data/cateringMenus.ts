import type { Lang } from "../components/i18n";
import { MENU_CATEGORIES } from "./menuData";

export type Localized = Record<Lang, string>;

export const CATERING_SIZES = [10, 20, 30, 50] as const;

// Tray quantities and prices are separate from the restaurant's plated menu.
// Chicken wings here are grilled, like the dine-in entree; the separately
// priced deep-fried appetizer is a different preparation.
export const CATERING_TRAYS = [
  { id: "lentil-soup", group: "soup-salad", title: { en: "Lentil Soup", tr: "Mercimek Çorbası", ar: "شوربة العدس" }, unit: "servings", prices: [50, 90, 130, 200] },
  { id: "caesar-salad", group: "soup-salad", title: { en: "Caesar Salad", tr: "Sezar Salata", ar: "سلطة سيزر" }, unit: "servings", prices: [95, 180, 255, 375] },
  { id: "season-salad", group: "soup-salad", title: { en: "Season Salad", tr: "Mevsim Salata", ar: "سلطة الموسم" }, unit: "servings", prices: [95, 180, 255, 375] },
  { id: "shepherd-salad", group: "soup-salad", title: { en: "Shepherd Salad", tr: "Çoban Salata", ar: "سلطة الراعي" }, unit: "servings", prices: [95, 180, 255, 375] },
  { id: "cold-appetizers-platter", group: "appetizers", title: { en: "Cold Appetizers Platter", tr: "Soğuk Meze Tabağı", ar: "طبق المقبلات الباردة" }, unit: "servings", prices: [70, 120, 160, 250] },
  { id: "cheese-rolls", group: "appetizers", title: { en: "Cheese Rolls", tr: "Peynirli Börek", ar: "لفائف الجبن" }, unit: "pieces", prices: [15, 27, 35, 55] },
  { id: "falafel", group: "appetizers", title: { en: "Falafel", tr: "Falafel", ar: "فلافل" }, unit: "pieces", prices: [22, 40, 57, 90], withRice: true },
  { id: "grilled-meatballs", group: "grill", title: { en: "Grilled Meatballs", tr: "Izgara Köfte", ar: "كفتة مشوية" }, unit: "pieces", prices: [25, 45, 66, 105], withRice: true },
  { id: "chicken-wings", group: "grill", title: { en: "Grilled Chicken Wings", tr: "Izgara Tavuk Kanadı", ar: "أجنحة دجاج مشوية" }, unit: "wings", quantities: [70, 140, 210, 350], prices: [170, 320, 450, 720] },
  { id: "chicken-chops", group: "grill", title: { en: "Chicken Chops", tr: "Tavuk Pirzola", ar: "قطع الدجاج المشوية" }, unit: "pieces", quantities: [30, 60, 90, 150], prices: [150, 280, 400, 650], withRice: true },
  { id: "adana-shish", group: "grill", title: { en: "Adana Shish", tr: "Adana Şiş", ar: "شيش أضنة" }, unit: "skewers", prices: [95, 165, 240, 390], withRice: true },
  { id: "chicken-shish", group: "grill", title: { en: "Chicken Shish", tr: "Tavuk Şiş", ar: "شيش دجاج" }, unit: "skewers", prices: [85, 160, 230, 375], withRice: true },
  { id: "meat-gyro", group: "gyro", title: { en: "Meat Gyro", tr: "Et Döner", ar: "جيرو اللحم" }, unit: "lb", quantities: [3.5, 7, 11, 18], prices: [150, 285, 420, 680], withRice: true },
  { id: "chicken-gyro", group: "gyro", title: { en: "Chicken Gyro", tr: "Tavuk Döner", ar: "جيرو الدجاج" }, unit: "lb", quantities: [4, 8, 12, 20], prices: [140, 265, 365, 580], withRice: true },
] as const;

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
