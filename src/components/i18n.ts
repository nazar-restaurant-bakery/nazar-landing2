export type Lang = "tr" | "en" | "ar";

export const LANG_LABEL: Record<Lang, string> = {
  tr: "TR",
  en: "EN",
  ar: "AR",
};

export const RTL_LANGS: Lang[] = ["ar"];

export const translations = {
  nav: {
    home: { tr: "Ana Sayfa", en: "Home", ar: "الرئيسية" },
    menu: { tr: "Menü", en: "Menu", ar: "القائمة" },
    gallery: { tr: "Galeri", en: "Gallery", ar: "الصور" },
    reviews: { tr: "Yorumlar", en: "Reviews", ar: "التقييمات" },
    about: { tr: "Hakkımızda", en: "About", ar: "من نحن" },
    contact: { tr: "İletişim", en: "Contact", ar: "اتصل بنا" },
  },
  buttons: {
    orderOnline: {
      tr: "Online Sipariş — Paket veya Teslimat",
      en: "Order Online — Pickup or Delivery",
      ar: "اطلب عبر الإنترنت — استلام أو توصيل",
    },
    alsoOn: { tr: "Ayrıca:", en: "Also on:", ar: "متوفر أيضًا على:" },
    pickup: { tr: "Pickup (Clover)", en: "Pickup (Clover)", ar: "استلام (Clover)" },
    delivery: { tr: "Delivery (DoorDash)", en: "Delivery (DoorDash)", ar: "توصيل (DoorDash)" },
    viewMenu: { tr: "Menüyü Gör", en: "View Menu", ar: "عرض القائمة" },
    fullMenu: { tr: "Tüm menü →", en: "Full menu →", ar: "القائمة الكاملة →" },
  },
  menu: {
    note: {
      tr: "Sitede görünen fiyatlar bizim fiyatlarımızdır. Pazar yeri (marketplace) fiyatları ve ücretleri değişebilir.",
      en: "Our prices shown. Marketplace prices and fees may vary.",
      ar: "الأسعار المعروضة هي أسعارنا. قد تختلف أسعار ورسوم المنصات الأخرى.",
    },
  },
  vip: {
    title: { tr: "Nazar VIP Kulübü", en: "Nazar VIP Club", ar: "نادي نازار VIP" },
    subtitle: {
      tr: "Özel fırsatlar, yeni ürünler ve haftalık menü — doğrudan sizden bize.",
      en: "Exclusive offers, new items and weekly specials — straight from us, no middleman.",
      ar: "عروض حصرية وأصناف جديدة وعروض الأسبوع — منا إليك مباشرة.",
    },
    name: { tr: "Ad Soyad", en: "Name", ar: "الاسم" },
    email: { tr: "E-posta", en: "Email", ar: "البريد الإلكتروني" },
    phone: { tr: "Telefon", en: "Phone", ar: "رقم الهاتف" },
    optional: { tr: "(isteğe bağlı)", en: "(optional)", ar: "(اختياري)" },
    consentEmail: {
      tr: "Fırsat ve güncellemeler için e-posta almak istiyorum.",
      en: "Email me offers and updates.",
      ar: "أرسلوا لي العروض والتحديثات عبر البريد الإلكتروني.",
    },
    consentSms: {
      tr: "Fırsatlar için SMS almak istiyorum.",
      en: "Text me offers.",
      ar: "أرسلوا لي العروض عبر الرسائل النصية.",
    },
    submit: { tr: "VIP Kulübe Katıl", en: "Join the VIP Club", ar: "انضم إلى نادي VIP" },
    submitting: { tr: "Gönderiliyor…", en: "Joining…", ar: "جارٍ الإرسال…" },
    success: {
      tr: "Aramıza hoş geldiniz! İlk fırsatınızı yakında göndereceğiz.",
      en: "You’re in! Watch for your first offer soon.",
      ar: "تم تسجيلك! ترقّب أول عرض قريبًا.",
    },
    errorContact: {
      tr: "Lütfen e-posta veya telefon numarası girin.",
      en: "Please enter an email address or a phone number.",
      ar: "يرجى إدخال بريد إلكتروني أو رقم هاتف.",
    },
    errorEmail: {
      tr: "Lütfen geçerli bir e-posta adresi girin.",
      en: "Please enter a valid email address.",
      ar: "يرجى إدخال بريد إلكتروني صالح.",
    },
    errorPhone: {
      tr: "Lütfen 10 haneli geçerli bir telefon numarası girin.",
      en: "Please enter a valid 10-digit phone number.",
      ar: "يرجى إدخال رقم هاتف صالح مكوّن من 10 أرقام.",
    },
    errorConsent: {
      tr: "Devam etmek için en az bir iletişim iznini işaretleyin.",
      en: "Please tick at least one box so we know how to reach you.",
      ar: "يرجى تحديد خيار واحد على الأقل لنعرف كيفية التواصل معك.",
    },
    errorGeneric: {
      tr: "Kaydınızı alamadık. Lütfen tekrar deneyin veya bizi arayın.",
      en: "We couldn’t save that. Please try again, or give us a call.",
      ar: "تعذّر حفظ البيانات. حاول مرة أخرى أو اتصل بنا.",
    },
    errorOffline: {
      tr: "VIP formu şu anda kullanılamıyor. Lütfen bizi arayın.",
      en: "The VIP form isn’t available right now. Please give us a call.",
      ar: "نموذج VIP غير متاح حاليًا. يرجى الاتصال بنا.",
    },
    privacy: {
      tr: "Verilerinizi yalnızca Nazar kullanır. İstediğiniz zaman çıkabilirsiniz.",
      en: "Only Nazar uses your details. Unsubscribe any time.",
      ar: "نحن وحدنا نستخدم بياناتك. يمكنك إلغاء الاشتراك في أي وقت.",
    },
  },
  specials: {
    title: { tr: "Haftanın Fırsatları", en: "Weekly Specials", ar: "عروض الأسبوع" },
    subtitle: {
      tr: "Doğrudan bizden sipariş verin — en iyi fiyat burada.",
      en: "Order straight from us — this is where the best price lives.",
      ar: "اطلب منا مباشرة — أفضل سعر تجده هنا.",
    },
    code: { tr: "Kod", en: "Code", ar: "الرمز" },
    ends: { tr: "Son gün", en: "Ends", ar: "ينتهي" },
    orderOnClover: {
      tr: "Clover’da Sipariş Ver",
      en: "Order on Clover",
      ar: "اطلب عبر Clover",
    },
    empty: {
      tr: "Yeni fırsatlar her hafta geliyor — yakında tekrar bakın.",
      en: "New specials drop weekly — check back soon.",
      ar: "عروض جديدة كل أسبوع — عد قريبًا.",
    },
  },
  catering: {
    title: { tr: "Catering ve Büyük Siparişler", en: "Catering & Large Orders", ar: "التموين والطلبات الكبيرة" },
    subtitle: {
      tr: "Doğum günü, ofis toplantısı, düğün — tepsi usulü hazırlıyoruz. Detayları bırakın, size dönelim.",
      en: "Birthdays, office lunches, weddings — we cook by the tray. Leave your details and we’ll get back to you.",
      ar: "أعياد ميلاد، غداء مكتبي، أعراس — نحضّر بالصواني. اترك بياناتك وسنعاود التواصل معك.",
    },
    name: { tr: "Ad Soyad", en: "Name", ar: "الاسم" },
    email: { tr: "E-posta", en: "Email", ar: "البريد الإلكتروني" },
    phone: { tr: "Telefon", en: "Phone", ar: "رقم الهاتف" },
    eventDate: { tr: "Etkinlik tarihi", en: "Event date", ar: "تاريخ المناسبة" },
    guests: { tr: "Kişi sayısı", en: "Guest count", ar: "عدد الضيوف" },
    message: { tr: "Mesaj / istediğiniz ürünler", en: "Message / items you’d like", ar: "رسالة / الأصناف المطلوبة" },
    messagePlaceholder: {
      tr: "Örn. 40 kişilik karışık ızgara tepsisi, 2 tepsi lahmacun…",
      en: "e.g. mixed grill tray for 40, 2 trays of lahmacun…",
      ar: "مثال: صينية مشاوي مشكّلة لـ 40 شخصًا، صينيتا لحم بعجين…",
    },
    optional: { tr: "(isteğe bağlı)", en: "(optional)", ar: "(اختياري)" },
    submit: { tr: "Teklif İste", en: "Request a Quote", ar: "اطلب عرض سعر" },
    submitting: { tr: "Gönderiliyor…", en: "Sending…", ar: "جارٍ الإرسال…" },
    success: {
      tr: "Talebiniz bize ulaştı! Genellikle bir iş günü içinde dönüş yapıyoruz.",
      en: "Got it! We usually reply within one business day.",
      ar: "وصلنا طلبك! نردّ عادةً خلال يوم عمل واحد.",
    },
    another: { tr: "Yeni bir talep gönder", en: "Send another request", ar: "إرسال طلب آخر" },
    errorContact: {
      tr: "Lütfen e-posta veya telefon numarası girin.",
      en: "Please enter an email address or a phone number.",
      ar: "يرجى إدخال بريد إلكتروني أو رقم هاتف.",
    },
    errorEmail: {
      tr: "Lütfen geçerli bir e-posta adresi girin.",
      en: "Please enter a valid email address.",
      ar: "يرجى إدخال بريد إلكتروني صالح.",
    },
    errorPhone: {
      tr: "Lütfen 10 haneli geçerli bir telefon numarası girin.",
      en: "Please enter a valid 10-digit phone number.",
      ar: "يرجى إدخال رقم هاتف صالح مكوّن من 10 أرقام.",
    },
    errorGeneric: {
      tr: "Talebinizi alamadık. Lütfen tekrar deneyin veya bizi arayın.",
      en: "We couldn’t send that. Please try again, or give us a call.",
      ar: "تعذّر إرسال الطلب. حاول مرة أخرى أو اتصل بنا.",
    },
    errorOffline: {
      tr: "Form şu anda kullanılamıyor. Lütfen bizi arayın.",
      en: "The form isn’t available right now. Please give us a call.",
      ar: "النموذج غير متاح حاليًا. يرجى الاتصال بنا.",
    },
    privacy: {
      tr: "Bilgilerinizi yalnızca bu talep için kullanırız.",
      en: "We only use your details to answer this request.",
      ar: "نستخدم بياناتك للردّ على هذا الطلب فقط.",
    },
  },
  reviews: {
    title: { tr: "Yorumlar", en: "Reviews", ar: "التقييمات" },
    ratedOn: { tr: "Google’da puanımız", en: "Rated on Google", ar: "تقييمنا على Google" },
    reviewCount: { tr: "yorum", en: "reviews", ar: "تقييم" },
    readOnGoogle: { tr: "Google’da Oku", en: "Read on Google", ar: "اقرأ على Google" },
    readOurReviews: {
      tr: "Yorumlarımızı Google’da okuyun",
      en: "Read our reviews on Google",
      ar: "اقرأ تقييماتنا على Google",
    },
    leaveReview: { tr: "Yorum Yaz", en: "Leave a Review", ar: "اكتب تقييمًا" },
    contactUs: { tr: "Bize ulaşın", en: "Contact us", ar: "اتصل بنا" },
    highlightsTitle: {
      tr: "Müşterilerimiz ne diyor",
      en: "What customers say",
      ar: "ماذا يقول عملاؤنا",
    },
    ctaTitle: {
      tr: "Bir yorum bırakmak ister misiniz?",
      en: "Want to leave a review?",
      ar: "هل ترغب في كتابة تقييم؟",
    },
    ctaBody: {
      tr: "Yorumlar, bizi arayan komşularımızın bulmasına yardımcı oluyor — küçük bir işletmeyi desteklediğiniz için teşekkürler.",
      en: "Reviews help local customers find us — thank you for supporting a small business.",
      ar: "التقييمات تساعد الزبائن في الحيّ على إيجادنا — شكرًا لدعمك عملًا صغيرًا.",
    },
  },
} as const;

export function t(path: string, lang: Lang): string {
  // path ör: "menu.note" veya "nav.home"
  const parts = path.split(".");
  let cur: any = translations;
  for (const p of parts) cur = cur?.[p];
  return cur?.[lang] ?? cur?.en ?? "";
}
