import { cn } from "cn";
import { createContext, useContext, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/shared/ui/dropdown-menu";
import { ChevronDown } from "@/shared/ui/icons";

/*
 * A row of navigation tabs: buttons in a <nav>, the current one marked
 * aria-current="page" (data-current) and in the foreground color; the caller
 * draws its surface (the terminal tabs put it on a slot that also holds the
 * close button). Unlike Base UI Tabs there are no
 * panels and no tablist role, so a close button can sit between two tabs and
 * a menu can take the tabs that don't fit. Arrow keys move focus along the
 * row; Tab enters it on the current tab.
 */

interface TabListState {
  readonly value: string;
  readonly onChange: (value: string) => void;
}

const TabListContext = createContext<TabListState>({ value: "", onChange: () => {} });

const STOPS = "[data-tab-value],[data-tab-menu]";

function TabList({
  value,
  onChange,
  className,
  children,
  onKeyDown,
  ...props
}: Omit<ComponentProps<"nav">, "onChange"> & { value: string; onChange: (value: string) => void }) {
  const move = (event: KeyboardEvent<HTMLElement>): void => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const stops = [...event.currentTarget.querySelectorAll<HTMLElement>(STOPS)];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    const next =
      event.key === "ArrowRight" || event.key === "ArrowDown" ? (at + 1) % stops.length
      : event.key === "ArrowLeft" || event.key === "ArrowUp" ? (at - 1 + stops.length) % stops.length
      : event.key === "Home" ? 0
      : event.key === "End" ? stops.length - 1
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    stops[next]?.focus();
  };
  return (
    <TabListContext.Provider value={{ value, onChange }}>
      <nav
        aria-label="Tabs"
        data-slot="tab-list"
        className={cn("flex max-w-full min-w-0 items-stretch gap-0.5", className)}
        onKeyDown={move}
        {...props}
      >
        {children}
      </nav>
    </TabListContext.Provider>
  );
}

const tabClassName = cn(
  "group/tab relative inline-flex h-7 cursor-pointer items-center justify-center gap-1.5 rounded-lg px-3",
  "text-sm/5 whitespace-nowrap text-muted-foreground transition-colors duration-(--duration-fast)",
  "outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-primary",
  "data-current:text-foreground",
);

/** The label; it truncates inside a capped tab. */
function TabLabel({ children }: { children: string }) {
  return (
    <span data-slot="tab-label" className="min-w-0 truncate">
      {children}
    </span>
  );
}

function Tab({
  value,
  label,
  startContent,
  endContent,
  className,
  ...props
}: Omit<ComponentProps<"button">, "value" | "children"> & {
  value: string;
  label: string;
  /** A leading icon, inside the button so it selects the tab too. */
  startContent?: ReactNode;
  endContent?: ReactNode;
}) {
  const list = useContext(TabListContext);
  const current = list.value === value;
  return (
    <button
      type="button"
      data-slot="tab"
      data-tab-value={value}
      data-current={current || undefined}
      aria-current={current ? "page" : undefined}
      tabIndex={current ? 0 : -1}
      className={cn(tabClassName, className)}
      onClick={() => list.onChange(value)}
      {...props}
    >
      {startContent === undefined ? null : <span className="inline-flex shrink-0 items-center">{startContent}</span>}
      <TabLabel>{label}</TabLabel>
      {endContent === undefined ? null : <span className="inline-flex shrink-0 items-center">{endContent}</span>}
    </button>
  );
}

/** The tabs that don't fit, in a menu at the end of the row. */
function TabMenu({ label, options }: { label: string; options: readonly { value: string; label: string }[] }) {
  const list = useContext(TabListContext);
  const selected = options.find((option) => option.value === list.value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-slot="tab-menu"
        data-tab-menu=""
        data-current={selected === undefined ? undefined : true}
        tabIndex={selected === undefined ? -1 : 0}
        className={cn(tabClassName, "[@media(hover:hover)]:hover:bg-surface-hover")}
      >
        <TabLabel>{selected?.label ?? label}</TabLabel>
        <ChevronDown aria-hidden="true" className="size-4 shrink-0 transition-transform group-data-popup-open/tab:rotate-180" />
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {options.map((option) => (
          <DropdownMenuItem key={option.value} onClick={() => list.onChange(option.value)}>
            {option.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export { Tab, TabList, TabMenu };
