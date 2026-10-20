// Static tool entry points only. No credentials, session IDs, or inferred ocid.
export const staffLinks = {
  clover: { label: "Clover paneli", href: "https://www.clover.com/dashboard" },
  cloverOrder: { label: "Clover online sipariş", href: "https://nazar-bakery-west-haven.cloveronline.com/" },
  supabase: { label: "Supabase · Nazar-production", href: "https://supabase.com/dashboard/project/khgczybubufouraqyrcj" },
  klaviyo: { label: "Klaviyo", href: "https://www.klaviyo.com/dashboard" },
  google_ads: { label: "Google Ads · 647-847-7284", href: "https://ads.google.com/aw/selectaccount" },
  meta: { label: "Meta Ads Manager", href: "https://adsmanager.facebook.com/" },
  reviews: { label: "Google İşletme Profili", href: "https://business.google.com/" },
  writeReview: { label: "Google yorum sayfası", href: "https://search.google.com/local/writereview?placeid=ChIJKTmeJADZ54kRvLZoaDaB9J4" },
  ga4: { label: "GA4 · 551076037", href: "https://analytics.google.com/analytics/web/#/p551076037/reports/intelligenthome" },
  searchConsole: { label: "Search Console", href: "https://search.google.com/search-console" },
  site: { label: "Nazar website", href: "https://www.nazarrestaurantandbakery.com" },
  cloudflare: { label: "Cloudflare · nazar-restaurant-website", href: "https://dash.cloudflare.com/" },
  github: { label: "GitHub · nazar-landing2", href: "https://github.com/nazar-restaurant-bakery/nazar-landing2" },
  scheduler: { label: "İş koşumları · Supabase", href: "https://supabase.com/dashboard/project/khgczybubufouraqyrcj/logs/edge-functions" },
} as const;
