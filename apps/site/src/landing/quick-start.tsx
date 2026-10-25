import { useEffect, useRef, useState } from "react";
import type { LandingCopy } from "./copy.tsx";

export function QuickStart({ t }: { t: LandingCopy["quickStart"] }) {
  return (
    <section className="section" id="quick-start" aria-labelledby="quick-start-title">
      <div className="wrap split">
        <div className="section-head">
          <p className="eyebrow">{t.eyebrow}</p>
          <h2 id="quick-start-title">{t.title}</h2>
          <p className="section-lead">{t.lead}</p>
          {t.notes.map((note, i) => (
            <p key={i} className="note">
              {note}
            </p>
          ))}
        </div>
        <div className="code-card">
          <div className="code-card-header">
            <span>{t.terminal}</span>
            <CopyButton text={"npm i -g pinomad\npinomad host\npinomad link"} t={t} />
          </div>
          {/* Each run of plain text stays one text node: splitting it shifts the glyphs. */}
          <pre>
            <code>
              {"npm i -g pinomad\npinomad host   "}
              <span className="comment">{t.hostComment}</span>
              {"\npinomad link   "}
              <span className="comment">{t.linkComment}</span>
            </code>
          </pre>
        </div>
      </div>
    </section>
  );
}

/** Ships hidden: without JS or the async clipboard API the block is still plain selectable text. */
function CopyButton({ text, t }: { text: string; t: LandingCopy["quickStart"] }) {
  const [ready, setReady] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    setReady(Boolean(navigator.clipboard));
    return () => clearTimeout(timer.current);
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setResult(t.copied);
    } catch {
      setResult(t.copyFailed);
    }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setResult(null), 2000);
  }

  return (
    <>
      <button className="copy-button" type="button" hidden={!ready} onClick={copy}>
        {result ?? t.copy}
      </button>
      <span className="visually-hidden" role="status">
        {result}
      </span>
    </>
  );
}
