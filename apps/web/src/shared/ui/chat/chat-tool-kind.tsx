import type { ComponentProps } from "react";
import type { ToolKind } from "@pinomad/client/tool-item.ts";
import { AiEditing, CommandLine, FileSearch, Globe, Hammer, SearchVisual } from "@/shared/ui/icons";

const KIND_ICONS = {
  shell: CommandLine,
  search: SearchVisual,
  web: Globe,
  file: FileSearch,
  edit: AiEditing,
  tool: Hammer,
} as const;

export type ChatToolKindIconProps = Omit<ComponentProps<"span">, "children"> & {
  kind: ToolKind;
};

export function ChatToolKindIcon({
  className = "",
  kind,
  ...rest
}: ChatToolKindIconProps) {
  const Icon = KIND_ICONS[kind];

  return (
    <span
      aria-hidden="true"
      className={`chat-tool-kind ${className}`.trim()}
      data-kind={kind}
      data-slot="chat-tool-kind"
      {...rest}
    >
      <Icon />
    </span>
  );
}
