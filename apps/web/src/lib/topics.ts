import { useQuery } from '@tanstack/react-query';
import {
  isTopicSlug,
  TOPICS,
  type EntryListView,
  type SessionResponse,
  type Topic,
  type TopicsResponse,
} from '@tidings/shared';
import { apiGet } from '../api';
import { useSession } from './session';

type Settings = NonNullable<SessionResponse['user']>['settings'];

export const TOPICS_KEY = ['topics'] as const;
const DAY = 24 * 60 * 60 * 1000;

/**
 * `GET /api/topics` (TID-077): the active system topics. The list changes only with a release, so it is
 * fresh for 24 hours (spec 11.3) and kept that long in memory. With no answer and nothing cached the
 * data is undefined, and the chip row is not shown.
 */
export function useTopics() {
  return useQuery({
    queryKey: TOPICS_KEY,
    queryFn: async ({ signal }) => (await apiGet<TopicsResponse>('/api/topics', { signal })).items,
    staleTime: DAY,
    gcTime: 2 * DAY,
    retry: 1,
  });
}

/** Spec 6.2: `topicChips`, default none. Anything that is not a known topic slug is dropped. */
export function topicChipsPref(settings: Settings | undefined): string[] {
  const chips = settings?.topicChips;
  if (!Array.isArray(chips)) return [];
  return [...new Set(chips.filter(isTopicSlug))];
}

/**
 * The topic a list is filtered to, from `?topic=`: only on All articles, and only one of the chosen chips
 * (so a retired or unknown ID, or one the person has since taken off, is "All").
 */
export function topicFromParams(
  params: URLSearchParams,
  view: EntryListView,
  chips: readonly string[],
): string | null {
  const raw = params.get('topic');
  return view === 'all' && raw !== null && chips.includes(raw) ? raw : null;
}

const NAME_OF = new Map(TOPICS.map((t) => [t.slug, t.name]));

/** The display name for a slug: the API's, else the built-in list's. */
export function topicName(slug: string, loaded: readonly Topic[] | undefined): string {
  return loaded?.find((t) => t.id === slug)?.name ?? NAME_OF.get(slug) ?? slug;
}

/** The chosen topic on All articles, for the header and the document title. */
export function useActiveTopic(
  view: EntryListView,
  params: URLSearchParams,
): { slug: string; name: string } | null {
  const session = useSession();
  const topics = useTopics();
  const slug = topicFromParams(params, view, topicChipsPref(session.data?.user?.settings));
  return slug === null ? null : { slug, name: topicName(slug, topics.data) };
}
