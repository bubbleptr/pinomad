import { Fragment } from "react";
import { localized, type Lang } from "@/lib/i18n.ts";
import { githubUrl } from "@/lib/nav.ts";
import { buttonVariants } from "@/components/ui/button.tsx";
import { blogUrl, type LandingCopy } from "./copy.tsx";
import { DurableDemo } from "./durable.tsx";
import { shot } from "./shots.ts";

// The landing page's sections. The interactive parts (the durable diagram, the
// get-started copy button) live in their own files.

export function SectionHead({ id, eyebrow, title, lead }: { id: string; eyebrow: string; title: string; lead?: string }) {
  return (
    <>
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={id}>{title}</h2>
      {lead && <p className="section-lead">{lead}</p>}
    </>
  );
}

/** A slot for a picture that isn't drawn yet: an abstract skeleton and a caption saying what goes here. */
function Placeholder({ caption, className = "shot-diagram" }: { caption: string; className?: string }) {
  return (
    <figure className={`shot ${className}`}>
      <div className="shot-skeleton" aria-hidden="true">
        <div className="sk-main">
          <span className="sk-line w55" />
          <span className="sk-line w85" />
          <span className="sk-line w70" />
        </div>
      </div>
      <figcaption className="shot-label">{caption}</figcaption>
    </figure>
  );
}

/** Stands in for an iPhone screenshot: deliberately abstract, never a fake UI. */
function PhonePlaceholder({ caption }: { caption: string }) {
  return (
    <figure className="shot shot-phone">
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
      <figcaption className="shot-label">{caption}</figcaption>
    </figure>
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
          <a className={buttonVariants()} href="#quick-start">
            {t.start}
          </a>
          <a className="text-link" href={githubUrl}>
            {t.github}
          </a>
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
      </div>
    </section>
  );
}

/** The three things PiNomad is: on your machine, durable, reachable from any screen. */
export function Core({ lang, t, durable }: { lang: Lang; t: LandingCopy["core"]; durable: LandingCopy["durable"] }) {
  return (
    <section className="section" id="how-it-works" aria-labelledby="core-title">
      <div className="wrap">
        <div className="section-head">
          <SectionHead id="core-title" eyebrow={t.eyebrow} title={t.title} />
        </div>
        <div className="bento">
          <article className="cell cell-wide" aria-labelledby="durable-title">
            <h3 id="durable-title">{durable.title}</h3>
            <p>{durable.body}</p>
            <DurableDemo t={durable} />
          </article>
          <article className="cell cell-machine">
            <h3>{t.machine.title}</h3>
            <p>{t.machine.body}</p>
            <Placeholder caption={t.machine.placeholder} />
          </article>
          <article className="cell cell-anywhere">
            <div>
              <h3>{t.anywhere.title}</h3>
              <p>{t.anywhere.body}</p>
            </div>
            <PhonePlaceholder caption={t.anywhere.placeholder} />
          </article>
        </div>
        <p className="section-link">
          <a className="text-link" href={localized(lang, "/docs/features/")}>
            {t.allFeatures}
          </a>
        </p>
      </div>
    </section>
  );
}

export function Agents({ lang, t }: { lang: Lang; t: LandingCopy["agents"] }) {
  const image = shot(lang, "subagents", 560, 1120);
  return (
    <section className="section" id="agents" aria-labelledby="agents-title">
      <div className="wrap split">
        <div className="section-head">
          <SectionHead id="agents-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
          <dl className="roles">
            {t.roles.map((role) => (
              <div key={role.name}>
                <dt>{role.name}</dt>
                <dd>{role.job}</dd>
              </div>
            ))}
          </dl>
          <p className="section-link">
            <a className="text-link" href={blogUrl} hrefLang="zh-CN">
              {t.blog}
            </a>
          </p>
        </div>
        <div className="stack">
          <figure className="shot shot-crop">
            <img
              src={image.src}
              srcSet={image.srcSet}
              sizes="(min-width: 56rem) 35rem, 100vw"
              width="1120"
              height="840"
              alt={t.shotAlt}
              loading="lazy"
              decoding="async"
            />
          </figure>
          <Placeholder caption={t.placeholder} />
        </div>
      </div>
    </section>
  );
}

export function Connection({ t }: { t: LandingCopy["connection"] }) {
  return (
    <section className="section" id="connection" aria-labelledby="connection-title">
      <div className="wrap split">
        <div className="section-head">
          <SectionHead id="connection-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
          <ul className="chips">
            {t.chips.map((chip) => (
              <li key={chip.name} className="chip">
                <strong>{chip.name}</strong>
                {chip.text}
              </li>
            ))}
          </ul>
        </div>
        <Placeholder caption={t.placeholder} />
      </div>
    </section>
  );
}

/** Planned work, kept apart from the features above and marked as not shipped. */
export function Next({ t }: { t: LandingCopy["next"] }) {
  const [lead, ...rest] = t.items;
  return (
    <section className="section" id="next" aria-labelledby="next-title">
      <div className="wrap">
        <div className="section-head">
          <SectionHead id="next-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
        </div>
        <ul className="roadmap">
          <li className="plan plan-lead">
            <div>
              <PlanText item={lead!} />
            </div>
            <Placeholder caption={t.placeholder} />
          </li>
          {rest.map((item) => (
            <li key={item.link.text} className="plan">
              <PlanText item={item} />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function PlanText({ item }: { item: LandingCopy["next"]["items"][number] }) {
  return (
    <>
      <h3>{item.title}</h3>
      <p>{item.body}</p>
      <a className="plan-link" href={item.link.href}>
        {item.link.text}
      </a>
    </>
  );
}
