import type { ComponentProps } from "react";
import type { ToolKind } from "@pinomad/client/tool-item.ts";
import { FileIcon, Globe, Pencil, Search, SquareTerminal, Wrench } from "@/shared/ui/icons";

const KIND_ICONS = {
  shell: SquareTerminal,
  search: Search,
  web: Globe,
  file: FileIcon,
  edit: Pencil,
  tool: Wrench,
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
