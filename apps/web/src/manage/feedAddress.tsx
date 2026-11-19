import { Link } from 'react-router';
import type { AlreadySubscribedDetails, FeedChoiceDetails } from '@tidings/shared';
import type { BannerContent } from '../auth/ui';

/** Fixed copy about a feed address, shared by Add feed and Change feed address (TID-068). */
export const ADDRESS_COPY = {
  empty: 'Enter an address to continue.',
  invalid: 'Enter a web address, like https://example.com/feed.xml',
  noFeed: "We couldn't find a feed at that address.",
  blocked: 'This address is not allowed.',
  network: "Couldn't reach Tidings. Check your connection and try again.",
  rateLimited: 'Too many requests. Try again in a minute.',
  server: 'Something went wrong on our side. Try again.',
} as const;

export const TYPE_LABEL = { rss: 'RSS', atom: 'Atom', json: 'JSON Feed' } as const;

export function isCandidates(value: unknown): value is FeedChoiceDetails {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as FeedChoiceDetails).candidates)
  );
}

export function existingId(value: unknown): string | null {
  const id = (value as Partial<AlreadySubscribedDetails> | null | undefined)?.subscriptionId;
  return typeof id === 'string' ? id : null;
}

/** "You already follow this feed" with an Open it link when the server named the subscription. */
export function alreadyFollowBanner(id: string | null, onOpen?: () => void): BannerContent {
  return {
    tone: 'info',
    live: 'status',
    icon: 'info',
    text: 'You already follow this feed.',
    content: (
      <>
        You already follow this feed.{' '}
        {id && (
          <Link
            to={`/feeds/${id}`}
            onClick={onOpen}
            className="inline-block -my-3 py-3 text-accent underline underline-offset-2"
          >
            Open it
          </Link>
        )}
      </>
    ),
  };
}
