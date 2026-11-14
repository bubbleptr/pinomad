// The mailed 6-digit code's field: six boxes over one real input, so the
// label, autofill and paste keep working.
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { CodeField } from "./code-field.tsx";

function Harness({ onEnter, error }: { onEnter?: () => void; error?: string }) {
  const [code, setCode] = useState("");
  return <CodeField label="Code" value={code} onValueChange={setCode} onEnter={onEnter} error={error} />;
}

describe("CodeField", () => {
  it("is one input the OS can fill with a mailed code", () => {
    render(<Harness />);
    const input = screen.getByLabelText("Code");
    expect(input.getAttribute("autocomplete")).toBe("one-time-code");
    expect(input.getAttribute("inputmode")).toBe("numeric");
  });

  /** Mail clients copy the code as it's shown, often with a space in it. */
  it("keeps the digits of a pasted code", async () => {
    render(<Harness />);
    const input = screen.getByLabelText("Code") as HTMLInputElement;
    await userEvent.click(input);
    await userEvent.paste("123 456");
    expect(input.value).toBe("123456");
  });

  it("submits on Enter", async () => {
    const onEnter = vi.fn();
    render(<Harness onEnter={onEnter} />);
    await userEvent.type(screen.getByLabelText("Code"), "123456{Enter}");
    expect(onEnter).toHaveBeenCalledOnce();
  });

  /** A refused code is retyped whole, not edited in its last box. */
  it("starts over when a refused code is typed again", async () => {
    function Refused() {
      const [code, setCode] = useState("123456");
      return <CodeField label="Code" value={code} onValueChange={setCode} error="That code is wrong." />;
    }
    render(<Refused />);
    const input = screen.getByLabelText("Code") as HTMLInputElement;
    await userEvent.click(input);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await userEvent.keyboard("987654");
    expect(input.value).toBe("987654");
  });

  it("names the error on the input", () => {
    render(<Harness error="That code is wrong." />);
    const input = screen.getByLabelText("Code");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("That code is wrong.").id).not.toBe("");
    expect(input.getAttribute("aria-describedby")).toContain(screen.getByText("That code is wrong.").id);
  });
});
