import { useEffect, useRef, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { formatDate, localized, type Lang } from "@/lib/i18n.ts";
import { githubUrl } from "@/lib/nav.ts";
import type { LandingCopy } from "./copy.tsx";
import { StarIcon } from "./icons.tsx";

const INSTALL = "curl -fsSL https://pinomad.si/install.sh | sh";
// The full path: a new Mac doesn't have ~/.local/bin on PATH yet.
const UP = "~/.local/bin/pinomad up";

/** The newest changelog entry, read from the changelog when the page is prerendered. */
export type LatestRelease = { version: string; date: string };

export function GetStarted({ t }: { t: LandingCopy["start"] }) {
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
          <p className="section-link">
            <a className="text-link" href={t.more.href}>
              {t.more.text}
            </a>
          </p>
        </div>
        <div className="code-card">
          <div className="code-card-header">
            <span>{t.terminal}</span>
            <CopyButton text={`${INSTALL}\n${UP}`} t={t} />
          </div>
          {/* Each run of plain text stays one text node: splitting it shifts the glyphs. */}
          <pre>
            <code>
              {`${INSTALL}\n${UP}   `}
              <span className="comment">{t.upComment}</span>
            </code>
          </pre>
        </div>
      </div>
      <div className="wrap">
        <h3 className="clients-title">{t.clientsTitle}</h3>
        <ul className="clients">
          {t.clients.map((client) => (
            <li key={client.name} className="client">
              <h4>{client.name}</h4>
              <p>{client.body}</p>
              {client.tag && <span className="tag">{client.tag}</span>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** The page's sign-off after the roadmap: the latest release and the GitHub star. */
export function Closing({ lang, t, latest }: { lang: Lang; t: LandingCopy["start"]; latest?: LatestRelease }) {
  return (
    <div className="wrap">
      <div className="start-end">
        {latest && (
          <p className="latest">
            {t.latest(latest.version, formatDate(lang, latest.date))}
            {" · "}
            <a href={localized(lang, "/changelog/")}>{t.changelog}</a>
          </p>
        )}
        <a className={buttonVariants({ variant: "quiet" })} href={githubUrl}>
          <StarIcon />
          {t.star}
        </a>
        <p className="star-note">{t.starNote}</p>
      </div>
    </div>
  );
}

/** Ships hidden: without JS or the async clipboard API the block is still plain selectable text. */
function CopyButton({ text, t }: { text: string; t: LandingCopy["start"] }) {
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
      <Button variant="outline" size="xs" hidden={!ready} onClick={copy}>
        {result ?? t.copy}
      </Button>
      <span className="visually-hidden" role="status">
        {result}
      </span>
    </>
  );
}
