// Copyright (c) Meta Platforms, Inc. and affiliates.
// Ported from @astryxdesign/core 0.3.0 src/Chat/useTriggerMenu.tsx (MIT).

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useId,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "cn";
import { groupItems, type SearchableItem } from "@/shared/ui/typeahead";
import { useAnchoredPopover } from "./use-anchored-popover";
import { themeProps } from "./theme-props";
import type { ChatComposerTrigger, ChatComposerToken } from "./chat-composer-input";

// =============================================================================
// Types
// =============================================================================

export interface TriggerMenuState {
  isActive: boolean;
  activeTrigger: ChatComposerTrigger | null;
  query: string;
  items: SearchableItem[];
  highlightedIndex: number;
  isLoading: boolean;
}

export interface UseTriggerMenuOptions {
  triggers?: ChatComposerTrigger[];
  editableRef: RefObject<HTMLDivElement | null>;
  onInsertToken: (token: ChatComposerToken) => void;
  onInsertText: (text: string) => void;
  onEmitChange: () => void;
  /**
   * Debounce delay in ms before triggering search after typing.
   * @default 150
   */
  debounceMs?: number;
}

export interface UseTriggerMenuReturn {
  state: TriggerMenuState;
  /** Call on every input event to check for trigger activation */
  handleInput: () => void;
  /** Call on keydown — returns true if the event was consumed */
  handleKeyDown: (e: KeyboardEvent) => boolean;
  /** Render the trigger menu popover */
  renderMenu: () => ReactNode;
  /** Reset/close the trigger menu */
  reset: () => void;
  /**
   * ARIA props to spread onto the editable element. When triggers are
   * configured the element becomes a `combobox` (which is the only role that
   * permits `aria-expanded`/`aria-haspopup`/`aria-controls`/
   * `aria-activedescendant`); otherwise it stays a plain `textbox` and no
   * combobox attributes are emitted.
   */
  ariaProps: {
    role: "combobox" | "textbox";
    "aria-expanded"?: boolean;
    "aria-controls"?: string;
    "aria-activedescendant"?: string;
    "aria-haspopup"?: "listbox";
  };
}

// =============================================================================
// Styles
// =============================================================================

const styles = {
  dropdown: "box-border max-h-60 min-w-[180px] overflow-y-auto p-1",
  popoverSurface: "my-1 min-w-[180px]",
  item: "box-border flex w-full cursor-pointer items-center rounded-[var(--radius-element)] border-none bg-transparent p-2 text-start font-sans text-[length:var(--font-size-base)] leading-[1.4286] text-[var(--color-text-primary)] outline-none",
  itemHighlighted: "bg-[var(--color-overlay-hover)]",
  itemLabel: "min-w-0 flex-1 truncate",
  emptyState: "p-3 text-center text-[length:var(--font-size-sm)] text-[var(--color-text-secondary)]",
  loadingState: "p-3 text-center text-[length:var(--font-size-sm)] text-[var(--color-text-secondary)]",
  groupHeading:
    "px-2 pt-2 pb-1 text-[length:var(--font-size-sm)] leading-[1.6667] text-[var(--color-text-secondary)] select-none",
};

// =============================================================================
// Helpers
// =============================================================================

function getTextBeforeCursor(editable: HTMLDivElement): string | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (!range.collapsed) {
    return null;
  }
  if (!editable.contains(range.startContainer)) {
    return null;
  }

  const node = range.startContainer;
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent ?? "").slice(0, range.startOffset);
  }

  return null;
}

function findActiveTrigger(
  textBeforeCursor: string,
  triggers: ChatComposerTrigger[],
): {
  trigger: ChatComposerTrigger;
  query: string;
  triggerStart: number;
} | null {
  for (let i = textBeforeCursor.length - 1; i >= 0; i--) {
    const char = textBeforeCursor[i];

    if (char === " " || char === "\n") {
      return null;
    }

    for (const trigger of triggers) {
      if (char === trigger.character) {
        const prevChar = i > 0 ? textBeforeCursor[i - 1] : null;
        if (prevChar === null || prevChar === " " || prevChar === "\n") {
          const query = textBeforeCursor.slice(i + 1);
          return {trigger, query, triggerStart: i};
        }
      }
    }
  }

  return null;
}

function deleteTriggerText(
  editable: HTMLDivElement,
  triggerStart: number,
): void {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) {
    return;
  }

  const text = node.textContent ?? "";
  const cursorOffset = range.startOffset;

  const before = text.slice(0, triggerStart);
  const after = text.slice(cursorOffset);
  node.textContent = before + after;

  const newRange = document.createRange();
  newRange.setStart(node, triggerStart);
  newRange.collapse(true);
  selection.removeAllRanges();
  selection.addRange(newRange);
}

// =============================================================================
// Hook
// =============================================================================

export function useTriggerMenu(
  options: UseTriggerMenuOptions,
): UseTriggerMenuReturn {
  const {
    triggers,
    editableRef,
    onInsertToken,
    onInsertText,
    onEmitChange,
    debounceMs = 150,
  } = options;

  const listboxId = useId();
  const [state, setState] = useState<TriggerMenuState>({
    isActive: false,
    activeTrigger: null,
    query: "",
    items: [],
    highlightedIndex: 0,
    isLoading: false,
  });

  const triggerStartRef = useRef<number>(-1);
  const searchTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const anchorSpanRef = useRef<HTMLSpanElement | null>(null);

  const removeAnchorSpan = useCallback(() => {
    if (anchorSpanRef.current) {
      anchorSpanRef.current.remove();
      anchorSpanRef.current = null;
    }
  }, []);

  // The popup's own role="listbox" is the exposed semantics; focus stays in
  // the contenteditable composer, so there is no dialog wrapper.
  const popover = useAnchoredPopover({
    onHide: useCallback(() => {
      removeAnchorSpan();
      setState(prev => ({
        ...prev,
        isActive: false,
        activeTrigger: null,
        query: "",
        items: [],
        highlightedIndex: 0,
        isLoading: false,
      }));
    }, [removeAnchorSpan]),
  });

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }
      removeAnchorSpan();
    };
  }, [removeAnchorSpan]);

  const reset = useCallback(() => {
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
    // Cancel any in-flight search on the active trigger's searchSource
    const trigger = state.activeTrigger;
    if (trigger?.searchSource) {
      trigger.searchSource.cancel?.();
    }
    removeAnchorSpan();
    popover.hide();
    triggerStartRef.current = -1;
  }, [popover, state.activeTrigger, removeAnchorSpan]);

  // Anchor the popover to the cursor position (not the entire input).
  // We append a zero-size span to document.body positioned at the cursor
  // rect — outside the contentEditable to avoid splitting text nodes.
  const setAnchor = useCallback(() => {
    const editable = editableRef.current;
    if (!editable) {
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      popover.triggerRef(editable);
      return;
    }

    removeAnchorSpan();

    const range = selection.getRangeAt(0).cloneRange();
    range.collapse(true);

    // getBoundingClientRect is unavailable in some environments (e.g. jsdom)
    const rect =
      typeof range.getBoundingClientRect === "function"
        ? range.getBoundingClientRect()
        : null;

    // Fall back to the editable when layout info is unavailable
    if (
      !rect ||
      (rect.width === 0 &&
        rect.height === 0 &&
        rect.top === 0 &&
        rect.left === 0)
    ) {
      popover.triggerRef(editable);
      return;
    }

    const span = document.createElement("span");
    span.setAttribute("aria-hidden", "true");
    span.setAttribute("data-astryx-trigger-anchor", "");
    span.style.position = "fixed";
    span.style.left = `${rect.left}px`;
    span.style.top = `${rect.top}px`;
    span.style.width = `${Math.max(rect.width, 1)}px`;
    span.style.height = `${rect.height}px`;
    span.style.pointerEvents = "none";
    span.style.opacity = "0";
    document.body.appendChild(span);

    anchorSpanRef.current = span;
    popover.triggerRef(span);
  }, [editableRef, popover, removeAnchorSpan]);

  const searchItems = useCallback(
    (trigger: ChatComposerTrigger, query: string) => {
      // Clear any pending debounce
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
        searchTimeoutRef.current = null;
      }

      const doSearch = () => {
        if (trigger.searchSource) {
          // Use SearchSource — cancel previous, then search
          trigger.searchSource.cancel?.();
          setState(prev => ({...prev, isLoading: true}));
          const result = trigger.searchSource.search(query);
          Promise.resolve(result).then(
            items => {
              setState(prev => ({
                ...prev,
                items,
                highlightedIndex: items.length > 0 ? 0 : -1,
                isLoading: false,
              }));
            },
            () => {
              setState(prev => ({
                ...prev,
                items: [],
                highlightedIndex: -1,
                isLoading: false,
              }));
            },
          );
        }
      };

      // Debounce async sources, immediate for sync
      if (trigger.searchSource) {
        // Check if search is likely sync (returns array, not promise)
        const testResult = trigger.searchSource.search("");
        const isAsync = testResult instanceof Promise;
        if (isAsync && debounceMs > 0) {
          setState(prev => ({...prev, isLoading: true}));
          searchTimeoutRef.current = setTimeout(doSearch, debounceMs);
        } else {
          doSearch();
        }
      }
    },
    [debounceMs],
  );

  const selectItem = useCallback(
    (item: SearchableItem) => {
      const trigger = state.activeTrigger;
      if (!trigger) {
        return;
      }

      const editable = editableRef.current;
      if (!editable) {
        return;
      }

      // Clean up anchor span before modifying DOM — if the span were
      // inside the editable it would split text nodes and break offsets.
      // With the body-appended approach this is just bookkeeping.
      removeAnchorSpan();

      deleteTriggerText(editable, triggerStartRef.current);

      const result = trigger.onSelect(item);
      if (typeof result === "string") {
        onInsertText(result);
      } else {
        onInsertToken(result);
      }

      onEmitChange();
      reset();
    },
    [
      state.activeTrigger,
      editableRef,
      removeAnchorSpan,
      onInsertText,
      onInsertToken,
      onEmitChange,
      reset,
    ],
  );

  const handleInput = useCallback(() => {
    if (!triggers || triggers.length === 0) {
      return;
    }

    const editable = editableRef.current;
    if (!editable) {
      return;
    }

    const textBefore = getTextBeforeCursor(editable);
    if (textBefore === null) {
      if (state.isActive) {
        reset();
      }
      return;
    }

    const found = findActiveTrigger(textBefore, triggers);
    if (!found) {
      if (state.isActive) {
        reset();
      }
      return;
    }

    const {trigger, query, triggerStart} = found;

    if (!state.isActive || state.activeTrigger !== trigger) {
      triggerStartRef.current = triggerStart;
      setState(prev => ({
        ...prev,
        isActive: true,
        activeTrigger: trigger,
        query,
        highlightedIndex: 0,
      }));
      setAnchor();
      searchItems(trigger, query);
      popover.show();
    } else if (state.query !== query) {
      setState(prev => ({...prev, query}));
      searchItems(trigger, query);
    }
  }, [
    triggers,
    editableRef,
    state.isActive,
    state.activeTrigger,
    state.query,
    reset,
    setAnchor,
    searchItems,
    popover,
  ]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent): boolean => {
      if (!state.isActive || !popover.isOpen) {
        return false;
      }

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          setState(prev => ({
            ...prev,
            highlightedIndex:
              prev.highlightedIndex < prev.items.length - 1
                ? prev.highlightedIndex + 1
                : 0,
          }));
          return true;
        }
        case "ArrowUp": {
          e.preventDefault();
          setState(prev => ({
            ...prev,
            highlightedIndex:
              prev.highlightedIndex > 0
                ? prev.highlightedIndex - 1
                : prev.items.length - 1,
          }));
          return true;
        }
        case "Enter":
        case "Tab": {
          if (
            state.highlightedIndex >= 0 &&
            state.highlightedIndex < state.items.length
          ) {
            e.preventDefault();
            selectItem(state.items[state.highlightedIndex]);
            return true;
          }
          return false;
        }
        case "Escape": {
          e.preventDefault();
          reset();
          return true;
        }
        default:
          return false;
      }
    },
    [
      state.isActive,
      state.highlightedIndex,
      state.items,
      popover.isOpen,
      selectItem,
      reset,
    ],
  );

  const getItemId = useCallback(
    (index: number) => `${listboxId}-option-${index}`,
    [listboxId],
  );

  // Scroll highlighted item into view on keyboard navigation
  useEffect(() => {
    if (!popover.isOpen || state.highlightedIndex < 0) {
      return;
    }
    const el = document.getElementById(getItemId(state.highlightedIndex));
    el?.scrollIntoView({block: "nearest"});
  }, [state.highlightedIndex, popover.isOpen, getItemId]);

  // ARIA props for the editable element. Combobox attributes
  // (aria-expanded/haspopup/controls/activedescendant) are only valid on
  // role="combobox", so we only switch to that role — and only emit those
  // attributes — when triggers are actually configured. With no triggers the
  // element stays a plain role="textbox".
  const hasTriggers = (triggers?.length ?? 0) > 0;
  const ariaProps: UseTriggerMenuReturn["ariaProps"] = !hasTriggers
    ? {role: "textbox"}
    : state.isActive && popover.isOpen
      ? {
          role: "combobox",
          "aria-expanded": true as const,
          "aria-controls": listboxId,
          "aria-activedescendant":
            state.highlightedIndex >= 0
              ? getItemId(state.highlightedIndex)
              : undefined,
          "aria-haspopup": "listbox" as const,
        }
      : {
          role: "combobox",
          "aria-expanded": false as const,
          "aria-haspopup": "listbox" as const,
        };

  const renderMenu = useCallback((): ReactNode => {
    const trigger = state.activeTrigger;
    const emptyText = trigger?.emptySearchResultsText ?? "No results";
    const loadingText = trigger?.loadingText ?? "Searching…";

    let listContent: ReactNode;
    if (state.isLoading) {
      listContent = (
        <div role="status" className={styles.loadingState}>
          {loadingText}
        </div>
      );
    } else if (state.items.length === 0 && state.isActive) {
      listContent = <div className={styles.emptyState}>{emptyText}</div>;
    } else {
      const groups = groupItems(state.items);
      let flatIndex = 0;
      listContent = groups.map(group => {
        const groupItems = group.items.map(item => {
          const idx = flatIndex++;
          return (
            <div
              key={item.id}
              id={getItemId(idx)}
              role="option"
              aria-selected={idx === state.highlightedIndex}
              tabIndex={-1}
              onMouseDown={e => {
                e.preventDefault(); // Keep focus in the editable
                selectItem(item);
              }}
              onMouseEnter={() =>
                setState(prev => ({...prev, highlightedIndex: idx}))
              }
              className={cn(styles.item, idx === state.highlightedIndex && styles.itemHighlighted)}
            >
              {trigger?.renderItem ? (
                trigger.renderItem(item)
              ) : (
                <span className={styles.itemLabel}>{item.label}</span>
              )}
            </div>
          );
        });
        if (group.heading) {
          return (
            <div key={`group-${group.heading}`} role="group" aria-label={group.heading}>
              <div aria-hidden="true" className={styles.groupHeading}>
                {group.heading}
              </div>
              {groupItems}
            </div>
          );
        }
        return groupItems;
      });
    }

    const theme = themeProps("trigger-menu");
    return popover.render(
      <div
        id={listboxId}
        role="listbox"
        aria-label={trigger?.menuLabel ?? "Suggestions"}
        {...theme}
        className={cn(theme.className, styles.dropdown)}
      >
        {listContent}
      </div>,
      {
        placement: "above",
        alignment: "start",
        surfaceClassName: styles.popoverSurface,
      },
    );
  }, [popover, listboxId, state, selectItem, getItemId]);

  return {
    state,
    handleInput,
    handleKeyDown,
    renderMenu,
    reset,
    ariaProps,
  };
}
