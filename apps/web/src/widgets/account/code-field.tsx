import { REGEXP_ONLY_DIGITS } from "input-otp";
import { useId, type ReactElement } from "react";
import { Field, FieldError, FieldLabel } from "../../shared/ui/field.tsx";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "../../shared/ui/input-otp.tsx";

const CODE_LENGTH = 6;

export interface CodeFieldProps {
  readonly label: string;
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** Enter in the field: the form's submit. */
  readonly onEnter?: (() => void) | undefined;
  readonly error?: string | undefined;
}

/**
 * A mailed 6-digit code (ADR-0044 §2): six boxes drawn over one real input,
 * so the OS's one-time-code autofill and password managers still fill it.
 * Not a Base UI control, so the label and error are linked by hand.
 */
export function CodeField({ label, value, onValueChange, onEnter, error }: CodeFieldProps): ReactElement {
  const id = useId();
  const errorId = `${id}-error`;
  const invalid = error !== undefined;
  return (
    <Field invalid={invalid}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputOTP
        id={id}
        maxLength={CODE_LENGTH}
        value={value}
        onChange={onValueChange}
        pattern={REGEXP_ONLY_DIGITS}
        // Mail clients copy the code as shown, often with a space in it.
        pasteTransformer={(pasted) => pasted.replace(/\D/g, "")}
        autoComplete="one-time-code"
        inputMode="numeric"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        onKeyDown={(event) => {
          if (event.key === "Enter") onEnter?.();
        }}
        // A refused code is retyped whole: select it all, after input-otp
        // has put the caret on the last box.
        onFocus={(event) => {
          if (!invalid || value.length < CODE_LENGTH) return;
          const input = event.currentTarget;
          requestAnimationFrame(() => input.setSelectionRange(0, CODE_LENGTH));
        }}
      >
        <InputOTPGroup>
          {Array.from({ length: CODE_LENGTH }, (_, index) => (
            <InputOTPSlot key={index} index={index} aria-invalid={invalid || undefined} />
          ))}
        </InputOTPGroup>
      </InputOTP>
      <FieldError id={errorId}>{error}</FieldError>
    </Field>
  );
}
