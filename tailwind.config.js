/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#1E7A3A",      // bg-brand / text-brand — ana marka yeşili (Clover butonuyla aynı)
          dark: "#155C2C",         // hover:bg-brand-dark — koyu yeşil (hover)
          primary: "#1E7A3A",      // bg-brand-primary — NavBar logo kutusu / aktif vurgu
          primaryHover: "#155C2C", // hover:bg-brand-primaryHover
          primarySoft: "#E7F3EC",  // aktif nav linki açık yeşil zemin
          border: "#D8E6DC",       // border-brand-border — yumuşak yeşilimsi kenarlık
          bg: "#F3F8F4",           // bg-brand-bg — çok açık yeşil zemin
          ink: "#14311F",          // text-brand-ink — koyu yeşil metin (başlık/nav)
        },
      },
    },
  },
  plugins: [],
};
