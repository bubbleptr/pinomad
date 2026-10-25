import { createRootRoute, HeadContent, Outlet, Scripts, useLocation } from "@tanstack/react-router";
import { htmlLang, langOf } from "@/lib/i18n.ts";
import favicon from "../../../web/public/favicon.svg?url";
import touchIcon from "../../../web/public/apple-touch-icon.png?url";

export const Route = createRootRoute({
  head: () => ({
    meta: [{ charSet: "utf-8" }, { name: "viewport", content: "width=device-width, initial-scale=1" }],
    links: [
      { rel: "icon", type: "image/svg+xml", href: favicon },
      { rel: "apple-touch-icon", href: touchIcon },
    ],
    // Classic and synchronous on purpose: it marks a returning web-app user and
    // may redirect the home page before anything paints (public/app-hint.js).
    scripts: [{ src: "/app-hint.js" }],
  }),
  component: RootDocument,
});

function RootDocument() {
  const lang = langOf(useLocation({ select: (l) => l.pathname }));
  return (
    // app-hint.js and the docs theme both set attributes on <html> before hydration.
    <html lang={htmlLang[lang]} suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body>
        <Outlet />
        <Scripts />
      </body>
    </html>
  );
}
