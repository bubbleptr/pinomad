import * as React from "react"
import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

// Rows: a name, an optional line under it, something before (icon, status)
// and actions after. Adapted from shadcn's Item to the app's row metrics:
// borderless, 2px between rows, a normal-weight text-sm/5 title and a
// text-xs/5 description, media centered on the row. The row itself keeps the
// inherited font, so inline media (a status dot) sits on the page's line
// height and single-line rows keep their height.

/** A `ul role="list"`; name it with `aria-label` or `aria-labelledby`. */
function ItemGroup({ className, render, ...props }: useRender.ComponentProps<"ul">) {
  return useRender({
    defaultTagName: "ul",
    props: mergeProps<"ul">(
      {
        role: "list",
        className: cn("group/item-group m-0 flex w-full list-none flex-col gap-0.5 p-0", className),
      },
      props
    ),
    render,
    state: { slot: "item-group" },
  })
}

const itemVariants = cva(
  // A clickable row renders its ItemContent as a <button> whose ::after
  // covers the row, so the whole row takes the click and shows the hover
  // and focus ring, while the button's name stays the title and description.
  "group/item relative flex w-full items-center rounded-[var(--radius-element)] text-start transition-colors duration-100 outline-none has-[>button[data-slot=item-content]:focus-visible]:outline-2 has-[>button[data-slot=item-content]:focus-visible]:outline-solid has-[>button[data-slot=item-content]:focus-visible]:outline-offset-2 has-[>button[data-slot=item-content]:focus-visible]:outline-primary has-[>button[data-slot=item-content]:active]:bg-default aria-[current=true]:bg-accent aria-disabled:cursor-not-allowed aria-disabled:*:opacity-50 [&:has(>button[data-slot=item-content]:enabled)]:cursor-pointer [@media(hover:hover)]:has-[>button[data-slot=item-content]:enabled:hover]:bg-surface-hover [a]:hover:bg-surface-hover",
  {
    variants: {
      variant: {
        default: "",
        outline: "border border-border",
        muted: "bg-surface-muted",
      },
      size: {
        default: "gap-2 px-2 py-2",
        sm: "gap-2 px-2 py-1",
        xs: "gap-2 px-2.5 py-2 in-data-[slot=dropdown-menu-content]:p-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Item({
  className,
  variant = "default",
  size = "default",
  render,
  ...props
}: useRender.ComponentProps<"div"> & VariantProps<typeof itemVariants>) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(itemVariants({ variant, size, className })),
      },
      props
    ),
    render,
    state: {
      slot: "item",
      variant,
      size,
    },
  })
}

const itemMediaVariants = cva(
  "flex shrink-0 items-center justify-center gap-2 [&_svg]:pointer-events-none",
  {
    variants: {
      variant: {
        default: "bg-transparent",
        icon: "[&_svg:not([class*='size-'])]:size-4",
        image:
          "size-10 overflow-hidden rounded-sm group-data-[size=sm]/item:size-8 group-data-[size=xs]/item:size-6 [&_img]:size-full [&_img]:object-cover",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function ItemMedia({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof itemMediaVariants>) {
  return (
    <div
      data-slot="item-media"
      data-variant={variant}
      className={cn(itemMediaVariants({ variant, className }))}
      {...props}
    />
  )
}

/**
 * The title and description. Pass `render={<button type="button" onClick={…} />}`
 * to make the row clickable (see itemVariants).
 */
function ItemContent({ className, render, ...props }: useRender.ComponentProps<"div">) {
  return useRender({
    defaultTagName: "div",
    props: mergeProps<"div">(
      {
        className: cn(
          "flex min-w-0 flex-1 flex-col text-start [&+[data-slot=item-content]]:flex-none [button&]:cursor-[inherit] [button&]:outline-none [button&]:after:absolute [button&]:after:inset-0 [button&]:after:rounded-[inherit] [button&]:disabled:cursor-not-allowed",
          className
        ),
      },
      props
    ),
    render,
    state: { slot: "item-content" },
  })
}

/** One line, truncated. */
function ItemTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-title"
      className={cn("truncate text-sm/5 text-foreground", className)}
      {...props}
    />
  )
}

/**
 * One line, truncated. Two lines: `line-clamp-2 whitespace-normal`; rich
 * content that wraps freely: `overflow-visible whitespace-normal`.
 */
function ItemDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-description"
      className={cn(
        "truncate text-xs/5 font-normal text-muted-foreground",
        className
      )}
      {...props}
    />
  )
}

function ItemActions({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="item-actions"
      className={cn("ms-auto flex shrink-0 items-center gap-2", className)}
      {...props}
    />
  )
}

export {
  Item,
  ItemMedia,
  ItemContent,
  ItemActions,
  ItemGroup,
  ItemTitle,
  ItemDescription,
}
