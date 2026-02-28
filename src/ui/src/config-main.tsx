import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ConfigApp from "./ConfigApp";
import { baseGlobalStyles } from "./globalStyles";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <style>{baseGlobalStyles}</style>
    <ConfigApp />
  </StrictMode>,
);
