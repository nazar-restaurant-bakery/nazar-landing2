import { Routes, Route } from "react-router-dom";
import { lazy, Suspense } from "react";
import Layout from "./components/Layout";

import HomePage from "./pages/HomePage";
import MenuPage from "./pages/MenuPage";
import GalleryPage from "./pages/GalleryPage";
import ReviewsPage from "./pages/ReviewsPage";
import AboutPage from "./pages/AboutPage";
import ContactPage from "./pages/ContactPage";
import VipPage from "./pages/VipPage";
import SpecialsPage from "./pages/SpecialsPage";
import CateringPage from "./pages/CateringPage";
import PrivacyPage from "./pages/PrivacyPage";
import CrmPreviewPage from "./pages/CrmPreviewPage";
import { staffCopy } from "./lib/staffCopy";

const StaffPage = lazy(() => import("./pages/StaffPage"));

export default function App() {
  return (
    <Routes>
      <Route path="/staff/*" element={<Suspense fallback={<div role="status" className="p-6">{staffCopy.loading}</div>}><StaffPage /></Suspense>} />
      {import.meta.env.DEV && <Route path="/staff-preview" element={<CrmPreviewPage />} />}
      <Route element={<Layout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/menu" element={<MenuPage />} />
        <Route path="/specials" element={<SpecialsPage />} />
        <Route path="/catering" element={<CateringPage />} />
        <Route path="/gallery" element={<GalleryPage />} />
        <Route path="/reviews" element={<ReviewsPage />} />
        <Route path="/about" element={<AboutPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/vip" element={<VipPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
      </Route>
    </Routes>
  );
}
