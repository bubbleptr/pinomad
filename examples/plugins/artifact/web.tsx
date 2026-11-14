// Browser half of the artifact example: a card for each artifact_write call
// and a side panel that shows the page in the shell's sandbox. The host builds
// it; JSX renders with the shell's React, and hooks come from `pinomad`.
import type { PluginToolCall, WebApi } from "@pinomad/plugin/v1/web";

// Inline styles: the shell's stylesheet only has the classes the shell itself uses.
const note = { margin: 0, padding: "8px 12px", fontSize: 13, opacity: 0.7 };
const button = { padding: "2px 10px", border: "1px solid currentColor", borderRadius: 6, cursor: "pointer" };

export default function artifact(pinomad: WebApi): void {
  function Panel() {
    const current = pinomad.useState<{ title: string; revision: number }>("current");
    const revision = current === undefined ? 0 : current.revision;
    // `undefined` args skip the call; the revision in the deps fetches each new page.
    const page = pinomad.useCall<{ title: string; html: string }>("read", revision > 0 ? null : undefined, [revision]);
    if (revision === 0) return <p style={note}>No artifact yet. Ask the agent to make a page.</p>;
    if (page === undefined) return <p style={note}>Loading…</p>;
    return (
      <div style={{ display: "flex", height: "100%" }}>
        <pinomad.Sandbox title={page.title} html={page.html} />
      </div>
    );
  }

  function Card({ tool }: { tool: PluginToolCall }) {
    // The args hold the whole document; show only its title. They are undefined while streaming.
    const args = tool.args as { title?: string } | undefined;
    const title = args?.title ?? "Untitled page";
    return (
      <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", fontSize: 13 }}>
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{title}</span>
        <button type="button" style={button} onClick={() => pinomad.openPanel("page")}>
          Open
        </button>
      </div>
    );
  }

  pinomad.panel({ id: "page", label: "Artifact", component: Panel });
  pinomad.toolCard("artifact_write", Card);
}
