// The frame plugins render model-written HTML in (ADR-0049). The HTML may
// carry scripts, which must not run in the shell's page: they could read the
// device key. public/sandbox.html is served with its own policy (an opaque
// origin, so none of the client's storage or page; fetches blocked as best
// effort, WebRTC not), and receives the HTML by postMessage once it is ready.
import { useEffect, useRef } from "react";
import type { SandboxProps } from "@pinomad/plugin/v1/web";

const READY = "pinomad-sandbox-ready";

function Frame({ html, title }: SandboxProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    // Only this frame's first "ready" counts: after that its document is the
    // model's, and nothing it sends is acted on.
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (target == null || event.source !== target || event.data !== READY) return;
      window.removeEventListener("message", onMessage);
      // The sandboxed page has an opaque origin, so no target origin can name it.
      target.postMessage(html, "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [html]);
  return <iframe ref={frame} src="/sandbox.html" sandbox="allow-scripts" title={title} className="size-full min-h-0 flex-1 border-0" />;
}

/** Renders `html`, scripts included, isolated from the shell; a new `html` starts a new frame. */
export function Sandbox({ html, title }: SandboxProps) {
  return <Frame key={html} html={html} title={title} />;
}
