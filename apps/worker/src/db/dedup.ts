/**
 * The cross-feed duplicate test as a SQL condition (spec 6.3, ADR 0017, TID-061). Used wherever
 * entries are linked to a user: the refresh fan-out and a new subscription.
 *
 * A candidate entry `e` is a duplicate for a user when the user already has a `user_entries` row
 * for an entry `d` of another feed that
 * - has the same URL key and was published within the last 7 days, or
 * - has the same headline key and was published within 48 hours of `e` (and within 7 days).
 * One covering-index range probe plus one primary-key probe per condition. A NULL key matches
 * nothing, so keyless entries are never duplicates.
 */
import type { SqlValue } from './client';

export const DEDUP_WINDOW_S = 7 * 86_400;
export const HEADLINE_WINDOW_S = 48 * 3_600;

export interface NotDuplicate {
  /** Two `NOT EXISTS (...)` conditions joined by AND, for use in a WHERE clause. */
  sql: string;
  params: SqlValue[];
}

/**
 * @param candidate alias of the candidate `entries` row in the enclosing query
 * @param user SQL for the user id: a column such as `s.user_id` (no parameter), or `?` with the id
 *   in `userParam`
 */
export function notDuplicateOf(
  candidate: string,
  user: { column: string } | { param: string },
  now: number,
): NotDuplicate {
  const e = candidate;
  const userSql = 'column' in user ? user.column : '?';
  const userParams: SqlValue[] = 'param' in user ? [user.param] : [];
  const since = now - DEDUP_WINDOW_S;
  // CROSS JOIN fixes the order: entries by key first, then one user_entries primary-key probe.
  const probe = (index: string, key: string, extra: string): string =>
    `NOT EXISTS (SELECT 1 FROM entries d INDEXED BY ${index} CROSS JOIN user_entries ue
                  WHERE d.${key} = ${e}.${key} AND d.published_at >= ?${extra}
                    AND d.feed_id != ${e}.feed_id
                    AND ue.user_id = ${userSql} AND ue.entry_id = d.id)`;
  return {
    sql:
      probe('entries_url_key', 'url_key', '') +
      ' AND ' +
      probe(
        'entries_headline_key',
        'headline_key',
        ` AND d.published_at BETWEEN ${e}.published_at - ${HEADLINE_WINDOW_S} AND ${e}.published_at + ${HEADLINE_WINDOW_S}`,
      ),
    // Parameter order follows the text: url (since, user), headline (since, user).
    params: [since, ...userParams, since, ...userParams],
  };
}
