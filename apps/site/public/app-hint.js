// Loaded as a classic, synchronous script at the top of <head>, so it runs before
// anything paints. The web app at app.pinomad.si sets the `pinomad_app` cookie on
// pinomad.si for a browser that uses it (signed in or paired). The cookie carries
// no credential: a forged or stale one only sends the visitor to the app's own
// sign-in screen.
(function () {
  // The home page's entrance plays once per tab: landing.tsx records that it has
  // played, and a later load in the same session is marked here so page.css skips
  // it. Storage can throw (private mode, blocked site data); it then just plays.
  try {
    if (sessionStorage.getItem("pinomad_intro")) document.documentElement.setAttribute("data-intro-seen", "");
  } catch (e) {}
  if (!/(?:^|;\s*)pinomad_app=1(?:;|$)/.test(document.cookie)) return;
  document.documentElement.setAttribute("data-app-user", "");
  // Only the home pages forward to the app; docs and blog just relabel the
  // "Sign in" link. `?home` keeps someone on the home page (the app links here
  // with it).
  var path = location.pathname;
  var home = path === "/" || path === "/zh/";
  if (home && !/(?:^|[?&])home(?:[=&]|$)/.test(location.search.slice(1))) {
    location.replace("https://app.pinomad.si/");
  }
})();
