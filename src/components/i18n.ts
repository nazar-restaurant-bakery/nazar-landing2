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
      tr: "VIP başvurunuzu aldık. Fırsatlar hazır olduğunda haber vereceğiz.",
      en: "We received your VIP request. We’ll be in touch when offers are ready.",
      ar: "تلقّينا طلب انضمامك إلى VIP. سنتواصل معك عندما تصبح العروض جاهزة.",
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
      tr: "Devam etmek için e-posta iznini işaretleyin.",
      en: "Please tick the email consent box to continue.",
      ar: "يرجى تحديد موافقة البريد الإلكتروني للمتابعة.",
    },
    errorVerification: {
      tr: "Lütfen insan doğrulamasını tamamlayın.",
      en: "Please complete the human verification.",
      ar: "يرجى إكمال التحقق البشري.",
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
    menusTitle: { tr: "Catering menülerimiz", en: "Explore catering menus", ar: "اكتشف قوائم التموين" },
    menusIntro: { tr: "Beş örnek menüden birini seçin veya kendi menünüzü oluşturun. Kişi sayısı, porsiyon ve fiyatı talebinize göre birlikte netleştirelim.", en: "Choose one of five sample menus or create your own. We’ll confirm portions, availability and pricing for your event.", ar: "اختر إحدى القوائم الخمس المقترحة أو أنشئ قائمتك الخاصة. سنؤكد الكميات والتوفر والسعر حسب مناسبتك." },
    traysTitle: { tr: "Catering tepsileri ve kendi seçiminiz", en: "Catering trays & your own selection", ar: "صواني التموين واختيارك الخاص" },
    traysIntro: { tr: "Hazır menülerin altından tek tek ürün seçebilirsiniz. İstediğiniz miktarı işaretleyip teklif formuna geçin.", en: "Choose individual dishes below the prepared menus. Select a quantity, then request a quote.", ar: "اختر أطباقًا منفردة بعد القوائم الجاهزة، ثم حدد الكمية واطلب عرض سعر." },
    traysDetails: { tr: "Salatada bir çeşit seçin. Soğuk meze tabağına Antep ezme, baba ganoush, haydari, humus ve şakşukadan istediğiniz karışımı mesajda yazın. Adet ve ağırlık bilgileri kişi sayısından farklıdır.", en: "Choose one salad. For a cold appetizer platter, tell us your preferred mix of Antep ezme, baba ganoush, haydari, humus and şakşuka in the message. Piece counts and weights are not guest counts.", ar: "اختر نوع سلطة واحدًا. أخبرنا في الرسالة بتشكيلة المقبلات الباردة المفضلة لديك. عدد القطع والوزن ليسا عدد الضيوف." },
    platterNote: { tr: "Tek çeşit veya karışık; içeriği mesajda belirtin.", en: "One variety or mixed; tell us your choice in the message.", ar: "نوع واحد أو تشكيلة؛ اذكر اختيارك في الرسالة." },
    requestPrice: { tr: "Fiyat sor", en: "Ask for price", ar: "اسأل عن السعر" },
    guestsShort: { tr: "kişilik", en: "guests", ar: "ضيفًا" },
    withRice: { tr: "Pilav ile servis edilir.", en: "Served with rice pilav.", ar: "يقدم مع أرز بيلاف." },
    traysQuoteNote: { tr: "Gösterilen tutarlar catering tepsisi içindir; nihai fiyat, içerik ve uygunluk siparişten önce teyit edilir. Kanat fiyatını teklif sırasında netleştiririz.", en: "Shown amounts are for catering trays; we confirm final price, contents and availability before an order. Ask us for chicken wings pricing.", ar: "الأسعار المعروضة لصواني التموين؛ نؤكد السعر النهائي والمحتوى والتوفر قبل الطلب. اسألنا عن سعر أجنحة الدجاج." },
    menusTeaserStart: { tr: "Sizin için hazırladığımız seçenekleri ", en: "Explore the options we've prepared for you in our ", ar: "اطّلع على الخيارات التي أعددناها لك في قسم " },
    menusLinkLabel: { tr: "Catering menülerimizde", en: "Catering Menus", ar: "قوائم التموين" },
    menusTeaserEnd: { tr: " görebilir veya kendi menünüzü oluşturabilirsiniz.", en: " section, or create your own menu.", ar: "، أو أنشئ قائمتك الخاصة." },
    chooseMenu: { tr: "Bu menüyü seç", en: "Choose this menu", ar: "اختر هذه القائمة" },
    selected: { tr: "Seçildi", en: "Selected", ar: "تم الاختيار" },
    customTitle: { tr: "Kendi menünü oluştur", en: "Create your own", ar: "أنشئ قائمتك الخاصة" },
    customIntro: { tr: "İstediğiniz ürünleri işaretleyin. Özel istekleri teklif formunun mesaj alanına ekleyebilirsiniz.", en: "Pick the dishes you’d like. Add special requests in the quote form’s message box.", ar: "اختر الأطباق التي تريدها. أضف الطلبات الخاصة في خانة الرسالة بنموذج عرض السعر." },
    menuNote: { tr: "Bu seçenekler teklif talebi içindir; kesin paket, miktar ve fiyat sipariş öncesinde onaylanır.", en: "These are quote ideas. We’ll confirm the final menu, quantities and price before any order.", ar: "هذه أفكار لطلب عرض سعر. سنؤكد القائمة والكميات والسعر النهائي قبل أي طلب." },
    continueToQuote: { tr: "Teklif formuna git", en: "Go to quote form", ar: "انتقل إلى نموذج عرض السعر" },
    selectedMenu: { tr: "Seçtiğiniz menü", en: "Your menu selection", ar: "القائمة التي اخترتها" },
    viewMenus: { tr: "Menüleri gör / değiştir", en: "View / change menus", ar: "عرض القوائم / تغييرها" },
    noMenu: { tr: "Henüz menü seçilmedi; genel teklif isteyebilirsiniz.", en: "No menu selected yet; you can still request a general quote.", ar: "لم تختر قائمة بعد؛ لا يزال بإمكانك طلب عرض سعر عام." },
    errorCustomItems: { tr: "Kendi menünüz için en az bir ürün seçin.", en: "Choose at least one dish for your custom menu.", ar: "اختر طبقًا واحدًا على الأقل لقائمتك الخاصة." },
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
    capacityNote: { tr: "Standart catering kapasitemiz 10–60 kişidir. Daha kalabalık bir etkinlik için kişi sayısını girin; uygunluğu birlikte değerlendirelim.", en: "Our standard catering range is 10–60 guests. For a larger event, enter your guest count and we’ll check what’s possible.", ar: "نطاق التموين المعتاد لدينا من 10 إلى 60 ضيفًا. للمناسبات الأكبر، أدخل عدد الضيوف وسنتحقق من الخيارات المتاحة." },
    overCapacityNote: { tr: "60 kişiden fazla mı? Etkinliğinizin ayrıntılarını aşağıdaki mesaj alanına yazabilirsiniz. Talebinizi değerlendirip size döneceğiz.", en: "More than 60 guests? Tell us about your event in the message box below. We’ll review your request and get back to you.", ar: "أكثر من 60 ضيفًا؟ اكتب تفاصيل مناسبتك في خانة الرسالة أدناه. سنراجع طلبك ونرد عليك." },
    largeEventMessage: { tr: "Büyük etkinlik ayrıntıları / mesaj", en: "Large event details / message", ar: "تفاصيل المناسبة الكبيرة / الرسالة" },
    largeEventPlaceholder: { tr: "Örn. 80 kişi, etkinlik tarihi, servis şekli ve istediğiniz yemekler…", en: "e.g. 80 guests, event date, serving style and dishes you’d like…", ar: "مثال: 80 ضيفًا، تاريخ المناسبة، طريقة التقديم والأطباق المطلوبة…" },
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
    errorVerification: {
      tr: "Lütfen insan doğrulamasını tamamlayın.",
      en: "Please complete the human verification.",
      ar: "يرجى إكمال التحقق البشري.",
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
  let cur: unknown = translations;
  for (const p of parts) {
    if (typeof cur !== "object" || cur === null || !(p in cur)) return "";
    cur = (cur as Record<string, unknown>)[p];
  }
  if (typeof cur !== "object" || cur === null) return "";
  const localized = cur as Partial<Record<Lang, string>>;
  return localized[lang] ?? localized.en ?? "";
}
