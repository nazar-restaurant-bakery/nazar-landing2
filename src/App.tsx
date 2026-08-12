import { Routes, Route } from "react-router-dom";
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

export default function App() {
  return (
    <Routes>
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
      </Route>
    </Routes>
  );
}
