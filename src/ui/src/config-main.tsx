import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import ConfigApp from "./ConfigApp";

const globalStyles = `
  *, *::before, *::after { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 0;
    background: #FFF8E7;
    font-family: 'Nunito', -apple-system, sans-serif;
    color: #3D3D3D;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  #root {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #D4C9A8; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #B8A882; }
`;

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <style>{globalStyles}</style>
    <ConfigApp />
  </StrictMode>,
);
