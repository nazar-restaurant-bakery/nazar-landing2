// This entry never imports the public app, its analytics, or a real Supabase SDK.
import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import StaffPage from "../../src/pages/StaffPage";
import "../../src/index.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><BrowserRouter><Routes>
    <Route path="/staff/*" element={<StaffPage />} />
  </Routes></BrowserRouter></React.StrictMode>,
);
