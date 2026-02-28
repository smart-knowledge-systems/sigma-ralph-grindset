import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { baseGlobalStyles, animationStyles } from "./globalStyles";

const globalStyles = baseGlobalStyles + animationStyles;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <style>{globalStyles}</style>
    <App />
  </StrictMode>,
);
