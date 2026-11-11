// jsdom: Field wires its label, description and error to the control through
// Base UI, so call sites only nest the parts. A description must describe the
// control without becoming part of its name: tests and screen readers find
// controls by exact name.
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./checkbox.tsx";
import { Field, FieldContent, FieldDescription, FieldError, FieldLabel } from "./field.tsx";
import { Input } from "./input.tsx";
import { RadioGroup, RadioGroupItem } from "./radio-group.tsx";
import { Textarea } from "./textarea.tsx";

describe("Field", () => {
  it("names an input by its label and describes it by the description and the error", () => {
    render(
      <Field invalid>
        <FieldLabel>Host name</FieldLabel>
        <FieldDescription>How paired devices name this machine.</FieldDescription>
        <Input />
        <FieldError>Needs a displayable character</FieldError>
      </Field>,
    );
    const input = screen.getByRole("textbox", { name: "Host name" });
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("How paired devices name this machine. Needs a displayable character");
  });

  it("labels a textarea like an input", () => {
    render(
      <Field>
        <FieldLabel>Prompt</FieldLabel>
        <Textarea rows={4} />
      </Field>,
    );
    expect(screen.getByRole("textbox", { name: "Prompt" }).tagName).toBe("TEXTAREA");
  });

  it("keeps a checkbox's or radio's description out of its name", () => {
    render(
      <>
        <Field orientation="horizontal">
          <Checkbox />
          <FieldContent>
            <FieldLabel>This is a shared computer</FieldLabel>
            <FieldDescription>Also remove this device.</FieldDescription>
          </FieldContent>
        </Field>
        <RadioGroup aria-label="Token" defaultValue="short">
          <Field orientation="horizontal">
            <RadioGroupItem value="short" />
            <FieldContent>
              <FieldLabel>Short-lived</FieldLabel>
              <FieldDescription>From the refresh flow.</FieldDescription>
            </FieldContent>
          </Field>
        </RadioGroup>
      </>,
    );
    expect(screen.getByRole("checkbox", { name: "This is a shared computer" })).toHaveAccessibleDescription("Also remove this device.");
    expect(screen.getByRole("radio", { name: "Short-lived" })).toHaveAccessibleDescription("From the refresh flow.");
  });
});
