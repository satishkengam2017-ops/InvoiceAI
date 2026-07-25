// @ts-nocheck
import { ScrollViewStyleReset } from "expo-router/html";
import type { PropsWithChildren } from "react";

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="en" style={{ height: "100%" }}>
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no"
        />
        {/*
          Disable body scrolling on web to make ScrollView components work correctly.
          If you want to enable scrolling, remove `ScrollViewStyleReset` and
          set `overflow: auto` on the body style below.
        */}
        <ScrollViewStyleReset />
        <style
          dangerouslySetInnerHTML={{
            __html: `
              /* Desktop: the app floats as a centered window over a soft page
                 background. React Native Web mounts into body > div:first-child
                 (and portals modals into sibling divs), so both get the same
                 window geometry — modal sheets then clip to the app window like
                 native desktop dialogs. */
              body {
                background: #f5f5f3;
              }
              /* Scoped to #root (the RNW mount) and #clerk-components
                 (Clerk's modal portal, only once it actually holds a modal)
                 rather than a blanket "body > div" — any OTHER sibling div
                 a browser extension injects (password managers, ad
                 blockers, etc. routinely add one) would otherwise also get
                 this full opaque window treatment and, being later in DOM
                 order, paint over the real app content. #clerk-components
                 stays childless until a modal opens, so :not(:empty) keeps
                 it inert until then. */
              body > div#root,
              body > div#clerk-components:not(:empty) {
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
                body > div#root,
                body > div#clerk-components:not(:empty) {
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
              ::-webkit-scrollbar-thumb {
                background: #d6d6d2;
                border-radius: 4px;
              }
              ::-webkit-scrollbar-thumb:hover { background: #c2c2be; }

              html {
                -webkit-font-smoothing: antialiased;
                -moz-osx-font-smoothing: grayscale;
              }

              [role="tablist"] [role="tab"] * { overflow: visible !important; }
              [role="heading"], [role="heading"] * { overflow: visible !important; }
            `,
          }}
        />
      </head>
      <body
        style={{
          margin: 0,
          height: "100%",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
        }}
      >
        {children}
      </body>
    </html>
  );
}
