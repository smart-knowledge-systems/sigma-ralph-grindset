// Shared global CSS styles used by both main.tsx and config-main.tsx

export const baseGlobalStyles = `
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

export const animationStyles = `
  @keyframes sigmaPulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.55; }
  }
  @keyframes sigmaGlow {
    0%, 100% { box-shadow: 0 0 0 0 rgba(255, 217, 15, 0); }
    50% { box-shadow: 0 0 12px 2px rgba(255, 217, 15, 0.25); }
  }
  @keyframes sigmaSpin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  @keyframes sigmaFadeIn {
    from { opacity: 0; transform: translateY(6px); }
    to { opacity: 1; transform: translateY(0); }
  }
`;
