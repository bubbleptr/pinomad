import { Fragment } from "react";
import type { Lang } from "@/lib/i18n.ts";
import { githubUrl } from "@/lib/nav.ts";
import type { LandingCopy } from "./copy.tsx";
import { StarIcon } from "./icons.tsx";
import { shot } from "./shots.ts";

// The landing page's static sections. The interactive ones (the durable
// diagram, the quick start's copy button) live in their own files.

function SectionHead({ id, eyebrow, title, lead }: { id: string; eyebrow: string; title: string; lead?: string }) {
  return (
    <>
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={id}>{title}</h2>
      {lead && <p className="section-lead">{lead}</p>}
    </>
  );
}

export function Hero({ lang, t }: { lang: Lang; t: LandingCopy["hero"] }) {
  const image = shot(lang, "hero", 1200, 2400);
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="wrap">
        <h1 id="hero-title">{t.title}</h1>
        <p className="lead">{t.lead}</p>
        <div className="actions">
          <a className="button" href="#quick-start">
            {t.start}
          </a>
          <a className="text-link" href={githubUrl}>
            {t.github}
          </a>
        </div>
        <div className="models">
          <span className="models-label">{t.modelsLabel}</span>
          <ul>
            {/* The names are inline and unbreakable; the space after each is where the line wraps. */}
            {t.models.map((model) => (
              <Fragment key={model}>
                <li>{model}</li>{" "}
              </Fragment>
            ))}
            <li className="models-more">{t.modelsMore}</li>
          </ul>
        </div>
        <figure className="shot shot-window hero-shot">
          <img
            src={image.src}
            srcSet={image.srcSet}
            sizes="(min-width: 72rem) 68rem, 100vw"
            width="2400"
            height="1500"
            alt={t.shotAlt}
            fetchPriority="high"
          />
        </figure>
      </div>
    </section>
  );
}

export function Anywhere({ t }: { t: LandingCopy["anywhere"] }) {
  return (
    <section className="section" id="anywhere" aria-labelledby="anywhere-title">
      <div className="wrap split split-phone">
        <div className="section-head">
          <SectionHead id="anywhere-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
          <ul className="chips">
            {t.chips.map((chip) => (
              <li key={chip.name} className="chip">
                <strong>{chip.name}</strong>
                {chip.text}
              </li>
            ))}
          </ul>
        </div>
        <figure className="shot shot-phone">
          {/* Placeholder for an iPhone screenshot: deliberately abstract, never a fake UI. */}
          <div className="shot-skeleton sk-phone" aria-hidden="true">
            <span className="sk-line w55" />
            <div className="sk-main">
              <span className="sk-line w85" />
              <span className="sk-line w70" />
              <span className="sk-line w85" />
              <span className="sk-gap" />
              <span className="sk-line w55" />
              <span className="sk-line w70" />
            </div>
          </div>
          <figcaption className="shot-label">{t.caption}</figcaption>
        </figure>
      </div>
    </section>
  );
}

export function Features({ lang, t }: { lang: Lang; t: LandingCopy["features"] }) {
  return (
    <section className="section" id="features" aria-labelledby="features-title">
      <div className="wrap">
        <div className="section-head">
          <SectionHead id="features-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
        </div>
        <div className="feature-rows">
          {t.rows.map((row) => {
            const image = shot(lang, row.shot, 560, 1120);
            return (
              <div key={row.shot} className="feature-row split">
                <div>
                  <h3>{row.title}</h3>
                  <p>{row.body}</p>
                </div>
                <figure className="shot shot-crop">
                  <img
                    src={image.src}
                    srcSet={image.srcSet}
                    sizes="(min-width: 56rem) 35rem, 100vw"
                    width="1120"
                    height="840"
                    alt={row.alt}
                    loading="lazy"
                    decoding="async"
                  />
                </figure>
              </div>
            );
          })}
        </div>

        <div className="more">
          <h3>{t.moreTitle}</h3>
          <dl className="more-list">
            {t.more.map((item) => (
              <div key={item.term}>
                <dt>{item.term}</dt>
                <dd>{item.body}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

export function Clients({ t }: { t: LandingCopy["clients"] }) {
  return (
    <section className="section" id="clients" aria-labelledby="clients-title">
      <div className="wrap">
        <div className="section-head">
          <SectionHead id="clients-title" eyebrow={t.eyebrow} title={t.title} />
        </div>
        <ul className="clients">
          {t.items.map((item) => (
            <li key={item.name} className="client">
              <h3>{item.name}</h3>
              <p>{item.body}</p>
              {item.tag && <span className="tag">{item.tag}</span>}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

export function Closing({ t }: { t: LandingCopy["closing"] }) {
  return (
    <section className="closing" aria-labelledby="closing-title">
      <div className="wrap">
        <h2 id="closing-title">{t.title}</h2>
        <p className="lead">{t.lead}</p>
        <div className="actions">
          <a className="button" href="#quick-start">
            {t.start}
          </a>
          <a className="button button-quiet" href={githubUrl}>
            <StarIcon />
            {t.star}
          </a>
        </div>
        <p className="star-note">{t.starNote}</p>
      </div>
    </section>
  );
}
