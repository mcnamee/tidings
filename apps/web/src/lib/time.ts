const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Compact relative time for list rows: "now", "5m", "3h", "2d", then a date. Dates are in the
 * viewer's time zone; the year appears only for a different year.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const age = now - then;
  if (age < MINUTE) return 'now'; // includes small clock skew into the future
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m`;
  if (age < DAY) return `${Math.floor(age / HOUR)}h`;
  if (age < 7 * DAY) return `${Math.floor(age / DAY)}d`;
  const d = new Date(then);
  const base = `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''}`;
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** Spoken form for the `<time>` element's accessible name: "5 minutes ago". */
export function relativeTimeLong(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const age = now - then;
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'} ago`;
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return unit(Math.floor(age / MINUTE), 'minute');
  if (age < DAY) return unit(Math.floor(age / HOUR), 'hour');
  if (age < 7 * DAY) return unit(Math.floor(age / DAY), 'day');
  return new Date(then).toDateString();
}
