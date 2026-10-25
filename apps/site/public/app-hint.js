// Loaded as a classic, synchronous script at the top of <head>, so it runs before
// anything paints. The web app at app.pinomad.si sets the `pinomad_app` cookie on
// pinomad.si for a browser that uses it (signed in or paired). The cookie carries
// no credential: a forged or stale one only sends the visitor to the app's own
// sign-in screen.
(function () {
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
