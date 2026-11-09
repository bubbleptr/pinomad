import { useEffect, useState } from "react";
import type { Lang } from "@/lib/i18n.ts";
import { shot } from "../shots.ts";

// "Away from your desk": the iPhone app in a plain device frame, at the step the
// section's buttons pick. The screenshots are one real run on a scripted host
// (docs/website.md says how to retake them). Answer opens on the push banner over
// the conversation list, then moves into the conversation with the agent's question.

export const STEPS = ["start", "ask", "review"] as const;
export type Step = (typeof STEPS)[number];

type Screen = "start" | "banner" | "ask" | "review";

const SCREENS: Screen[] = ["start", "banner", "ask", "review"];

/** How long the banner shows before the conversation opens. */
const BANNER_MS = 1800;

export function AnywherePhone({ lang, step, label }: { lang: Lang; step: Step; label: string }) {
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    setOpened(false);
    if (step !== "ask") return;
    const timer = setTimeout(() => setOpened(true), BANNER_MS);
    return () => clearTimeout(timer);
  }, [step]);
  const shown: Screen = step === "ask" && !opened ? "banner" : step;

  return (
    <figure className="phone">
      <div className="phone-body">
        <span className="phone-btn btn-action" />
        <span className="phone-btn btn-volume-up" />
        <span className="phone-btn btn-volume-down" />
        <span className="phone-btn btn-side" />
        <span className="phone-btn btn-camera" />
        <div className="phone-screen">
          {SCREENS.map((screen) => {
            const image = shot(lang, `anywhere-${screen}`, 320, 640);
            const visible = screen === shown;
            return (
              <img
                key={screen}
                src={image.src}
                srcSet={image.srcSet}
                sizes="(min-width: 56rem) 18rem, 16rem"
                width="1206"
                height="2622"
                alt={visible ? label : ""}
                aria-hidden={!visible || undefined}
                data-shown={visible || undefined}
                loading="lazy"
                decoding="async"
              />
            );
          })}
          <span className="phone-island" />
        </div>
      </div>
    </figure>
  );
}
