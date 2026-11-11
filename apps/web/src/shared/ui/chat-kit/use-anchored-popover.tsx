// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Layer/useLayer.tsx,
// src/Layer/anchorName.ts and src/Popover/usePopover.tsx (MIT): the subset
// the composer's trigger menu uses — a light-dismiss native popover anchored
// with CSS anchor positioning, rendered in place (not portaled) so chat.css
// can reach it as a child of the input, with Astryx's popover surface.

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { cn } from "cn";

export type LayerPlacement = "above" | "below" | "start" | "end";
export type LayerAlignment = "start" | "center" | "end";

function readAnchorNames(el: HTMLElement): string[] {
  const value = (el.style as unknown as Record<string, string>).anchorName ?? "";
  return value
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
}

function writeAnchorNames(el: HTMLElement, names: string[]): void {
  (el.style as unknown as Record<string, string>).anchorName = names.join(", ");
}

function addAnchorName(el: HTMLElement, name: string): void {
  const names = readAnchorNames(el);
  if (!names.includes(name)) {
    names.push(name);
    writeAnchorNames(el, names);
  }
}

function removeAnchorName(el: HTMLElement, name: string): void {
  writeAnchorNames(
    el,
    readAnchorNames(el).filter((existing) => existing !== name),
  );
}

/**
 * Logical placement/alignment as a CSS position-area. The self-* family
 * resolves against the popover's own inherited direction, so RTL mirrors
 * with no JS.
 */
function getPositionArea(placement: LayerPlacement = "above", alignment: LayerAlignment = "center"): string {
  if (placement === "above" || placement === "below") {
    const block = placement === "above" ? "self-block-start" : "self-block-end";
    if (alignment === "start") {
      return `${block} span-self-inline-end`;
    }
    if (alignment === "end") {
      return `${block} span-self-inline-start`;
    }
    return block;
  }
  const inline = placement === "start" ? "self-inline-start" : "self-inline-end";
  if (alignment === "start") {
    return `${inline} span-self-block-end`;
  }
  if (alignment === "end") {
    return `${inline} span-self-block-start`;
  }
  return inline;
}

function getPositionTryFallbacks(placement: LayerPlacement = "above", alignment: LayerAlignment = "center"): string {
  const flips = "flip-block, flip-inline, flip-block flip-inline";
  if (alignment !== "center") {
    return flips;
  }
  if (placement === "above" || placement === "below") {
    const [same, opposite] = placement === "above" ? ["top", "bottom"] : ["bottom", "top"];
    return `${flips}, ${same} span-left, ${same} span-right, ${opposite} span-left, ${opposite} span-right`;
  }
  const [same, opposite] = placement === "start" ? ["left", "right"] : ["right", "left"];
  return `${flips}, ${same} span-top, ${same} span-bottom, ${opposite} span-top, ${opposite} span-bottom`;
}

export interface AnchoredPopoverRenderProps {
  placement?: LayerPlacement;
  alignment?: LayerAlignment;
  /** Classes for the positioned popover element (spacing from the anchor, sizing). */
  className?: string;
}

export interface UseAnchoredPopoverReturn {
  /** Ref callback for the anchor element. */
  triggerRef: (el: HTMLElement | null) => void;
  show: () => void;
  hide: () => void;
  isOpen: boolean;
  id: string;
  render: (children: ReactNode, props?: AnchoredPopoverRenderProps) => ReactNode;
}

/**
 * Astryx `usePopover({ hasLightDismiss: true, hasAutoFocus: false,
 * hasCloseButton: false, role: 'none' })`. Not ported: Astryx's shared
 * Escape stack and Tab wrapping, which only matter for popovers holding focus
 * (this one never does: focus stays in the anchor's editable).
 */
export function useAnchoredPopover({ onHide }: { onHide?: () => void } = {}): UseAnchoredPopoverReturn {
  const id = useId();
  const anchorId = `--astryx-layer-${id.replace(/:/g, "")}`;

  const [isOpen, setIsOpen] = useState(false);
  const popoverRef = useRef<HTMLElement | null>(null);
  const triggerElRef = useRef<HTMLElement | null>(null);
  // Mirrors isOpen for synchronous reads inside show/hide.
  const isOpenRef = useRef(false);

  const show = useCallback(() => {
    const popover = popoverRef.current;
    if (popover && !isOpenRef.current) {
      // The Popover API is missing on older engines (and jsdom): fall back to
      // plain visibility so the layer still shows.
      if (typeof popover.showPopover === "function") {
        popover.showPopover();
      } else {
        popover.style.display = "block";
      }
      isOpenRef.current = true;
      setIsOpen(true);
    }
  }, []);

  const hide = useCallback(() => {
    if (isOpenRef.current) {
      const el = popoverRef.current;
      if (el) {
        if (typeof el.hidePopover === "function") {
          el.hidePopover();
        } else {
          el.style.display = "none";
        }
      }
      isOpenRef.current = false;
      setIsOpen(false);
      onHide?.();
    }
  }, [onHide]);

  const triggerRef = useCallback(
    (el: HTMLElement | null) => {
      // Remove only this layer's anchor name, so other layers sharing the
      // element keep theirs.
      if (triggerElRef.current && triggerElRef.current !== el) {
        removeAnchorName(triggerElRef.current, anchorId);
      }
      if (el) {
        addAnchorName(el, anchorId);
      }
      triggerElRef.current = el;
    },
    [anchorId],
  );

  // Reconcile browser-initiated closes (light dismiss, popover="auto" stack
  // eviction); the isOpenRef guard skips the toggle our own hide() causes.
  const handleToggle = useCallback(
    (e: Event) => {
      const toggleEvent = e as ToggleEvent;
      if (toggleEvent.newState === "closed" && isOpenRef.current) {
        isOpenRef.current = false;
        setIsOpen(false);
        onHide?.();
      }
    },
    [onHide],
  );

  const listenedElRef = useRef<HTMLElement | null>(null);
  const listenedHandlerRef = useRef<((e: Event) => void) | null>(null);

  const bindToggleListener = useCallback((el: HTMLElement | null, handler: (e: Event) => void) => {
    if (
      listenedElRef.current &&
      listenedHandlerRef.current &&
      (listenedElRef.current !== el || listenedHandlerRef.current !== handler)
    ) {
      listenedElRef.current.removeEventListener("toggle", listenedHandlerRef.current);
      listenedElRef.current = null;
      listenedHandlerRef.current = null;
    }
    if (el && listenedElRef.current !== el) {
      el.addEventListener("toggle", handler);
      listenedElRef.current = el;
      listenedHandlerRef.current = handler;
    }
  }, []);

  const popoverRefCallback = useCallback(
    (el: HTMLElement | null) => {
      popoverRef.current = el;
      bindToggleListener(el, handleToggle);
    },
    [handleToggle, bindToggleListener],
  );

  useEffect(() => {
    if (popoverRef.current) {
      bindToggleListener(popoverRef.current, handleToggle);
    }
    return () => {
      if (listenedElRef.current && listenedHandlerRef.current) {
        listenedElRef.current.removeEventListener("toggle", listenedHandlerRef.current);
        listenedElRef.current = null;
        listenedHandlerRef.current = null;
      }
    };
  }, [handleToggle, bindToggleListener]);

  // Astryx's focus trap restores focus to what held it when the layer opened,
  // but only when closing would otherwise drop focus to <body>.
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const container = popoverRef.current;
    return () => {
      const active = document.activeElement;
      const focusWasLost =
        active == null ||
        active === document.body ||
        active === document.documentElement ||
        (container != null && container.contains(active));
      if (!focusWasLost) {
        return;
      }
      if (previouslyFocused != null && previouslyFocused.isConnected && typeof previouslyFocused.focus === "function") {
        previouslyFocused.focus();
      }
    };
  }, [isOpen]);

  const render = useCallback(
    (children: ReactNode, props?: AnchoredPopoverRenderProps): ReactNode => {
      const { placement = "above", alignment = "center", className } = props ?? {};
      return (
        <div
          ref={popoverRefCallback}
          id={id}
          popover="auto"
          className={cn("m-0 overflow-visible border-0 border-none bg-transparent p-0 font-sans", className)}
          style={{
            positionAnchor: anchorId,
            positionArea: getPositionArea(placement, alignment),
            positionTryFallbacks: getPositionTryFallbacks(placement, alignment),
          } as CSSProperties}
        >
          <div
            className="relative rounded-[var(--radius-container)] bg-[var(--color-background-popover)] [box-shadow:var(--shadow-low,0_2px_4px_light-dark(oklch(0_0_0/5%),oklch(0_0_0/25%)),0_4px_8px_light-dark(oklch(0_0_0/10%),oklch(0_0_0/40%)),inset_0_0_0_1px_light-dark(transparent,oklch(1_0_0/8%)))]"
          >
            {children}
          </div>
        </div>
      );
    },
    [anchorId, id, popoverRefCallback],
  );

  return { triggerRef, show, hide, isOpen, id, render };
}
