import { type ReactNode, useState } from "react";
import { localized, type Lang } from "@/lib/i18n.ts";
import { githubUrl } from "@/lib/nav.ts";
import { blogUrl, type LandingCopy } from "./copy.tsx";
import { AgentsDiagram, ConnectionDiagram, EnvironmentsDiagram } from "./diagrams.tsx";
import { DurableDiagram } from "./durable.tsx";
import { AnywherePhone, STEPS, type Step } from "./mock/anywhere-phone.tsx";
import { HeroApp } from "./mock/hero-app.tsx";
import { ArrowIcon } from "./icons.tsx";
import { shot } from "./shots.ts";

// The landing page's sections. The larger interactive parts (the durable diagram,
// the get-started copy button, the product mocks) live in their own files.

export function SectionHead({ id, eyebrow, title, lead }: { id: string; eyebrow: string; title: ReactNode; lead?: string }) {
  return (
    <>
      <p className="eyebrow">
        {eyebrow}
      </p>
      <h2 id={id}>{title}</h2>
      {lead && <p className="section-lead">{lead}</p>}
    </>
  );
}

export function Hero({ lang, t }: { lang: Lang; t: LandingCopy["hero"] }) {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="wrap hero-inner">
        <h1 id="hero-title">{t.title}</h1>
        <p className="lead">{t.lead}</p>
        <div className="actions">
          <a className="cta" href="#quick-start">
            {t.start}
            <span className="cta-arrow">
              <ArrowIcon />
            </span>
          </a>
          <a className="text-link" href={githubUrl}>
            {t.github}
          </a>
        </div>
      </div>
      <div className="plate hero-stage">
        <HeroApp lang={lang} label={t.shotAlt} />
      </div>
      <div className="hero-meta">
        <div className="wrap">
          <dl className="specs">
            {t.specs.map((spec) => (
              <div key={spec.label}>
                <dt>{spec.label}</dt>
                <dd>{spec.value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </div>
    </section>
  );
}

/** Away from your desk: two phone screens, and the steps that switch the one in front. */
export function Anywhere({ lang, t }: { lang: Lang; t: LandingCopy["anywhere"] }) {
  const [step, setStep] = useState<Step>("start");
  return (
    <section className="section section-showcase" id="anywhere" aria-labelledby="anywhere-title">
      <div className="wrap split">
        <div className="section-head">
          <SectionHead id="anywhere-title" eyebrow={t.eyebrow} title={t.title} lead={t.lead} />
          <div className="chips">
            {STEPS.map((each, index) => (
              <button
                key={each}
                type="button"
                className="chip chip-step"
                aria-pressed={each === step}
                onClick={() => setStep(each)}
              >
                {t.steps[index]}
              </button>
            ))}
          </div>
        </div>
        <AnywherePhone lang={lang} step={step} label={t.shotAlt} />
      </div>
    </section>
  );
}

/** The small core: what is an extension, and the durable run underneath. */
export function Core({
  lang,
  t,
  extensions,
  durable,
}: {
  lang: Lang;
  t: LandingCopy["core"];
  extensions: LandingCopy["extensions"];
  durable: LandingCopy["durable"];
}) {
  return (
    <section className="section" id="how-it-works" aria-labelledby="core-title">
      <div className="wrap">
        <div className="section-head">
          <SectionHead id="core-title" eyebrow={t.eyebrow} title={t.title} />
        </div>
        <div className="bento">
          <article className="cell" aria-labelledby="extensions-title">
            <h3 id="extensions-title">{extensions.title}</h3>
            <p>{extensions.body}</p>
          </article>
          <article className="cell cell-wide" aria-labelledby="durable-title">
            <h3 id="durable-title">{durable.title}</h3>
            <p>{durable.body}</p>
            <DurableDiagram t={durable} />
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
          <div className="plate plate-shot">
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
          </div>
          <AgentsDiagram t={t.diagram} roles={t.roles.map((role) => role.name)} />
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
          <p className="section-link">
            <a className="text-link" href={t.more.href}>
              {t.more.text}
            </a>
          </p>
        </div>
        <ConnectionDiagram t={t.diagram} />
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
            <EnvironmentsDiagram t={t.diagram} />
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
