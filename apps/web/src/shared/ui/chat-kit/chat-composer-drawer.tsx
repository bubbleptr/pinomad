// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/ChatComposerDrawer.tsx (MIT).

import { useId, useState, type ReactElement, type ReactNode, type Ref } from "react";
import { cn } from "cn";
import { ChatBadge } from "./chat-badge";
import { themeProps, type BaseProps } from "./theme-props";

export interface ChatComposerDrawerProps extends BaseProps<HTMLDivElement> {
  ref?: Ref<HTMLDivElement>;
  /**
   * Content to render inside the drawer — attachments, context chips, previews, etc.
   */
  children: ReactNode;
  /**
   * Total item count — shown in the collapsed badge.
   * When omitted, the component doesn't support collapse.
   */
  count?: number;
  /**
   * Label shown next to the count in collapsed state.
   * @default 'Items'
   */
  label?: string;
  /**
   * Whether the drawer is collapsed.
   * Uncontrolled by default (internal toggle).
   */
  isCollapsed?: boolean;
  /**
   * Default collapsed state for uncontrolled usage.
   * @default false
   */
  defaultIsCollapsed?: boolean;
  /**
   * Callback when collapsed state changes.
   */
  onCollapsedChange?: (isCollapsed: boolean) => void;
  "data-testid"?: string;
}

// The drawer tucks behind the composer (negative bottom margin) and its top
// corners follow the composer's 28px chat radius. The muted tint layers over
// the surface color as a background image, so it paints behind the content
// whether muted is opaque or translucent.
const rootClass =
  "relative z-[1] flex flex-col overflow-hidden px-4 pt-3 pb-[calc(var(--spacing-3)_+_28px)] -mb-[28px] rounded-t-[28px] bg-[var(--surface)] [background-image:linear-gradient(var(--surface-muted),var(--surface-muted))]";

// The bar handle and the count + label share one grid cell and crossfade.
const toggleRowClass = "group/drawer-toggle -mx-4 grid h-5 cursor-pointer grid-cols-1 items-center px-4 select-none";

const fadeFast = "transition-opacity duration-[var(--duration-fast)] ease-[var(--ease-standard)]";

/**
 * Collapsible drawer panel for a chat composer.
 * Use for attachments, context chips, or any supplementary content above the input.
 *
 * @example
 * ```
 * <ChatComposerDrawer count={3}>
 *   <AttachmentThumbnail />
 *   <AttachmentThumbnail />
 * </ChatComposerDrawer>
 * ```
 */
export function ChatComposerDrawer({
  ref,
  children,
  count,
  label: labelFromProps,
  isCollapsed: controlledCollapsed,
  defaultIsCollapsed = false,
  onCollapsedChange,
  className,
  style,
  "data-testid": testId,
  ...htmlProps
}: ChatComposerDrawerProps): ReactElement {
  const label = labelFromProps ?? "Items";
  const [internalCollapsed, setInternalCollapsed] = useState(defaultIsCollapsed);
  const isControlled = controlledCollapsed !== undefined;
  const isCollapsed = isControlled ? controlledCollapsed : internalCollapsed;

  const canCollapse = count != null;

  // Links the toggle to the region it shows/hides so assistive tech can move
  // from the button to its controlled content (disclosure pattern). The
  // content stays mounted while collapsed (hidden via the grid-row collapse),
  // so the reference always resolves.
  const contentId = useId();

  const toggle = () => {
    const next = !isCollapsed;
    if (!isControlled) {
      setInternalCollapsed(next);
    }
    onCollapsedChange?.(next);
  };

  const theme = themeProps("chat-composer-drawer", {
    collapsed: isCollapsed ? "collapsed" : null,
  });

  return (
    <div
      ref={ref}
      data-testid={testId}
      {...theme}
      className={cn(theme.className, rootClass, className)}
      style={style}
      {...htmlProps}
    >
      {canCollapse && (
        <div
          className={toggleRowClass}
          role="button"
          tabIndex={0}
          aria-expanded={!isCollapsed}
          aria-controls={contentId}
          aria-label={isCollapsed ? `Expand ${label}` : `Collapse ${label}`}
          onClick={toggle}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              toggle();
            }
          }}
        >
          <div
            className={cn(
              "col-start-1 row-start-1 inline-flex h-5 items-center gap-2 justify-self-start rounded-[var(--radius-full)] opacity-100",
              fadeFast,
              !isCollapsed && "pointer-events-none opacity-0",
            )}
          >
            <ChatBadge variant="neutral" label={count} />
            <span className="text-[length:var(--font-size-base)] leading-5 text-[var(--muted-foreground)] transition-[color] duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover/drawer-toggle:text-[var(--foreground)]">
              {label}
            </span>
          </div>
          <div
            className={cn(
              "col-start-1 row-start-1 h-0.5 w-5 self-start justify-self-center rounded-[var(--radius-full)] bg-[var(--muted-foreground)] opacity-100 transition-[background-color,opacity] duration-[var(--duration-fast)] ease-[var(--ease-standard)] group-hover/drawer-toggle:bg-[var(--foreground)]",
              isCollapsed && "pointer-events-none opacity-0",
            )}
          />
        </div>
      )}

      <div
        id={contentId}
        inert={canCollapse && isCollapsed}
        className={cn(
          "grid grid-rows-[1fr] transition-[grid-template-rows] duration-300 ease-[var(--ease-standard)]",
          canCollapse && isCollapsed && "grid-rows-[0fr]",
        )}
      >
        <div
          className={cn(
            "flex min-h-0 flex-wrap items-start gap-1 opacity-100 transition-opacity delay-[var(--duration-fast)] duration-300 ease-[var(--ease-standard)]",
            canCollapse && isCollapsed && "opacity-0 delay-0 duration-[var(--duration-fast)]",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

ChatComposerDrawer.displayName = "ChatComposerDrawer";
