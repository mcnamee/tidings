/**
 * Date parsing for feeds (spec 6.5, ADR 0009 section 5). Independent of the host time zone: a
 * date with no zone, an unknown alphabetic zone, or `IST` (ambiguous) is read as UTC.
 */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** Fixed zone table from ADR 0009, as offsets from UTC in minutes. */
export const ZONE_OFFSET_MINUTES: Readonly<Record<string, number>> = {
  UT: 0,
  UTC: 0,
  GMT: 0,
  Z: 0,
  WET: 0,
  CET: 60,
  CEST: 120,
  WEST: 60,
  BST: 60,
  EET: 120,
  EEST: 180,
  MSK: 180,
  JST: 540,
  KST: 540,
  HKT: 480,
  SGT: 480,
  AWST: 480,
  AEST: 600,
  AEDT: 660,
  ACST: 570,
  ACDT: 630,
  NZST: 720,
  NZDT: 780,
  EST: -300,
  EDT: -240,
  CST: -360,
  CDT: -300,
  MST: -420,
  MDT: -360,
  PST: -480,
  PDT: -420,
};

const ISO_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;
const RFC_RE =
  /^(?:[A-Za-z]{3,9},?\s+)?(\d{1,2})\s+([A-Za-z]{3,9})\.?\s+(\d{2}|\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(GMT\s*[+-]\d{1,2}(?::?\d{2})?|[+-]\d{2}:?\d{2}|[A-Za-z]{1,5})?$/;

function numericOffset(raw: string): number | null {
  const m = /^([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(raw.replace(/\s+/g, ''));
  if (!m) return null;
  const mins = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return m[1] === '-' ? -mins : mins;
}

function zoneOffset(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 0;
  const up = raw.toUpperCase();
  if (up.startsWith('GMT') && up.length > 3) return numericOffset(up.slice(3)) ?? 0;
  if (raw[0] === '+' || raw[0] === '-') return numericOffset(raw) ?? 0;
  return ZONE_OFFSET_MINUTES[up] ?? 0; // IST and anything unknown: UTC
}

function build(
  y: number,
  mo: number,
  d: number,
  h: number,
  mi: number,
  s: number,
  offsetMin: number,
): number | null {
  if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 60) return null;
  const ms = Date.UTC(y, mo, d, h, mi, s);
  if (new Date(ms).getUTCDate() !== d) return null; // 31 Feb and similar
  return ms - offsetMin * 60_000;
}

/** Epoch milliseconds, or null when the text is not a recognisable date. */
export function parseFeedDate(raw: string | undefined): number | null {
  if (!raw) return null;
  const text = raw.trim();
  if (text === '' || text.length > 64) return null;

  const iso = ISO_RE.exec(text);
  if (iso) {
    return build(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4] ?? 0),
      Number(iso[5] ?? 0),
      Number(iso[6] ?? 0),
      zoneOffset(iso[7]),
    );
  }

  const rfc = RFC_RE.exec(text);
  if (rfc) {
    const month = MONTHS[(rfc[2] ?? '').slice(0, 3).toLowerCase()];
    if (month === undefined) return null;
    let year = Number(rfc[3]);
    if ((rfc[3] ?? '').length === 2) year += year < 50 ? 2000 : 1900;
    return build(
      year,
      month,
      Number(rfc[1]),
      Number(rfc[4] ?? 0),
      Number(rfc[5] ?? 0),
      Number(rfc[6] ?? 0),
      zoneOffset(rfc[7]),
    );
  }
  return null;
}
