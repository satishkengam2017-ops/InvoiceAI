// Web-only "desktop app window" shell. Injected at runtime because the app
// uses web.output "single", where app/+html.tsx is not applied in dev.
// React Native Web mounts into body > div:first-child and portals modals into
// sibling divs, so both get the window geometry — modal sheets then clip to
// the app window like native desktop dialogs.
import { Platform } from "react-native";

const CSS = `
  body {
    background: #f5f5f3;
  }
  body > div {
    position: fixed !important;
    top: 28px !important;
    bottom: 28px !important;
    left: 50% !important;
    right: auto !important;
    height: auto !important;
    transform: translateX(-50%);
    width: min(920px, calc(100vw - 64px));
    border-radius: 16px;
    overflow: hidden;
    background: #ffffff;
    box-shadow:
      0 0 0 1px rgba(17, 17, 16, 0.05),
      0 2px 6px rgba(17, 17, 16, 0.04),
      0 24px 48px -12px rgba(17, 17, 16, 0.12);
  }

  /* Smaller screens: full-bleed app, no window chrome. */
  @media (max-width: 1023px) {
    body > div {
      top: 0 !important;
      bottom: 0 !important;
      left: 0 !important;
      right: 0 !important;
      transform: none;
      width: 100vw;
      border-radius: 0;
      box-shadow: none;
    }
  }

  /* Quiet, desktop-app scrollbars. */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #d6d6d2; border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: #c2c2be; }

  html {
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
`;

export function injectWebShell(): void {
  if (Platform.OS !== "web" || typeof document === "undefined") return;
  if (document.getElementById("app-window-shell")) return;
  const style = document.createElement("style");
  style.id = "app-window-shell";
  style.textContent = CSS;
  document.head.appendChild(style);
}
