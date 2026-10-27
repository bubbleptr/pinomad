/** One message instant, rendered for the transcript and its hover title. */
export type MessageTime = {
  /** Today: the time only. Else the date, with the year only when it differs. */
  label: string;
  /** The full localized date and time for the hover title. */
  full: string;
  /** ISO 8601 for the `<time>` element. */
  iso: string;
};

const FORMATS = {
  time: { hour: "numeric", minute: "2-digit" },
  date: { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  year: { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
  full: { dateStyle: "full", timeStyle: "long" },
} as const satisfies Record<string, Intl.DateTimeFormatOptions>;

type Format = keyof typeof FORMATS;

// Intl constructors are not cheap and the transcript renders every row on
// each live update, so keep one formatter per locale and shape.
const formatters = new Map<string, Intl.DateTimeFormat>();

function format(date: Date, locale: string | undefined, shape: Format): string {
  const key = `${locale ?? ""}\0${shape}`;
  let formatter = formatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, FORMATS[shape]);
    formatters.set(key, formatter);
  }
  return formatter.format(date);
}

/**
 * Formats a message's epoch stamp in the viewer's locale. "Today" is the
 * calendar day, not a rolling 24 hours: a message from 23:59 yesterday keeps
 * its date after midnight.
 */
export function messageTime(timestamp: number, now = Date.now(), locale?: string): MessageTime | undefined {
  if (!Number.isFinite(timestamp)) return undefined;
  const date = new Date(timestamp);
  const today = new Date(now);
  if (Number.isNaN(date.getTime()) || Number.isNaN(today.getTime())) return undefined;

  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const sameYear = date.getFullYear() === today.getFullYear();
  const shape: Format = sameDay ? "time" : sameYear ? "date" : "year";

  return {
    label: format(date, locale, shape),
    full: format(date, locale, "full"),
    iso: date.toISOString(),
  };
}
