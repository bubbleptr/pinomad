// Browser half of the notes fixture (ADR-0049): a panel showing the shared
// board, with a button that adds a note through the host method, and a card
// for the notes_add tool. Plain JS, no build step; React comes from the shell.
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

  pinomad.panel({ id: "board", label: "Notes", component: Board });
  pinomad.toolCard("notes_add", ({ tool }) => h("p", null, `Note card: ${tool.args?.text ?? ""}`));
}
