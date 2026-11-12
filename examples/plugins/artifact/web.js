// Browser half of the artifact example: a card for each artifact_write call
// and a side panel that shows the page in the shell's sandbox. Plain ES module,
// no build step: React comes from the shell, so elements are made with
// createElement instead of JSX.

/** @param {import("@pinomad/plugin/v1/web").WebApi} pinomad */
export default function artifact(pinomad) {
  const h = pinomad.React.createElement;
  // Inline styles: the shell's stylesheet only has the classes the shell itself uses.
  const note = { margin: 0, padding: "8px 12px", fontSize: 13, opacity: 0.7 };
  const button = { padding: "2px 10px", border: "1px solid currentColor", borderRadius: 6, cursor: "pointer" };

  function Panel() {
    const current = pinomad.useState("current");
    const revision = current === undefined ? 0 : current.revision;
    // `undefined` args skip the call; the revision in the deps fetches each new page.
    const page = pinomad.useCall("read", revision > 0 ? null : undefined, [revision]);
    if (revision === 0) return h("p", { style: note }, "No artifact yet. Ask the agent to make a page.");
    if (page === undefined) return h("p", { style: note }, "Loading…");
    return h("div", { style: { display: "flex", height: "100%" } }, h(pinomad.Sandbox, { title: page.title, html: page.html }));
  }

  function Card({ tool }) {
    // The args hold the whole document; show only its title. They are undefined while streaming.
    const title = tool.args?.title ?? "Untitled page";
    return h(
      "div",
      { style: { display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", fontSize: 13 } },
      h("span", { style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" } }, title),
      h("button", { type: "button", style: button, onClick: () => pinomad.openPanel("page") }, "Open"),
    );
  }

  pinomad.panel({ id: "page", label: "Artifact", component: Panel });
  pinomad.toolCard("artifact_write", Card);
}
