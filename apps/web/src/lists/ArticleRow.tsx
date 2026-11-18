import { useState } from 'react';
import { Link } from 'react-router';
import type { EntrySummary } from '@tidings/shared';
import { relativeTime, relativeTimeLong } from '../lib/time';
import { rowLayout } from './rowLayout';

/**
 * The list's columns from `lg` (TID-062): the rows become magazine cards. Two columns beside the
 * sidebar (the column is ~736px at 1024), three from `xl` (1280px, ~990px of column) and three at
 * `lg` once the sidebar is hidden (the column is the full ~1024px). Below `lg` it stays one column.
 */
export const LIST_GRID =
  'lg:grid lg:grid-cols-2 lg:gap-4 xl:grid-cols-3 group-data-[sidebar=hidden]/shell:lg:grid-cols-3';

/**
 * One article in a list (FR-RD-5), in one of three layouts (TID-060): thumbnail on the left with
 * the text beside it (to flip it, add `flex-row-reverse` to the link), text-only, or a hero image
 * on top. The summary is not shown: the reference look has none. All feed text is rendered as
 * text: React escapes it, and nothing here ever sets HTML (spec 10.5).
 */
export function ArticleRow({
  entry,
  to,
  now,
  prev,
}: {
  entry: EntrySummary;
  to: string;
  now: number;
  prev?: EntrySummary;
}) {
  const [broken, setBroken] = useState(false);
  const title = entry.title?.trim() || 'Untitled article';
  const layout = broken ? 'text' : rowLayout(entry, prev);
  const hero = layout === 'hero';
  const img = (cls: string) => (
    <img
      src={entry.imageUrl ?? undefined}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      className={`bg-sunken object-cover ${cls}`}
    />
  );
  return (
    <li
      data-entry-id={entry.id}
      data-layout={layout}
      className="border-b border-line lg:border-b-0"
    >
      <Link
        to={to}
        className={`-mx-4 min-h-11 px-4 py-4 hover:bg-sunken active:bg-sunken lg:mx-0 lg:h-full lg:rounded-xl lg:p-3 ${
          hero ? 'block lg:flex lg:flex-col' : 'flex items-start gap-3 lg:flex-col lg:gap-0'
        }`}
      >
        {hero && img('aspect-video max-h-80 w-full rounded-lg lg:max-h-none')}
        {layout === 'thumb' &&
          img('size-24 shrink-0 rounded-lg lg:aspect-video lg:size-auto lg:w-full')}
        <div className="min-w-0 flex-1">
          <h2
            className={`line-clamp-4 break-words leading-snug ${hero ? 'mt-3 text-xl lg:text-lg' : 'text-lg'} ${
              layout === 'text' ? '' : 'lg:mt-3'
            } ${entry.isRead ? 'font-normal text-fg-muted' : 'font-semibold text-fg'}`}
          >
            {title}
          </h2>
          <p className="mt-1.5 flex items-center gap-1.5 text-[0.9375rem] text-fg-muted">
            {!entry.isRead && (
              <>
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />
                <span className="sr-only">Unread.</span>
              </>
            )}
            <span className="min-w-0 truncate font-medium text-accent">{entry.feedTitle}</span>
            <span aria-hidden="true">&middot;</span>
            <time dateTime={entry.publishedAt} className="shrink-0">
              <span aria-hidden="true">{relativeTime(entry.publishedAt, now)}</span>
              <span className="sr-only">{relativeTimeLong(entry.publishedAt, now)}</span>
            </time>
          </p>
        </div>
      </Link>
    </li>
  );
}
