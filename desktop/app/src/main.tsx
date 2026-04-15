import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource/manrope/600.css";
import "@fontsource/manrope/700.css";
import "@fontsource/manrope/800.css";
import "@fontsource/playfair-display/400.css";

import "./index.css";
import "./i18n";
import App from "./App.tsx";

document.addEventListener("contextmenu", (e) => {
  if (!(e.target instanceof HTMLElement) || !e.target.closest("[data-context-menu]")) {
    e.preventDefault();
  }
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
