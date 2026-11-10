/**
 * The Terminal surface's empty state: a small terminal window with one
 * command run and a prompt waiting. Drawn in currentColor so it follows the
 * muted text color in either theme; the cursor takes the accent and blinks
 * unless reduced motion is on.
 */
export function TerminalIllustration() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 120 84"
      width="120"
      height="84"
      fill="none"
      aria-hidden="true"
      className="text-muted-foreground"
    >
      <rect x="4.75" y="4.75" width="110.5" height="74.5" rx="10" fill="var(--background)" />
      <rect x="4.75" y="4.75" width="110.5" height="74.5" rx="10" stroke="currentColor" strokeOpacity="0.45" strokeWidth="1.5" />
      <path d="M5.5 21.25h109" stroke="currentColor" strokeOpacity="0.25" strokeWidth="1.5" />
      <g fill="currentColor" fillOpacity="0.4">
        <circle cx="15.5" cy="13" r="2.5" />
        <circle cx="23.5" cy="13" r="2.5" />
        <circle cx="31.5" cy="13" r="2.5" />
      </g>
      <g stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 30.5l4.5 3.5-4.5 3.5" />
        <path d="M16 59.5l4.5 3.5-4.5 3.5" />
      </g>
      <rect x="26" y="31.5" width="34" height="5" rx="2.5" fill="currentColor" fillOpacity="0.45" />
      <g fill="currentColor" fillOpacity="0.2">
        <rect x="16" y="43" width="62" height="4" rx="2" />
        <rect x="16" y="50" width="44" height="4" rx="2" />
      </g>
      <rect x="26" y="57.5" width="6" height="11" rx="1" fill="var(--primary)" className="pinomad-terminal-cursor" />
    </svg>
  );
}
