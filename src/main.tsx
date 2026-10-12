import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./index.css";

import { LanguageProvider } from "./components/Language";
import { trackCloverOrderHandoffs } from "./lib/analytics";
import { captureUtm } from "./lib/utm";

// Preserve campaign attribution when a visitor lands on /menu and later
// navigates to the VIP or catering form without query parameters.
captureUtm();
trackCloverOrderHandoffs();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LanguageProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </LanguageProvider>
  </React.StrictMode>
);
