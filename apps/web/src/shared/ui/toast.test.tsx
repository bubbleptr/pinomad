// The app nests AppFrame's Toaster inside App's root one: a toast from either
// side must land in a single stack, not two overlapping ones.
import { render, waitFor } from "@testing-library/react";
import { useEffect } from "react";
import { describe, expect, it } from "vitest";
import { Toaster, useErrorToast, useToast } from "./toast.tsx";

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
    await waitFor(() => {
      const stacks = document.querySelectorAll('[role="region"][aria-label="Notifications"]');
      expect(stacks).toHaveLength(1);
      expect(stacks[0]!.textContent).toContain("from the root");
      expect(stacks[0]!.textContent).toContain("from the frame");
    });
  });
});

function Action({ attempt }: { attempt: { n: number; fails: boolean } }) {
  const error = useErrorToast();
  useEffect(() => {
    if (attempt.fails) error.show(`Couldn't do it (try ${attempt.n})`);
    else error.clear();
  }, [attempt]);
  return null;
}

describe("useErrorToast", () => {
  const alerts = () => [...document.querySelectorAll("[data-toast-id]")].map((node) => node.textContent);

  it("replaces its last error on a new failure and drops it when the action is retried", async () => {
    const { rerender } = render(
      <Toaster>
        <Action attempt={{ n: 1, fails: true }} />
      </Toaster>,
    );
    await waitFor(() => expect(alerts()).toEqual(["Couldn't do it (try 1)"]));
    rerender(
      <Toaster>
        <Action attempt={{ n: 2, fails: true }} />
      </Toaster>,
    );
    await waitFor(() => expect(alerts()).toEqual(["Couldn't do it (try 2)"]));
    rerender(
      <Toaster>
        <Action attempt={{ n: 3, fails: false }} />
      </Toaster>,
    );
    await waitFor(() => expect(alerts()).toEqual([]));
  });
});
