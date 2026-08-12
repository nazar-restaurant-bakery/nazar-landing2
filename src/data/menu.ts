// src/data/menu.tsexport const DOORDASH_URL = ...

// Business identity
export const BUSINESS_NAME = "Nazar Restaurant & Bakery";
export const TAGLINE = "Fresh Turkish flavors—fast, filling, and made with care.";

// Ordering links (customer-facing)
//
// Clover is the primary channel: it handles BOTH pickup and delivery, and it is
// the only one that doesn't take a marketplace commission. The marketplaces
// below stay available, but they are demoted to secondary text links.
export const CLOVER_PICKUP_URL =
  "https://nazar-bakery-west-haven.cloveronline.com/";

export const DOORDASH_URL =
  "https://www.doordash.com/store/nazar-restaurant-&-bakery-west-haven-34962973/92198546/?cursor=eyJzdG9yZV9wcmltYXJ5X3ZlcnRpY2FsX2lkcyI6WzEsMTEwMDQ1LDQsMTAwMzMzXSwiY2Fyb3VzZWxfaWQiOiJyZWNlbnRseV92aWV3ZWQiLCJjYXJvdXNlbF90aXRsZSI6IlJlY2VudGx5IHZpZXdlZCJ9&pickup=false";

// Uber Eats public customer link (kısa ve temiz)
export const UBEREATS_URL =
  "https://www.ubereats.com/store/nazar-restaurant-%26-bakery-west-haven/miDkOS7wSnGYWrbqFRJAEg";

/** @deprecated Older name for {@link UBEREATS_URL}; kept so existing imports keep working. */
export const UBER_EATS_URL = UBEREATS_URL;

export const GRUBHUB_URL =
  "https://www.grubhub.com/restaurant/nazar-bakery--fast-food-39-elm-st-west-haven/12070448";

/** Secondary marketplaces, rendered as the "Also on:" row. */
export const MARKETPLACE_LINKS: Array<{ label: string; url: string }> = [
  { label: "DoorDash", url: DOORDASH_URL },
  { label: "Uber Eats", url: UBEREATS_URL },
  { label: "Grubhub", url: GRUBHUB_URL },
];

export const WEEKLY_SPECIALS_LOGO = "/images/brands/weekly-specials.png";
export const BREAKFAST_IMG = "/images/brands/breakfast.png";

// Contact info
export const PHONE_NUMBER_DISPLAY = "+1 (203) 408-2697";
export const PHONE_NUMBER_TEL = "12034082697";

export const ADDRESS_LINE_1 = "39 Elm Street, Unit 1";
export const ADDRESS_LINE_2 = "West Haven, CT";

// Hours (edit as needed)
export const HOURS: Array<{ day: string; hours: string }> = [
  { day: "Mon", hours: "9:00 AM – 9:00 PM" },
  { day: "Tue", hours: "9:00 AM – 9:00 PM" },
  { day: "Wed", hours: "9:00 AM – 9:00 PM" },
  { day: "Thu", hours: "9:00 AM – 9:00 PM" },
  { day: "Fri", hours: "9:00 AM – 10:00 PM" },
  { day: "Sat", hours: "9:00 AM – 10:00 PM" },
  { day: "Sun", hours: "9:00 AM – 9:00 PM" }
];

// src/data/menuData.ts

export type MenuTag = "Spicy" | "Vegetarian" | "Best Seller" | "New" | "Gluten-Free";

export type MenuItem = {
  id: string;
  name: string;
  description?: string;
  image?: string; // "/images/xxx.jpg" in public/images
  tags?: MenuTag[];
  price?: number; // optional
  pickupUrl?: string;
  deliveryUrl?: string;
};

export type MenuCategory = {
  id: string;
  title: string;
  items: MenuItem[];
};

export const MENU_CATEGORIES: MenuCategory[] = [
  { id: "soups", title: "Soups", items: [] },
  { id: "salads", title: "Salads", items: [] },
  { id: "cold-appetizers", title: "Cold Appetizers", items: [] },
  { id: "sandwiches-wraps", title: "Sandwiches & Wraps", items: [] },
  { id: "hot-appetizers", title: "Hot Appetizers", items: [] },
  { id: "lahmacun-pies", title: "Lahmacun & Pies", items: [] },
  { id: "kebabs", title: "Kebabs", items: [] },
  { id: "kids-menu", title: "Kids Menu", items: [] },
  { id: "breakfast", title: "New Item Breakfast", items: [] },
  { id: "desserts", title: "Desserts", items: [] },
  { id: "beverages", title: "Beverages", items: [] },
  { id: "bakery", title: "Bakery", items: [] },
  { id: "specials", title: "Specials", items: [] },
  { id: "catering", title: "Catering", items: [] }
];
