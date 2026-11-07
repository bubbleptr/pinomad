/**
 * Attributes for a mailed 6-digit code's field: the number pad on phones and
 * the OS's one-time-code autofill. Astryx's TextInput forwards the rest of its
 * props to the <input> but doesn't type these, so they go in as a spread.
 */
export const CODE_INPUT = { autoComplete: "one-time-code", inputMode: "numeric", maxLength: 12 } as const;

/** A new password's field: the password manager offers to generate one. */
export const NEW_PASSWORD_INPUT = { autoComplete: "new-password" } as const;

/** Characters as people count them, as the server's 12-character rule does. */
export const passwordLength = (password: string): number => [...password].length;

export const MIN_PASSWORD_LENGTH = 12;
