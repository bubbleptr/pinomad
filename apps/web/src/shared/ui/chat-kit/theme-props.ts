// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/utils/themeProps.ts and
// src/utils/mergeRefs.ts (MIT).

import type { HTMLAttributes, Ref, RefCallback } from "react";

/**
 * Astryx's BaseProps without `xstyle`: the HTML attributes a component root
 * forwards, `className` and `style` included, plus any `data-*` attribute.
 */
export interface BaseProps<T extends HTMLElement = HTMLElement>
  extends Omit<
    HTMLAttributes<T>,
    | "children"
    | "title"
    | "contentEditable"
    | "dangerouslySetInnerHTML"
    | "suppressContentEditableWarning"
    | "suppressHydrationWarning"
    | "popover"
    | "popoverTargetAction"
    | "popoverTarget"
    | "defaultChecked"
    | "defaultValue"
    | "color"
  > {
  [key: `data-${string}`]: string | undefined;
}

type ClassValue = string | number | undefined | null;
type ClassProps = Record<string, ClassValue>;
type ThemeDataAttributes = Record<`data-${string}`, string | undefined>;
export type ThemeProps = { className: string } & ThemeDataAttributes;

function toDataAttributeName(prop: string): `data-${string}` {
  return `data-${prop.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase()}`;
}

/**
 * The root's `data-slot` (`chat-composer`) plus a `data-*` reflection of each
 * variant prop, the way shadcn components mark their parts. The app's CSS
 * (chat.css) and the tests select on these. The roots spread them before
 * their rest props, so a caller's own `data-slot` replaces the default.
 */
export function themeProps(component: string, props?: ClassProps): ThemeProps {
  const attrs: ThemeDataAttributes = { "data-slot": component };
  if (props) {
    for (const [prop, value] of Object.entries(props)) {
      if (value != null) attrs[toDataAttributeName(prop)] = String(value);
    }
  }
  return { className: "", ...attrs };
}

export function mergeRefs<T>(...refs: (Ref<T> | undefined)[]): RefCallback<T> {
  return (value: T | null) => {
    const cleanups: (() => void)[] = [];
    for (const ref of refs) {
      if (typeof ref === "function") {
        const cleanup = ref(value);
        if (typeof cleanup === "function") {
          cleanups.push(cleanup);
        }
      } else if (ref != null) {
        (ref as { current: T | null }).current = value;
      }
    }
    if (cleanups.length > 0) {
      return () => {
        for (const cleanup of cleanups) {
          cleanup();
        }
      };
    }
  };
}
