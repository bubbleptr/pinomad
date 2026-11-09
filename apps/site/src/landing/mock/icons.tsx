import type { ReactNode } from "react";
import claude from "./logos/claude-color.svg?raw";
import deepseek from "./logos/deepseek-color.svg?raw";
import openai from "./logos/openai.svg?raw";
import qwen from "./logos/qwen-color.svg?raw";
import type { Model } from "./runs.ts";

// The clients' icons, drawn inline: Lucide outlines (docs/licenses/lucide.md), the
// Hugeicons New chat and panel glyphs from apps/web/src/shared/ui/animated-icons.tsx
// (docs/licenses/animated-icons.md), and the LobeHub model marks the web client uses
// (docs/licenses/lobehub-icons.md). The iPhone app's glyphs are Lucide too, at the
// version apps/ios/scripts/lucide-icons.sh pins.

function Line({ children }: { children: ReactNode }) {
  return (
    <svg className="mock-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

const panel = (
  <>
    <path d="M13 3H11C7.22876 3 5.34315 3 4.17157 4.17157C3 5.34315 3 7.22876 3 11V13C3 16.7712 3 18.6569 4.17157 19.8284C5.34315 21 7.22876 21 11 21H13C16.7712 21 18.6569 21 19.8284 19.8284C21 18.6569 21 16.7712 21 13V11C21 7.22876 21 5.34315 19.8284 4.17157C18.6569 3 16.7712 3 13 3Z" />
    <path d="M9 3V21" />
  </>
);

export const icons = {
  panelLeft: <Line>{panel}</Line>,
  panelRight: (
    <Line>
      <g transform="translate(24 0) scale(-1 1)">{panel}</g>
    </Line>
  ),
  tasks: (
    <Line>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </Line>
  ),
  newChat: (
    <Line>
      <path d="M12.5 3.00372C11.6049 2.99039 10.7047 3.01289 9.8294 3.07107C5.64639 3.34913 2.31441 6.72838 2.04024 10.9707C1.98659 11.8009 1.98659 12.6607 2.04024 13.4909C2.1401 15.036 2.82343 16.4666 3.62791 17.6746C4.09501 18.5203 3.78674 19.5758 3.30021 20.4978C2.94941 21.1626 2.77401 21.495 2.91484 21.7351C3.05568 21.9752 3.37026 21.9829 3.99943 21.9982C5.24367 22.0285 6.08268 21.6757 6.74868 21.1846C7.1264 20.9061 7.31527 20.7668 7.44544 20.7508C7.5756 20.7348 7.83177 20.8403 8.34401 21.0513C8.8044 21.2409 9.33896 21.3579 9.8294 21.3905C11.2536 21.4852 12.7435 21.4854 14.1706 21.3905C18.3536 21.1125 21.6856 17.7332 21.9598 13.4909C22.0021 12.836 22.011 12.1627 21.9866 11.5" />
      <path d="M8.5 15H15.5M8.5 10H12M15 5.5H22M18.5 2L18.5 9" />
    </Line>
  ),
  folder: (
    <Line>
      <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
    </Line>
  ),
  chevronUp: (
    <Line>
      <path d="m18 15-6-6-6 6" />
    </Line>
  ),
  chevronDown: (
    <Line>
      <path d="m6 9 6 6 6-6" />
    </Line>
  ),
  chevronRight: (
    <Line>
      <path d="m9 18 6-6-6-6" />
    </Line>
  ),
  monitor: (
    <Line>
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <path d="M8 21h8M12 17v4" />
    </Line>
  ),
  settings: (
    <Line>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </Line>
  ),
  plus: (
    <Line>
      <path d="M5 12h14M12 5v14" />
    </Line>
  ),
  stop: (
    <Line>
      <rect width="12" height="12" x="6" y="6" rx="1.5" />
    </Line>
  ),
  send: (
    <Line>
      <path d="m5 12 7-7 7 7M12 19V5" />
    </Line>
  ),
  lock: (
    <Line>
      <rect width="16" height="10" x="4" y="11" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </Line>
  ),
};

/** The iPhone app's glyphs (apps/ios/scripts/lucide-icons.txt). */
export const iosIcons = {
  chevronLeft: (
    <Line>
      <path d="m15 18-6-6 6-6" />
    </Line>
  ),
  chevronRight: icons.chevronRight,
  chevronDown: icons.chevronDown,
  userRound: (
    <Line>
      <circle cx="12" cy="8" r="5" />
      <path d="M20 21a8 8 0 0 0-16 0" />
    </Line>
  ),
  settings: icons.settings,
  inbox: (
    <Line>
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
    </Line>
  ),
  bellCheck: (
    <Line>
      <path d="M10.268 21a2 2 0 0 0 3.464 0" />
      <path d="m15 8 2 2 4-4" />
      <path d="M16.8607 4.4824A6 6 0 0 0 6 8C6 12.499 4.589 13.956 3.262 15.326" />
      <path d="M3.262 15.326A1 1 0 0 0 4 17H20A1 1 0 0 0 20.74 15.327C20.209 14.779 19.665 14.218 19.203 13.454" />
    </Line>
  ),
  circleDashed: (
    <Line>
      <path d="M10.1 2.182a10 10 0 0 1 3.8 0M13.9 21.818a10 10 0 0 1-3.8 0M17.609 3.721a10 10 0 0 1 2.69 2.7M2.182 13.9a10 10 0 0 1 0-3.8M20.279 17.609a10 10 0 0 1-2.7 2.69M21.818 10.1a10 10 0 0 1 0 3.8M3.721 6.391a10 10 0 0 1 2.7-2.69M6.391 20.279a10 10 0 0 1-2.69-2.7" />
    </Line>
  ),
  ban: (
    <Line>
      <path d="M4.929 4.929 19.07 19.071" />
      <circle cx="12" cy="12" r="10" />
    </Line>
  ),
  monitor: icons.monitor,
  folder: (
    <Line>
      <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
    </Line>
  ),
  plus: icons.plus,
  search: (
    <Line>
      <path d="m21 21-4.34-4.34" />
      <circle cx="11" cy="11" r="8" />
    </Line>
  ),
  squarePen: (
    <Line>
      <path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z" />
    </Line>
  ),
  layoutGridCircles: (
    <Line>
      <circle cx="17.5" cy="17.5" r="3.5" />
      <circle cx="17.5" cy="6.5" r="3.5" />
      <circle cx="6.5" cy="17.5" r="3.5" />
      <circle cx="6.5" cy="6.5" r="3.5" />
    </Line>
  ),
  checkCheck: (
    <Line>
      <path d="M18 6 7 17l-5-5" />
      <path d="m22 10-7.5 7.5L13 16" />
    </Line>
  ),
  circleCheck: (
    <Line>
      <circle cx="12" cy="12" r="10" />
      <path d="m9 12 2 2 4-4" />
    </Line>
  ),
  copy: (
    <Line>
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Line>
  ),
  circle: (
    <Line>
      <circle cx="12" cy="12" r="10" />
    </Line>
  ),
  circleDot: (
    <Line>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="1" />
    </Line>
  ),
  arrowUp: icons.send,
  stop: icons.stop,
};

const marks: Record<Model, string> = { claude, deepseek, openai, qwen };

export function ModelLogo({ model }: { model: Model }) {
  // The files are this repo's own SVGs, not user input.
  return <span className="mock-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: marks[model] }} />;
}
