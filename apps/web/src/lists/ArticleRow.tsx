import { Link } from 'react-router';
import type { EntrySummary } from '@tidings/shared';
import { relativeTime, relativeTimeLong } from '../lib/time';

/**
 * One article in a list (FR-RD-5): feed title, relative time, title (3 lines), summary (2 lines),
 * thumbnail when there is one, and a read/unread state. All feed text is rendered as text: React
 * escapes it, and nothing here ever sets HTML (spec 10.5).
 */
export function ArticleRow({ entry, to, now }: { entry: EntrySummary; to: string; now: number }) {
  const title = entry.title?.trim() || 'Untitled article';
  return (
    <li data-entry-id={entry.id} className="border-b border-line">
      <Link to={to} className="flex min-h-11 items-start gap-3 py-3 active:bg-sunken">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm text-fg-muted">
            {!entry.isRead && (
              <>
                <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-accent" />
                <span className="sr-only">Unread.</span>
              </>
            )}
            <span className="min-w-0 truncate">{entry.feedTitle}</span>
            <span aria-hidden="true">&middot;</span>
            <time dateTime={entry.publishedAt} className="shrink-0">
              <span aria-hidden="true">{relativeTime(entry.publishedAt, now)}</span>
              <span className="sr-only">{relativeTimeLong(entry.publishedAt, now)}</span>
            </time>
          </p>
          <h2
            className={`mt-1 line-clamp-3 break-words text-base ${
              entry.isRead ? 'font-normal text-fg-muted' : 'font-semibold text-fg'
            }`}
          >
            {title}
          </h2>
          {entry.summary && (
            <p className="mt-1 line-clamp-2 break-words text-sm text-fg-muted">{entry.summary}</p>
          )}
        </div>
        {entry.imageUrl && (
          <img
            src={entry.imageUrl}
            alt=""
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            className="size-[80px] shrink-0 rounded-md bg-sunken object-cover"
          />
        )}
      </Link>
    </li>
  );
}
