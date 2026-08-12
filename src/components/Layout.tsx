import { Outlet } from "react-router-dom";
import NavBar from "./NavBar";
import Footer from "./Footer";
import GlobalOrderButtons, { GlobalOrderStickyBar } from "./GlobalOrderButtons";

export default function Layout() {
  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 flex flex-col">
      <NavBar />

      {/* TOP buttons on all pages */}
<div className="mx-auto w-full max-w-6xl px-4 pt-6">
  <GlobalOrderButtons />

  {/* Global note under the Clover button */}
  <div className="mx-auto mt-3 max-w-4xl text-center text-xs sm:text-sm font-bold text-zinc-600">

    <p>Browse here, then order online — pickup or delivery, straight from us.</p>
    <p className="mt-1">
      Our prices shown. Marketplace prices and fees may vary.
    </p>
  </div>
</div>


      <main className="w-full flex-1 pb-24">
        <Outlet />
      </main>

<Footer />

{/* spacer so footer/content isn't hidden behind fixed bottom bar */}
<div className="h-24" aria-hidden="true" />

{/* BOTTOM sticky buttons on all pages */}
<GlobalOrderStickyBar />

    </div>
  );
}
