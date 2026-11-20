import { useState } from 'react';
import { Link } from 'react-router';
import type { EntrySummary } from '@tidings/shared';
import { openState } from '../lib/articleNav';
import { isStandalone } from '../lib/useSwipe';
import { relativeTime, relativeTimeLong } from '../lib/time';
import { isKnownSmall, MIN_FEATURE_WIDTH, rememberSmall, rowLayout } from './rowLayout';

/**
 * The list's columns from `lg` (TID-062): the rows become magazine cards. Two columns beside the
 * sidebar (the column is ~736px at 1024), three from `xl` (1280px, ~990px of column) and three at
 * `lg` once the sidebar is hidden (the column is the full ~1024px). Below `lg` it stays one column.
 */
export const LIST_GRID =
  'lg:grid lg:grid-flow-dense lg:grid-cols-2 lg:gap-5 xl:grid-cols-3 2xl:grid-cols-4 group-data-[sidebar=hidden]/shell:lg:grid-cols-3 group-data-[sidebar=hidden]/shell:xl:grid-cols-4';

/**
 * One article in a list (FR-RD-5), in one of three layouts (TID-060): thumbnail on the left with
 * the text beside it (to flip it, add `flex-row-reverse` to the link), text-only, or a hero image
 * on top. Below `lg` there is no summary. From `lg` every card shows a clamped plain-text summary
 * (when the feed has one) and a hero entry is a featured card: it spans two columns (a full row in
 * the 2-column grid), image on the left half, bigger title and summary on the right. The grid is
 * `grid-flow-dense`, so featured cards leave no holes; the cost is that their visual order can
 * differ slightly from DOM and keyboard order. An image that loads narrower than 300px (TID-072)
 * is never stretched: the row becomes `small`, a thumbnail at natural size in a 96px box, with no
 * featured or 2-column layout. All feed text is rendered as text: React escapes
 * it, and nothing here ever sets HTML (spec 10.5).
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
  const [small, setSmall] = useState(() => isKnownSmall(entry.imageUrl));
  const title = entry.title?.trim() || 'Untitled article';
  const layout = broken ? 'text' : small ? 'small' : rowLayout(entry, prev);
  const hero = layout === 'hero';
  const summary = entry.summary?.replace(/\s+/g, ' ').trim() ?? '';
  const img = (cls: string) => (
    <img
      src={entry.imageUrl ?? undefined}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setBroken(true)}
      onLoad={(e) => {
        const w = e.currentTarget.naturalWidth;
        if (w > 0 && w < MIN_FEATURE_WIDTH && entry.imageUrl) {
          rememberSmall(entry.imageUrl);
          setSmall(true);
        }
      }}
      className={`bg-sunken ${cls}`}
    />
  );
  return (
    <li
      data-entry-id={entry.id}
      data-layout={layout}
      className={`border-b border-line lg:border-b-0 ${hero ? 'lg:col-span-2' : ''}`}
    >
      <Link
        to={to}
        replace={isStandalone()}
        state={openState()}
        className={`-mx-4 min-h-11 px-4 py-4 hover:bg-sunken active:bg-sunken lg:mx-0 lg:h-full lg:rounded-xl lg:border lg:border-line lg:bg-surface lg:p-3 lg:shadow-sm lg:hover:border-line-strong lg:hover:bg-sunken ${
          hero
            ? 'block lg:flex lg:items-start lg:gap-5'
            : layout === 'small'
              ? 'flex items-start gap-3'
              : 'flex items-start gap-3 lg:flex-col lg:gap-0'
        }`}
      >
        {hero &&
          img(
            'aspect-video max-h-80 w-full object-cover rounded-lg lg:max-h-none lg:w-1/2 lg:shrink-0',
          )}
        {layout === 'thumb' &&
          img('size-24 shrink-0 rounded-lg object-cover lg:aspect-video lg:size-auto lg:w-full')}
        {layout === 'small' && (
          // Natural size, capped to the same 96px box a thumbnail uses: a small image is never
          // upscaled, and the text beside it does not move when the image loads.
          <span className="flex size-24 shrink-0 items-start justify-center rounded-lg bg-sunken">
            {img('h-auto max-h-24 w-auto max-w-24 rounded-lg object-contain')}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h2
            className={`line-clamp-4 break-words leading-snug ${hero ? 'mt-3 text-xl lg:mt-0 lg:text-2xl' : 'text-lg'} ${
              layout === 'text' || layout === 'small' ? '' : 'lg:mt-3'
            } ${entry.isRead ? 'font-normal text-fg-muted' : 'font-semibold text-fg'}`}
          >
            {title}
          </h2>
          {summary && (
            <p
              data-testid="entry-summary"
              className={`mt-2 hidden break-words text-base leading-normal text-fg-muted ${
                hero ? 'lg:line-clamp-4' : 'lg:line-clamp-3'
              }`}
            >
              {summary}
            </p>
          )}
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
