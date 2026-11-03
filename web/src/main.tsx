import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";
import { TooltipProvider } from "./ui/Overlays";
import { LanguageProvider } from "./i18n";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* Language provider outside: the theme and tooltips must not know about localization,
        and any component below can call useTranslation(). */}
    <LanguageProvider>
      {/* One tooltip provider per app: neighboring tooltips open
          without a repeated pause, as in native toolbars. */}
      <TooltipProvider delayDuration={450} skipDelayDuration={300}>
        <App />
      </TooltipProvider>
    </LanguageProvider>
  </StrictMode>,
);
