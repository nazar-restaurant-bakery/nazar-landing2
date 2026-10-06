// src/data/menuData.ts

export type MenuTag = "Spicy" | "Vegetarian" | "Best Seller" | "New";

export type MenuItem = {
  id: string;
  nameEn: string;
  nameTr?: string;

  price?: number;
  priceLabel?: string;
  price2?: number;
  price2Label?: string;

  description?: string;
  comesWith?: string;
  allergens?: string;
  image?: string;
  tags?: MenuTag[];
  pickupUrl?: string;
  deliveryUrl?: string;
};

export type MenuSubcategory = {
  id: string;
  title: string;
  items: MenuItem[];
};

export type MenuCategory = {
  id: string;
  title: string;

  // either can exist
  items?: MenuItem[];
  subcategories?: MenuSubcategory[];
};


// Keep Breakfast here for the upcoming rewrite, but do not expose it to customers yet.
const ALL_MENU_CATEGORIES: MenuCategory[] = [
  // ---------------- Breakfast ----------------
  {
    id: "breakfast",
    title: "Breakfast",
    subcategories: [
      {
        id: "omelets",
        title: "Omelets",
        items: [
          {
            id: "egg-with-sujuk",
            nameEn: "Egg with Sujuk",
            price: 9.99,
            description:
              "Sunny side up eggs served with sujuk (Turkish spicy sausage) and served with a french fries.",
            image: "/images/menu/breakfast/egg-with-sujuk.jpg",
          },
          {
            id: "menemen",
            nameEn: "Menemen",
            price: 10.99,
            description:
              "Turkish-style omelet with tomatoes, peppers, and spices and served with a french fries.",
            image: "/images/menu/breakfast/menemen.jpg",
          },
          {
            id: "cheese-omelette",
            nameEn: "Cheese Omelette",
            price: 9.99,
            description:
              "A fluffy omelette filled with cheese and served with a french fries.",
            image: "/images/menu/breakfast/cheese-omelette.jpg",
          },
          {
            id: "gyro-omelette",
            nameEn: "Gyro Omelette",
            price: 11.99,
            description:
              "A fluffy omelette filled with gyro meat and served with a french fries.",
            image: "/images/menu/breakfast/gyro-omelette.jpg",
          },
          {
            id: "vegetarian-omelette",
            nameEn: "Vegetarian Omelette",
            price: 9.99,
            description:
              "A fluffy omelette filled with vegetables (tomato, peppers, onions) and served with a french fries.",
            image: "/images/menu/breakfast/vegetarian-omelette.jpg",
          },
          {
            id: "mushroom-omelette",
            nameEn: "Mushroom Omelette",
            price: 9.99,
            description:
              "A fluffy omelette filled with mushrooms and served with a french fries.",
            image: "/images/menu/breakfast/mushroom-omelette.jpg",
          },
          {
            id: "florantine-omelette",
            nameEn: "Florantine Omelette",
            price: 11.99,
            description:
              "A fluffy omelette filled with spinach, feta cheese, onions and served with a french fries.",
            image: "/images/menu/breakfast/florantine-omelette.jpg",
          },
        ],
      },

      {
        id: "gozleme",
        title: "Gözleme (Quesadilla)",
        items: [
          {
            id: "gozleme-potato",
            nameEn: "Gözleme with potato",
            nameTr: "Patatesli Gözleme",
            price: 8.99,
            description: "Griddled flatbread filled with potato.",
            image: "/images/menu/breakfast/gozleme-with-potato.jpg",
          },
          {
            id: "gozleme-feta-cheese",
            nameEn: "Gözleme with feta cheese",
            nameTr: "Peynirli Gözleme",
            price: 8.99,
            description: "Griddled flatbread filled with feta cheese.",
            image: "/images/menu/breakfast/gozleme-with-feta-cheese.jpg",
          },
          {
            id: "gozleme-ground-beef",
            nameEn: "Gözleme with ground beef",
            nameTr: "Kıymalı Gözleme",
            price: 9.99,
            description: "Griddled flatbread filled with ground beef.",
            image: "/images/menu/breakfast/gozleme-with-ground-beef.jpg",
          },
          {
            id: "gozleme-spinach-feta-cheese",
            nameEn: "Gözleme with spinach and feta cheese",
            nameTr: "Ispanaklı Peynirli Gözleme",
            price: 9.99,
            description: "Griddled flatbread filled with spinach and feta cheese.",
            // (you may want to add .jpg if the real file has it)
            image: "/images/menu/breakfast/gozleme-with-spinach-feta.jpg",
          },
        ],
      },
    ],
  },

  // ---------------- Soups ----------------
  {
    id: "soups",
    title: "Soups",
    items: [
      {
        id: "lentil-soup",
        nameEn: "Lentil Soup",
        nameTr: "Mercimek",
        description: "Lentils blended with seasoning",
        image: "/images/menu/soups/lentil-soup.jpg",
        tags: ["Vegetarian", "Best Seller"],
        price: 5.99,
      },
      {
        id: "soup-of-the-day",
        nameEn: "Soup of the Day",
        nameTr: "Günün Çorbası",
        description: "Please ask for the soup of the day.",
        image: "/images/menu/soups/soup-of-the-day.jpg",
        tags: ["New"],
        price: 5.99,
      },
      {
        id: "trotter-soup",
        nameEn: "Trotter Soup",
        nameTr: "Paça Çorbası",
        description: "Hearty soup made from slow-simmered lamb or beef trotters.",
        image: "/images/menu/soups/trotter-soup.png",
        price: 9.99,
      },
    ],
  },

  // ---------------- Salads ----------------
  {
    id: "salads",
    title: "Salads",
    items: [
      {
        id: "caesar-salad",
        nameEn: "Caesar Salad",
        nameTr: "Sezar Salata",
        description:
          "Crisp romaine lettuce tossed with croutons, parmesan cheese, and classic Caesar dressing.",
        image: "/images/menu/salads/caesar-salad.jpg",
        price: 10.99,
      },
      {
        id: "season-salad",
        nameEn: "Season Salad",
        nameTr: "Mevsim Salata",
        description:
          "A vibrant blend of lettuce, carrots, and red cabbage, drizzled with olive oil.",
        image: "/images/menu/salads/season-salad.jpg",
        tags: ["Vegetarian"],
        price: 10.99,
      },
      {
        id: "shepherd-salad",
        nameEn: "Shepherd Salad",
        nameTr: "Çoban Salata",
        description:
          "Diced tomatoes, cucumbers, peppers, parsley, and onions. Seasoned with olive oil, salt, and lemon juice.",
        image: "/images/menu/salads/shepherd-salad.jpg",
        tags: ["Vegetarian"],
        price: 10.99,
      },
    ],
  },

  // ---------------- Cold Appetizers ----------------
  {
    id: "cold-appetizers",
    title: "Cold Appetizers",
    items: [
      {
        id: "antep-ezme",
        nameEn: "Antep Ezme",
        description:
          "Minced spicy dip prepared with tomatoes, peppers, onions, parsley, garlic, olive oil, lemon juice, and Turkish spices.",
        image: "/images/menu/cold-appetizers/antep-ezme.jpg",
        tags: ["Spicy"],
        price: 8.99,
      },
      {
        id: "baba-ganoush",
        nameEn: "Baba Ganoush",
        description:
          "Roasted eggplant mashed with tahini, garlic, white pepper, mayonnaise, and olive oil.",
        image: "/images/menu/cold-appetizers/baba-ganoush.jpeg",
        tags: ["Vegetarian"],
        price: 8.99,
      },
      {
        id: "haydari",
        nameEn: "Haydari",
        description:
          "Thick labneh mixed with sour cream, dill, crushed walnuts, mayonnaise, olive oil, and a pinch of salt.",
        image: "/images/menu/cold-appetizers/haydari.jpg",
        tags: ["Vegetarian"],
        price: 8.99,
      },
      {
        id: "humus",
        nameEn: "Humus",
        description:
          "Smooth chickpea puree mixed with tahini, garlic, olive oil, and white pepper.",
        image: "/images/menu/cold-appetizers/humus.jpg",
        tags: ["Vegetarian"],
        price: 8.99,
      },
      {
        id: "jajik",
        nameEn: "Jajik",
        nameTr: "Cacik",
        description:
          "Creamy yogurt blended with labneh, diced cucumber, fresh dill, and olive oil.",
        image: "/images/menu/cold-appetizers/jajik.jpg",
        tags: ["Vegetarian"],
        price: 5.99,
      },
      {
        id: "mixed-cold-appetizers",
        nameEn: "Mixed Cold Appetizers",
        nameTr: "Karışık Soğuk Meze",
        description:
          "A selection of traditional Turkish cold appetizers (humus, haydari, baba ganoush, antep ezme).",
        image: "/images/menu/mixed-cold-appetizers.jpg",
        tags: ["Vegetarian"],
        priceLabel: "Small",
        price: 14.99,
        price2Label: "Large",
        price2: 19.99,
      },
    ],
  },

  // ---------------- Sandwich & Wrap ----------------
  {
    id: "sandwich-wrap",
    title: "Sandwich & Wrap",
    subcategories: [
      {
        id: "extras",
        title: "Extras",
        items: [
          {
            id: "deluxe-add-on",
            nameEn: "Deluxe Add-On",
            description: "Add French fries to a sandwich or wrap.",
            image: "/images/menu/photo-coming-soon.svg",
            price: 2.50,
          },
        ],
      },
      // Wraps
      {
        id: "wraps",
        title: "Wraps",
        items: [
          {
            id: "adana-wrap",
            nameEn: "Adana Wrap",
            nameTr: "Adana Dürüm",
            description:
              "Spicy minced lamb grilled over charcoal, wrapped with onion, parsley, and sumac.",
            image: "/images/menu/sandwiches/adana-wrap.jpg",
            tags: ["Spicy"],
            price: 12.99,
          },
          {
            id: "falafel-wrap-4pcs",
            nameEn: "Falafel Wrap (4 pcs)",
            nameTr: "Falafel Dürüm (4 Adet)",
            description:
              "Golden, crispy falafel balls made from chickpeas, herbs, and spices, wrapped with lettuce and hummus.",
            image: "/images/menu/sandwiches/falafel-wrap.jpg",
            tags: ["Vegetarian"],
            price: 9.99,
          },
          {
            id: "tantuni-wrap",
            nameEn: "Tantuni Wrap",
            nameTr: "Tantuni Dürüm",
            description:
              "Thinly sliced sautéed veal cooked with special spices, wrapped with fresh tomatoes, onions, parsley, and red peppers. Served with lemon.",
            image: "/images/menu/sandwiches/tantuni-wrap.jpg",
            tags: ["Spicy"],
            price: 15.99,
          },
        ],
      },

      // Sandwiches
      {
        id: "sandwiches",
        title: "Sandwiches",
        items: [
          {
            id: "hamburger",
            nameEn: "Hamburger",
            description:
              "Classic beef burger patty seasoned with spices, topped with lettuce, tomato, and onion, served on a soft bun. Add Cheese: $1.00.",
            image: "/images/menu/sandwiches/hamburger.jpg",
            tags: ["Best Seller"],
            price: 8.99,
          },
          {
            id: "kokorec",
            nameEn: "Kokorec",
            description:
              "Charcoal-grilled lamb intestines finely chopped with spices, tomatoes, and peppers. Served in bread.",
            image: "/images/menu/sandwiches/kokorec.jpg",
            tags: ["New"],
            price: 19.99,
          },
        ],
      },

      // Sandwich or Wrap
      {
        id: "sandwich-or-wrap",
        title: "Sandwich or Wrap",
        items: [
          {
            id: "chicken-gyro-sandwich-wrap",
            nameEn: "Chicken Gyro Sandwich or Wrap",
            nameTr: "Tavuk Döner sandviç veya dürüm",
            description:
              "Thinly sliced, marinated chicken slow-cooked on a vertical rotisserie, served with lettuce, tomatoes, and onion. Add French fries with the Deluxe add-on.",
            image: "/images/menu/sandwiches/chicken-gyro-wrap.jpg",
            price: 10.99,
          },
          {
            id: "chicken-shish-sandwich-wrap",
            nameEn: "Chicken Shish Sandwich or Wrap",
            nameTr: "Tavuk Şiş sandviç veya dürüm",
            description:
              "Tender marinated chicken grilled over charcoal, served in fresh bread or a wrap with onions, parsley, tomato, spices, and long hot peppers.",
            image: "/images/menu/sandwiches/chicken-shish-wrap.jpg",
            price: 11.99,
          },
          {
            id: "meatball-sandwich-wrap",
            nameEn: "Meatball Sandwich or Wrap",
            nameTr: "Köfte sandviç veya dürüm",
            description:
              "Juicy beef meatballs mixed with egg, breadcrumbs, and Turkish spices, served in fresh bread or a wrap with onions, parsley, and tomato.",
            image: "/images/menu/sandwiches/meatball-sandwich.png",
            price: 10.99,
          },
          {
            id: "meat-gyro-sandwich-wrap",
            nameEn: "Meat Gyro Sandwich or Wrap",
            nameTr: "Et döner sandviç veya dürüm",
            description:
              "Thinly sliced, marinated beef slow-cooked on a vertical rotisserie, served with lettuce, tomatoes, and onion. Add French fries with the Deluxe add-on.",
            image: "/images/menu/sandwiches/meat-gyro-sandwich.jpg",
            price: 11.99,
          },
        ],
      },

      // Panini Toasts
      {
        id: "panini-toasts",
        title: "Panini Toasts",
        items: [
          {
            id: "grilled-cheese-toast",
            nameEn: "Grilled Cheese Toast",
            nameTr: "Kaşarlı Toast",
            description:
              "Grilled Turkish sandwich with melted mozzarella cheese on crispy toasted bread.",
            image: "/images/menu/sandwiches/grilled-cheese.jpg",
            tags: ["Vegetarian"],
            price: 6.99,
          },
      {
        id: "sujuk-cheese-toast",
        nameEn: "Sujuk & Cheese Toast",
        nameTr: "Kaşarlı Sucuklu",
        description:"Grilled Turkish sandwich with melted mozzarella cheese and sujuk on crispy toasted bread.",
        image: "/images/menu/sandwiches/sujuk-and-cheese.png",
        price: 8.99
      }
    ]
  }
] // ✅ close subcategories array
}, // ✅ close Sandwich & Wrap category

// ---------------- Hot Appetizers ----------------
{
  id: "hot-appetizers",
  title: "Hot Appetizers",
  items: [

      {
        id: "cheese-rolls-sigara-boregi-6",
        nameEn: "Cheese Rolls (6)",
        nameTr: "Sigara Böreği",
        description: "Crispy fried phyllo rolls filled with feta cheese and parsley.",
        image: "/images/menu/hot-appetizers/cheese-rolls.jpg",
        tags: ["Vegetarian"],
        price: 8.99,
      },
      {
        id: "falafel-4pcs",
        nameEn: "Falafel (4 pcs)",
        description:
          "Deep-fried patties made from ground chickpeas, celery, garlic, parsley, white pepper, and flour.",
        image: "/images/menu/hot-appetizers/falafel.jpg",
        tags: ["Vegetarian"],
        price: 9.99,
      },
      {
        id: "chicken-wings-deep-fried",
        nameEn: "Chicken Wings — Deep-Fried",
        description: "Crisp deep-fried wings with your choice of Hot, BBQ or Mild sauce.",
        image: "/images/menu/photo-coming-soon.svg",
        priceLabel: "10 pcs",
        price: 13.99,
        price2Label: "20 pcs",
        price2: 24.99,
      },
      {
        id: "findik-lahmacun-3pcs",
        nameEn: "Fındık Lahmacun (3 pcs)",
        description:
          "Brick oven baked thin crispy dough topped with minced beef, tomatoes, peppers, onions, and Turkish spices. Additional pieces $3 each.",
        image: "/images/menu/hot-appetizers/findik-lahmacun.jpg",
        price: 10.99,
      },
      {
        id: "french-fries",
        nameEn: "French Fries",
        description: "Golden crispy fries, lightly salted and served with ketchup or mayonnaise.",
        image: "/images/menu/hot-appetizers/french-fries.jpg",
        tags: ["Vegetarian"],
        price: 5.99,
      },
      {
        id: "pan-fried-liver",
        nameEn: "Pan-Fried Liver",
        nameTr: "Arnavut Ciğer",
        description:
          "Pan-fried cubes of liver coated in seasoned flour, served warm with sautéed onions, parsley, and red pepper flakes.",
        image: "/images/menu/hot-appetizers/pan-fried-liver.jpg",
        price: 14.99,
      },
    ],
  },

  // ---------------- Lahmacun & Pies ----------------
  {
    id: "lahmacun-pies",
    title: "Brick Oven Lahmacun & Pies",
    items: [
      {
        id: "lahmacun-3pcs",
        nameEn: "Lahmacun (3 pcs)",
        description:
          "Thin crispy dough topped with minced beef, tomatoes, peppers, onions, and Turkish spices.",
        image: "/images/menu/lahmacun-and-pides/lahmacun.jpg",
        price: 14.99,
      },
      {
        id: "cheese-pie-kasarli",
        nameEn: "Cheese Pie",
        nameTr: "Kaşarlı Pide",
        description: "Crispy dough topped with melted mozzarella cheese, baked to perfection.",
        image: "/images/menu/lahmacun-and-pides/cheese-pie.jpg",
        tags: ["Vegetarian"],
        price: 13.99,
      },
      {
        id: "cubed-meat-pie-kusbasi",
        nameEn: "Cubed Meat Pie",
        nameTr: "Kuşbasi Pide",
        description: "Crispy dough topped with tender marinated cubes of beef and mozzarella.",
        image: "/images/menu/lahmacun-and-pides/cubed-meat-pie.jpg",
        price: 17.99,
      },
      {
        id: "ground-beef-pie-kiymali",
        nameEn: "Ground Beef Pie",
        nameTr: "Kıymalı Pide",
        description:
          "Crispy dough topped with seasoned ground beef, onions, tomatoes, Turkish spices, and mozzarella.",
        image: "/images/menu/lahmacun-and-pides/ground-beef-pie.jpg",
        price: 15.99,
      },
      {
        id: "pastrami-pie-pastirmali",
        nameEn: "Pastrami Pie",
        nameTr: "Pastırmalı Pide",
        description: "Crispy dough topped with thinly sliced pastrami and melted mozzarella.",
        image: "/images/menu/lahmacun-and-pides/pastrami-pie.jpg",
        price: 18.99,
      },
      {
        id: "sujuk-pie-sucuklu",
        nameEn: "Sujuk Pie",
        nameTr: "Sucuklu Pide",
        description: "Crispy dough topped with sujuk and melted mozzarella cheese.",
        image: "/images/menu/lahmacun-and-pides/sujuk-pie.jpg",
        price: 16.99,
      },
      {
        id: "mixed-protein-pie",
        nameEn: "Mixed Protein Pie",
        nameTr: "Karışık Proteinli",
        description:
          "Crispy dough topped with ground beef, cubes of beef, pastrami, sujuk, eggs, and mozzarella.",
        image: "/images/menu/lahmacun-and-pides/mixed-protein-pie.jfif",
        price: 19.99,
      },
      {
        id: "mixed-vegetable-pie",
        nameEn: "Mixed Vegetable Pie",
        nameTr: "Karışık Sebzeli",
        description:
          "Crispy dough topped with tomatoes, mushrooms, green & red pepper, eggplant, black olive, and mozzarella.",
        image: "/images/menu/lahmacun-and-pides/mixed-vegetable-pie.webp",
        tags: ["Vegetarian"],
        price: 18.99,
      },
    ],
  },

  // ---------------- Kebabs ----------------
  {
    id: "kebabs",
    title: "Kebabs",
    items: [
      {
        id: "chicken-gyro-plate",
        nameEn: "Chicken Gyro Plate",
        nameTr: "Tavuk Döner",
        description: "Served with rice and salad, and Turkish bread.",
        image: "/images/menu/kebabs/chicken-gyro.jpg",
        price: 17.99,
      },
      {
        id: "chicken-shish-plate",
        nameEn: "Chicken Shish Plate",
        nameTr: "Tavuk Şiş",
        description:
          "Tender pieces of chicken marinated with special spices, skewered and grilled over charcoal. Served with fresh bread, onions, parsley, tomato, spices, and long hot peppers.",
        image: "/images/menu/kebabs/chicken-shish.jpg",
        price: 18.99,
      },
      {
        id: "chicken-wings-grilled",
        nameEn: "Chicken Wings — Grilled",
        description: "Seasoned chicken wings grilled until lightly charred.",
        image: "/images/menu/photo-coming-soon.svg",
        price: 19.99,
      },
      {
        id: "chicken-chops-plate",
        nameEn: "Chicken Chops",
        nameTr: "Tavuk Pirzola",
        description: "Tender chicken chops, grilled and served hot.",
        image: "/images/menu/photo-coming-soon.svg",
        price: 18.99,
      },
      {
        id: "adana-shish-plate",
        nameEn: "Adana Shish Plate",
        nameTr: "Adana Şiş",
        description:
          "Spicy minced lamb blended with herbs and grilled over charcoal. Served with fresh bread, onions, parsley, tomato, spices, and long hot peppers.",
        image: "/images/menu/kebabs/adana-shish.jpg",
        tags: ["Spicy"],
        price: 20.99,
      },
      {
        id: "grilled-meatballs-6",
        nameEn: "Grilled Meatballs (6) Plate",
        nameTr: "Izgara Köfte",
        description:
          "Juicy grilled beef meatballs with Turkish spices, served with grilled vegetables.",
        image: "/images/menu/kebabs/grilled-meatballs.jpg",
        price: 17.99,
      },
      {
        id: "meat-gyro-plate",
        nameEn: "Meat Gyro Plate",
        nameTr: "Et Döner",
        description: "Served with rice and salad, and Turkish bread.",
        image: "/images/menu/kebabs/meat-gyro.jpg",
        price: 18.99,
      },
      {
        id: "iskender-kebab",
        nameEn: "Iskender Kebab Plate",
        nameTr: "İskender Kebab",
        description:
          "Sliced gyro kebab over cubes of pita bread, long peppers, topped with tomato sauce, yogurt, and melted butter.",
        image: "/images/menu/kebabs/iskender-kebab.jpg",
        price: 19.99,
      },
      {
        id: "mixed-grill",
        nameEn: "Mixed Grill Plate",
        nameTr: "Karışık Izgara",
        description:
          "A generous platter featuring Adana Shish, Chicken Shish, Meat Gyro, Chicken Gyro, and Köfte (1 pc). Served with fresh bread, onions, parsley, and grilled vegetables.",
        image: "/images/menu/kebabs/mixed-grill.jpg",
        price: 29.99,
      },
      {
        id: "falafel-6pcs",
        nameEn: "Falafel (6 pcs) Plate",
        nameTr: "Falafel (6 Adet)",
        description:
          "Deep-fried patties made from ground chickpeas, celery, garlic, parsley, and flour.",
        image: "/images/menu/kebabs/falafel.jpg",
        tags: ["Vegetarian"],
        price: 14.99,
      },
    ],
  },

  // ---------------- Kids Menu ----------------
  {
    id: "kids-menu",
    title: "Kids Menu",
    items: [
      {
        id: "kids-chicken-tenders",
        nameEn: "Kids Chicken Tenders",
        description: "Crispy breaded chicken strips. (Served with French fries.)",
        image: "/images/menu/kids/kids-chicken-tenders.jpg",
        price: 9.99,
      },
      {
        id: "kids-hamburger",
        nameEn: "Kids Hamburger",
        description: "Juicy mini beef patty in a soft bun. (Served with French fries.)",
        image: "/images/menu/kids/kids-hamburger.jpg",
        price: 9.99,
      },
      {
        id: "kids-kofte",
        nameEn: "Kids Köfte",
        description: "Grilled Turkish meatballs in a soft bun. (Served with French fries.)",
        image: "/images/menu/kids/kids-kofte.jpg",
        price: 9.99,
      },
    ],
  },

  // ---------------- Side Orders ----------------
  {
    id: "side-orders",
    title: "Side Orders",
    items: [
      {
        id: "rice-pilav",
        nameEn: "Rice Pilav",
        price: 5.99,
        description: "Fragrant rice cooked in a rich broth with onions and spices.",
        image: "/images/menu/side-orders/rice-pilav.jpg",
      },
      {
        id: "side-salad",
        nameEn: "Side Salad",
        price: 5.99,
        description: "Nutty bulgur wheat cooked with tomatoes, peppers, and herbs.",
        image: "/images/menu/side-orders/side-salad.jpg",
      },
      {
        id: "side-french-fries",
        nameEn: "French Fries",
        price: 5.99,
        description: "Golden crispy fries, lightly salted and served with ketchup or mayonnaise.",
        image: "/images/menu/hot-appetizers/french-fries.jpg",
      },
      {
        id: "homemade-yogurt",
        nameEn: "Homemade Yogurt",
        price: 5.99,
        description: "Creamy, tangy yogurt made fresh in-house using traditional methods.",
        image: "/images/menu/side-orders/hommade-yogurt.jpg",
      },
    ],
  },

  // ---------------- Bakery ----------------
  {
    id: "bakery",
    title: "Bakery",
    items: [
      {
        id: "traditional-turkish-bread",
        nameEn: "Traditional Turkish Bread",
        price: 3.99,
        description: "Freshly baked traditional Turkish bread, perfect for any meal.",
        image: "/images/menu/bakery/traditional-turkish-bread.jpg",
      },
      {
        id: "trabzon-ekmegi",
        nameEn: "Trabzon Ekmeği",
        price: 6.99,
        description: "A rustic Turkish bread with a crisp, hearty crust and soft, dense center.",
        image: "/images/menu/bakery/trabzon-ekmegi.jpg",
      },
      { id: "simit", nameEn: "Simit", price: 2.99, description: "A traditional Turkish ring-shaped bread, crispy on the outside and soft on the inside.", image: "/images/menu/bakery/simit.jpg" },
      { id: "pogaca-plain", nameEn: "Pogaca Plain", price: 2.49, description: "Soft and fluffy Turkish breakfast rolls with a golden crust and tender crumb.", image: "/images/menu/bakery/pogaca-plain.jpg" },
      { id: "pogaca-mozz-cheese", nameEn: "Pogaca Mozzarella Cheese", price: 2.99, description: "A traditional Turkish pastry filled with mozzarella cheese, baked to perfection.", image: "/images/menu/bakery/pogaca-mozz-cheese.jpg" },
      { id: "pogaca-feta-cheese", nameEn: "Pogaca Feta Cheese", price: 2.99, description: "A traditional Turkish pastry filled with feta cheese, baked to perfection.", image: "/images/menu/bakery/pogaca-feta-cheese.jpg" },
      { id: "pogaca-potato", nameEn: "Pogaca Potato", price: 2.99, description: "A traditional Turkish pastry filled with potato, baked to perfection.", image: "/images/menu/bakery/pogaca-potato.jpg" },
      { id: "pogaca-olives", nameEn: "Pogaca Olives", price: 2.99, description: "A traditional Turkish pastry filled with olives, baked to perfection.", image: "/images/menu/bakery/pogaca-olives.jpg" },
      { id: "pogaca-dill", nameEn: "Pogaca Dill", price: 2.99, description: "A traditional Turkish pastry filled with dill, baked to perfection.", image: "/images/menu/bakery/pogaca-dill.jpg" },
      { id: "pogaca-butter", nameEn: "Pogaca Butter", price: 2.99, description: "A traditional Turkish pastry filled with butter, baked to perfection.", image: "/images/menu/bakery/pogaca-buttery.jpg" },
      { id: "borek-potato", nameEn: "Borek Potato", price: 8.99, description: "A traditional Turkish pie filled with potato, baked to perfection.", image: "/images/menu/bakery/borek-potato.jpg" },
      { id: "borek-feta-cheese", nameEn: "Borek Feta Cheese", price: 8.99, description: "A traditional Turkish pie filled with feta cheese, baked to perfection.", image: "/images/menu/bakery/borek-feta-cheese.jpg" },
      { id: "borek-ground-beef", nameEn: "Borek Ground Beef", price: 9.99, description: "A traditional Turkish pie filled with ground beef, baked to perfection.", image: "/images/menu/bakery/borek-ground-beef.jpg" },
      { id: "borek-spinach-feta", nameEn: "Borek Spinach Feta", price: 9.99, description: "A traditional Turkish pie filled with spinach and feta cheese, baked to perfection.", image: "/images/menu/bakery/borek-spinach-feta.jpg" },
    ],
  },

  // ---------------- Desserts ----------------
  {
    id: "desserts",
    title: "Desserts",
    items: [
      { id: "baklava-4pcs", nameEn: "Baklava (4 pcs)", price: 6.99, description: "Crispy, flaky layers of phyllo dough filled with ground pistachios or walnuts, baked and drizzled with sweet syrup.", image: "/images/menu/desserts/baklava-4pcs.jpg" },
      { id: "kadayif", nameEn: "Kadayif", price: 6.99, description: "Golden, crispy shredded phyllo dough filled with crushed walnuts or pistachios, soaked in light syrup for a delightful crunch.", image: "/images/menu/desserts/kadayif.jpg" },
      { id: "kazandibi", nameEn: "Kazandibi", price: 5.99, description: "A delicate milk pudding with a caramelized top, flavored with rice flour and vanilla.", image: "/images/menu/desserts/kazandibi.jpeg" },
      { id: "kunefe", nameEn: "Kunefe", price: 6.99, description: "A traditional Turkish dessert made with shredded phyllo dough, filled with melted cheese, baked to golden perfection, and soaked in sweet syrup, topped with crushed pistachios.", image: "/images/menu/desserts/kunefe.jpg" },
      { id: "magnolia", nameEn: "Magnolia", price: 5.99, description: "Creamy vanilla pudding layered with biscuits and fresh strawberries.", image: "/images/menu/desserts/magnolia.jpg" },
      { id: "revani", nameEn: "Revani", price: 5.99, description: "A moist and fluffy semolina cake soaked in light lemon-infused syrup, offering a perfect balance of sweetness and texture.", image: "/images/menu/desserts/revani.jpg" },
      { id: "saray-muhallebisi", nameEn: "Saray Muhallebisi", price: 6.99, description: "Smooth milk pudding thickened with cornstarch and flour, topped with a layer of chocolate.", image: "/images/menu/desserts/saray-muhallebisi.jpg" },
      { id: "supangle", nameEn: "Supangle", price: 6.99, description: "Rich chocolate pudding topped with cocoa and butter for a silky finish.", image: "/images/menu/desserts/supangle.jpg" },
      { id: "sutlac", nameEn: "Sutlac", price: 5.99, description: "Creamy oven-baked rice pudding made with milk, rice, sugar, and a hint of vanilla.", image: "/images/menu/desserts/sutlac.jpg" },
      { id: "trilece", nameEn: "Trilece", price: 6.99, description: "Light sponge cake soaked in a blend of three types of milk, topped with cream and fruit sauce.", image: "/images/menu/desserts/trilece.jpg" },
    ],
  },

  // ---------------- Beverages ----------------
  {
    id: "beverages",
    title: "Beverages",
    items: [
      { id: "turkish-tea", nameEn: "Turkish Tea", nameTr: "Cay", price: 1.99, description: "Traditional Turkish black tea, served hot in a tulip-shaped glass, suitable for any time of the day.", image: "/images/menu/beverages/turkish-tea.jpg" },
      { id: "filter-coffee", nameEn: "Filter Coffee", nameTr: "Filtre Kahve", price: 2.99, description: "Freshly brewed coffee prepared by slow filtration delivering a smooth and satisfying flavor with every sip.", image: "/images/menu/beverages/filter-coffee.jpg" },
      { id: "turkish-coffee", nameEn: "Turkish Coffee", nameTr: "Türk Kahvesi", price: 3.99, description: "Authentic Turkish coffee, finely ground, rich and strong in taste, prepared in a traditional cezve.", image: "/images/menu/beverages/turkish-coffee.jpg" },
      { id: "homemade-yogurt-drink", nameEn: "Homemade Yogurt Drink", nameTr: "Yayik Ayran", price: 3.99, description: "A refreshing blend of creamy yogurt, water, and a pinch of salt — a cool, traditional Turkish drink perfect with grilled dishes.", image: "/images/menu/beverages/homemade-yogurt-drink.jpg" },
      { id: "bottled-yogurt-drink", nameEn: "Bottled Yogurt Drink", nameTr: "Sise Ayran", price: 3.49, description: "Chilled, ready-to-drink Turkish yogurt beverage served in a bottle — smooth, tangy, and perfectly refreshing.", image: "/images/menu/beverages/bottled-yogurt-drink.jpg" },
      { id: "turnip-juice", nameEn: "Turnip Juice", nameTr: "Salgam Suyu", price: 2.99, description: "A bold, tangy Turkish beverage made from fermented purple carrots, turnips, and spices — traditionally enjoyed cold with kebabs.", image: "/images/menu/beverages/turnip-juice.jpg" },
      { id: "mineral-water", nameEn: "Mineral Water", nameTr: "Maden Suyu", price: 2.99, description: "Naturally carbonated and rich in minerals, this sparkling water is a refreshing way to cleanse the palate.", image: "/images/menu/beverages/mineral-water.jpg" },
      { id: "bottled-water", nameEn: "Bottled Water", nameTr: "Sise Suyu", price: 1.99, description: "Clean and crisp bottled water, served cold — a refreshing essential for any meal.", image: "/images/menu/beverages/bottled-water.jpg" },
      { id: "can-iced-tea", nameEn: "Can Iced Tea", nameTr: "Kutu Buzlu Cay", price: 2.99, description: "Refreshing iced tea served in a can — a cool, flavorful beverage perfect for any time of day.", image: "/images/menu/beverages/can-iced-tea.jpg" },
      { id: "can-soda", nameEn: "Can Soda", nameTr: "Kutu Soda", price: 2.99, description: "Chilled carbonated soft drink in a can — crisp, bubbly, and satisfying. Available in assorted flavors.", image: "/images/menu/beverages/can-soda.jpg" },
      { id: "two-liter-soda", nameEn: "2 Liter Soda", nameTr: "2 Litre Soda", price: 4.49, description: "Large bottle of carbonated soft drink perfect for sharing. Available in a variety of classic flavors.", image: "/images/menu/beverages/two-liter-soda.jpg" },
    ],
  },

  // ---------------- Empty for now ----------------
  { id: "specials", title: "Specials", items: [] },
  { id: "catering", title: "Catering", items: [] },
];

export const MENU_CATEGORIES: MenuCategory[] = ALL_MENU_CATEGORIES.filter(
  (category) => category.id !== "breakfast"
);
