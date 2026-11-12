import { cn } from "cn";
import { useId, type ComponentProps, type ReactNode } from "react";
import { ResizeHandle, useResizableWidth } from "@/shared/ui/resize-handle";

/*
 * The sidebar's parts: a nav column with a fixed top, a scrolling middle
 * and a fixed foot; titled groups of rows; and rows that open a page or fold
 * a group of rows below them. Rows are 32px, icon then label, and carry
 * data-slot="side-nav-item" for the app's row styles (styles.css).
 */

/**
 * The nav column, 260px unless `resizable` makes its width draggable within
 * bounds and saved under `autoSaveId`. `header` and `topContent` stay at the
 * top, `footer` at the foot; the children scroll between them.
 */
function SideNav({
  header,
  topContent,
  footer,
  resizable,
  className,
  children,
  "aria-label": label = "Side navigation",
  ...props
}: ComponentProps<"nav"> & {
  header?: ReactNode;
  topContent?: ReactNode;
  footer?: ReactNode;
  resizable?: { defaultWidth: number; minWidth: number; maxWidth: number; autoSaveId: string };
}) {
  const hasTop = header !== undefined || topContent !== undefined;
  const nav = (width?: number) => (
    <nav
      aria-label={label}
      data-slot="side-nav"
      className={cn("flex h-full w-[260px] flex-col overflow-hidden bg-inherit", className)}
      style={width === undefined ? undefined : { width }}
      {...props}
    >
      {hasTop ? (
        <div className="sticky top-0 z-1 flex shrink-0 flex-col gap-2 bg-inherit p-2">
          {header}
          {topContent === undefined ? null : <div>{topContent}</div>}
        </div>
      ) : null}
      <div className={cn("flex-1 overflow-x-hidden overflow-y-auto px-2", hasTop ? "pt-1" : "pt-2", footer === undefined ? "pb-2" : "pb-1")}>
        {children}
      </div>
      {footer === undefined ? null : (
        <div className="sticky bottom-0 mt-auto flex shrink-0 flex-col bg-inherit px-2 pt-1 pb-4">{footer}</div>
      )}
    </nav>
  );
  return resizable === undefined ? nav() : <ResizableNav config={resizable} nav={nav} />;
}

function ResizableNav({
  config,
  nav,
}: {
  config: NonNullable<ComponentProps<typeof SideNav>["resizable"]>;
  nav: (width: number) => ReactNode;
}) {
  const width = useResizableWidth({
    defaultSize: config.defaultWidth,
    min: config.minWidth,
    max: config.maxWidth,
    autoSaveId: config.autoSaveId,
  });
  return (
    <div className="relative flex h-full shrink-0">
      {nav(width.size)}
      <ResizeHandle width={width} label="Resize sidebar" />
    </div>
  );
}

/** A group of rows under a title; `isHeaderHidden` keeps the title for screen readers only. */
function SideNavSection({
  title,
  isHeaderHidden = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<"div">, "title"> & { title: string; isHeaderHidden?: boolean }) {
  const titleId = useId();
  return (
    <div
      role="group"
      aria-labelledby={titleId}
      data-slot="side-nav-section"
      className={cn("flex flex-col py-1", className)}
      {...props}
    >
      <div
        data-slot="side-nav-section-title"
        className={cn(
          "truncate px-2 py-1 text-xs/[1.6667] text-muted-foreground select-none",
          isHeaderHidden && "sr-only",
        )}
        id={titleId}
      >
        {title}
      </div>
      <div className="flex flex-col gap-0.5">{children}</div>
    </div>
  );
}

const itemClassName = cn(
  "flex h-8 w-full cursor-pointer items-center gap-2 rounded-(--pigui-sidebar-item-radius) px-2 text-start text-sm/5 text-foreground",
  "not-aria-[current=page]:active:bg-(--surface-pressed) [@media(hover:hover)]:not-aria-[current=page]:hover:bg-surface-hover",
  "aria-[current=page]:bg-default",
  "disabled:pointer-events-none disabled:text-(--disabled-foreground)",
  "[&_svg]:size-(--pigui-sidebar-icon-size) [&_svg]:shrink-0 [&_svg]:[shape-rendering:geometricPrecision]",
);

/**
 * One row. With `onClick` it opens something and `isSelected` marks it
 * current. With `collapsible` and children it folds them instead: the rows
 * below are a group named by the label, kept mounted and inert while folded.
 */
function SideNavItem({
  label,
  icon,
  endContent,
  isSelected = false,
  isDisabled = false,
  onClick,
  collapsible,
  children,
}: {
  label: string;
  icon?: ReactNode;
  /** Trailing content inside the row, after the label. */
  endContent?: ReactNode;
  isSelected?: boolean;
  isDisabled?: boolean;
  onClick?: () => void;
  collapsible?: { isCollapsed: boolean; onCollapsedChange: (isCollapsed: boolean) => void };
  children?: ReactNode;
}) {
  const id = useId();
  const folds = collapsible !== undefined && children !== undefined;
  const collapsed = folds && collapsible.isCollapsed;
  return (
    <div className="flex w-full flex-col">
      <button
        type="button"
        data-slot="side-nav-item"
        className={itemClassName}
        disabled={isDisabled}
        aria-disabled={isDisabled || undefined}
        aria-current={isSelected ? "page" : undefined}
        aria-expanded={folds ? !collapsed : undefined}
        aria-controls={folds ? `${id}-children` : undefined}
        onClick={() => (folds ? collapsible.onCollapsedChange(!collapsed) : onClick?.())}
      >
        {icon}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {endContent === undefined ? null : <span className="flex shrink-0 items-center">{endContent}</span>}
      </button>
      {children === undefined ? null : (
        <div
          id={`${id}-children`}
          role="group"
          aria-labelledby={`${id}-label`}
          aria-hidden={collapsed || undefined}
          inert={collapsed || undefined}
          className={cn(
            "grid transition-[grid-template-rows] duration-300 ease-(--ease-standard)",
            collapsed ? "grid-rows-[0fr]" : "grid-rows-[1fr]",
          )}
        >
          <div className="flex min-h-0 flex-col gap-(--pigui-sidebar-row-gap) overflow-hidden pt-(--pigui-sidebar-row-gap)">
            <span id={`${id}-label`} hidden>
              {label}
            </span>
            {children}
          </div>
        </div>
      )}
    </div>
  );
}

export { SideNav, SideNavItem, SideNavSection };
