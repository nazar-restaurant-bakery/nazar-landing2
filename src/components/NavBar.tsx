import { NavLink } from "react-router-dom";

const linkBase =
  "relative text-sm font-semibold px-3 py-2 rounded-lg transition-colors duration-200 text-brand-ink hover:bg-zinc-100";

function linkClass(isActive: boolean) {
  return [
    linkBase,
    isActive
      ? "bg-brand-primarySoft border border-brand-border shadow-sm ring-1 ring-brand-border/30 " +
        "after:content-[''] after:absolute after:left-3 after:right-3 after:-bottom-1 " +
        "after:h-[3px] after:rounded-full after:bg-brand-primary"
      : ""
  ].join(" ");
}

export default function NavBar() {
  return (
    <header
  dir="ltr"
  className="sticky top-0 z-50 border-b border-zinc-200 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/70"

>
    <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <NavLink to="/" className="flex items-center gap-3">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-brand-primary text-white font-bold shadow-sm hover:bg-brand-primaryHover transition-colors">
            N
          </div>

          <div className="leading-tight">
            <div className="text-lg sm:text-xl font-bold text-brand-ink">
              Nazar
            </div>
            <div className="text-base sm:text-lg text-zinc-600">
              Restaurant &amp; Bakery
            </div>
          </div>
        </NavLink>
<div className="flex items-center gap-3">
  <nav className="flex flex-wrap items-center gap-1">
<NavLink to="/" className={({ isActive }) => linkClass(isActive)}>
  Home
</NavLink>
<NavLink to="/menu" className={({ isActive }) => linkClass(isActive)}>
  Menu
</NavLink>
<NavLink to="/specials" className={({ isActive }) => linkClass(isActive)}>
  Specials
</NavLink>
<NavLink to="/catering" className={({ isActive }) => linkClass(isActive)}>
  Catering
</NavLink>
<NavLink to="/gallery" className={({ isActive }) => linkClass(isActive)}>
  Gallery
</NavLink>
<NavLink to="/reviews" className={({ isActive }) => linkClass(isActive)}>
  Reviews
</NavLink>
<NavLink to="/about" className={({ isActive }) => linkClass(isActive)}>
  About
</NavLink>
<NavLink to="/contact" className={({ isActive }) => linkClass(isActive)}>
  Contact
</NavLink>
<NavLink
  to="/vip"
  className="rounded-full bg-[#1E7A3A] px-3 py-2 text-sm font-extrabold text-white shadow-sm hover:opacity-95"
>
  VIP Club
</NavLink>
  </nav>


</div>
      </div>
    </header>
  );
}