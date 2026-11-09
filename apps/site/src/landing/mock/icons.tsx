import type { ReactNode } from "react";
import claude from "./logos/claude-color.svg?raw";
import deepseek from "./logos/deepseek-color.svg?raw";
import openai from "./logos/openai.svg?raw";
import qwen from "./logos/qwen-color.svg?raw";
import type { Model } from "./runs.ts";

// The client's icons: Lucide outlines (docs/licenses/lucide.md) and the LobeHub model
// marks the web client uses (docs/licenses/lobehub-icons.md), drawn inline.

function Line({ children }: { children: ReactNode }) {
  return (
    <svg className="mock-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export const icons = {
  panelLeft: (
    <Line>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M9 3v18" />
    </Line>
  ),
  panelRight: (
    <Line>
      <rect width="18" height="18" x="3" y="3" rx="2" />
      <path d="M15 3v18" />
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
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h8" />
      <path d="M18 2v6M15 5h6" />
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
