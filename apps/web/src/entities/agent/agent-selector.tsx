// The draft's named-agent capsule (ADR-0023, #137): a ghost button like the
// model selector's, "No agent" by default and `@name` once picked, opening a
// list of the host's named agents with their descriptions. Same Popover+List
// composition as ModelSelector so the two capsules read as one row.
import { Button } from "@astryxdesign/core/Button";
import { List, ListItem } from "@astryxdesign/core/List";
import { Popover } from "@astryxdesign/core/Popover";
import type { AgentRoles } from "@pinomad/protocol/agents.ts";
import type { DurableView } from "@pinomad/protocol/view.ts";
import { Bot, Check, ChevronDown } from "@/shared/ui/icons";

export function AgentSelector({
  agents,
  value,
  isDisabled = false,
  onChange,
}: {
  agents: DurableView["agents"];
  /** The picked agent's name, undefined for "No agent". */
  value?: string;
  isDisabled?: boolean;
  onChange: (agent: string | undefined) => void;
}) {
  const roles: AgentRoles["roles"] = agents?.roles ?? [];
  return (
    <Popover
      alignment="start"
      label="Named agent"
      placement="above"
      width={236}
      content={
        <div
          className="flex w-full flex-col gap-1 p-1"
          data-testid="agent-popover"
          // The popover is portal-mounted but React events still bubble to
          // the ChatComposer, whose click-to-focus would steal focus. Keep
          // pointer events inside the popover.
          onClick={(event: React.MouseEvent) => event.stopPropagation()}
          onMouseDown={(event: React.MouseEvent) => event.stopPropagation()}
          onPointerDown={(event: React.PointerEvent) => event.stopPropagation()}
        >
          <List aria-label="Named agent" className="max-h-72 overflow-y-auto" density="compact">
            <ListItem
              endContent={
                value === undefined ? <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" /> : undefined
              }
              isDisabled={isDisabled}
              isSelected={value === undefined}
              label="No agent"
              onClick={() => onChange(undefined)}
            />
            {roles.map((role) => (
              <ListItem
                description={role.description}
                endContent={
                  value === role.name
                    ? <Check aria-hidden="true" className="size-4 shrink-0 text-foreground" />
                    : undefined
                }
                isDisabled={isDisabled}
                isSelected={value === role.name}
                key={role.name}
                label={role.name}
                onClick={() => onChange(role.name)}
              />
            ))}
          </List>
        </div>
      }
    >
      <Button
        className="min-w-0 max-w-[12rem] flex-nowrap gap-1.5 px-2 text-muted"
        data-testid="agent-trigger"
        isDisabled={isDisabled}
        label="Named agent"
        size="sm"
        variant="ghost"
      >
        <span className="flex min-w-0 items-center gap-1.5">
          <Bot aria-hidden="true" className="size-4 shrink-0" />
          <span className="truncate">{value === undefined ? "No agent" : `@${value}`}</span>
          <ChevronDown aria-hidden="true" className="size-4 shrink-0" />
        </span>
      </Button>
    </Popover>
  );
}
