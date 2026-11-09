import type { ReactNode } from "react";
import claude from "./logos/claude-color.svg?raw";
import deepseek from "./logos/deepseek-color.svg?raw";
import openai from "./logos/openai.svg?raw";
import qwen from "./logos/qwen-color.svg?raw";
import type { Model } from "./runs.ts";

// The client's icons, drawn inline: Lucide outlines (docs/licenses/lucide.md), the
// Hugeicons New chat and panel glyphs from apps/web/src/shared/ui/animated-icons.tsx
// (docs/licenses/animated-icons.md), and the LobeHub model marks the web client uses
// (docs/licenses/lobehub-icons.md).

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

const marks: Record<Model, string> = { claude, deepseek, openai, qwen };

export function ModelLogo({ model }: { model: Model }) {
  // The files are this repo's own SVGs, not user input.
  return <span className="mock-logo" aria-hidden="true" dangerouslySetInnerHTML={{ __html: marks[model] }} />;
}
