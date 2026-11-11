import { useCallback, useState } from "react";

/**
 * Where a popup opened from inside an Astryx dialog must portal to. Those
 * dialogs open with showModal(): they sit in the top layer and make the rest
 * of the page inert, so a popup portaled to <body> renders under the dialog
 * and can't be clicked. Returns a ref for any element near the trigger and
 * the open dialog it sits in (undefined outside one: portal to <body>).
 * Goes away once Dialog moves to Base UI (ADR-0048).
 */
export function useDialogPortal(): [ref: (element: Element | null) => void, container: HTMLElement | undefined] {
  const [container, setContainer] = useState<HTMLElement>();
  const ref = useCallback((element: Element | null) => {
    if (element !== null) setContainer(element.closest("dialog") ?? undefined);
  }, []);
  return [ref, container];
}
