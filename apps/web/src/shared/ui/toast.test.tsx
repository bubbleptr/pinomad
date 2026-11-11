// The app nests AppFrame's Toaster inside App's root one: a toast from either
// side must land in a single stack, not two overlapping ones.
import { act, render } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { Toaster, useToast } from "./toast.tsx";

function Show({ text }: { text: string }) {
  const toast = useToast();
  useEffect(() => void toast({ description: text, timeout: 0 }), [toast, text]);
  return null;
}

describe("Toaster", () => {
  it("keeps one stack when nested, for toasts from inside and outside the inner one", async () => {
    render(
      <Toaster>
        <Show text="from the root" />
        <Toaster>
          <Show text="from the frame" />
        </Toaster>
      </Toaster>,
    );
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
    const stacks = document.querySelectorAll('[role="region"][aria-label="Notifications"]');
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.textContent).toContain("from the root");
    expect(stacks[0]!.textContent).toContain("from the frame");
  });
});
