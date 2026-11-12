// Browser half of the notes fixture (ADR-0049): a panel showing the shared
// board, with a button that adds a note through the host method, a card for
// the notes_add tool, and a panel running model-style HTML in the shell's
// sandbox. Plain JS, no build step; React comes from the shell.
export default function notes(pinomad) {
  const h = pinomad.React.createElement;

  function Board() {
    const board = pinomad.useState("board");
    const list = board === undefined ? [] : board.notes;
    return h(
      "div",
      { className: "flex flex-col items-start gap-2 p-3 text-sm" },
      h("p", null, `${list.length} on the board ✓`),
      h("ul", { "aria-label": "Notes" }, list.map((note, index) => h("li", { key: index }, note))),
      h("button", { type: "button", onClick: () => void pinomad.call("add", "Note from the panel") }, "Add note"),
    );
  }

  // Writes whether its script ran and what each reach out of the sandbox got.
  const PROBE = `<p id="ran">script ran</p><script>
    const out = (id, text) => { const p = document.createElement("p"); p.id = id; p.textContent = id + ": " + text; document.body.append(p); };
    const outcome = (id, run) => { try { run(); out(id, "allowed"); } catch (error) { out(id, "blocked " + error.name); } };
    document.getElementById("ran").textContent = "script ran ✓";
    outcome("indexedDB", () => indexedDB.open("pinomad"));
    outcome("localStorage", () => localStorage.length);
    outcome("top", () => top.document.title);
    fetch("/index.html").then(() => out("fetch", "allowed"), (error) => out("fetch", "blocked " + error.name));
  </script>`;

  function Artifact() {
    const [second, setSecond] = pinomad.React.useState(false);
    return h(
      "div",
      { className: "flex h-full flex-col gap-2 p-3" },
      h("button", { type: "button", onClick: () => setSecond(true) }, "Show second page"),
      h(pinomad.Sandbox, { title: "Artifact", html: second ? "<p>Second page ✓</p>" : PROBE }),
    );
  }

  pinomad.panel({ id: "board", label: "Notes", component: Board });
  pinomad.panel({ id: "artifact", label: "Artifact", component: Artifact });
  pinomad.toolCard("notes_add", ({ tool }) => h("p", null, `Note card: ${tool.args?.text ?? ""}`));
}
