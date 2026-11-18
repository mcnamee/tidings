import { useQuery, type QueryClient } from '@tanstack/react-query';
import type { SessionResponse } from '@tidings/shared';
import { apiGet } from '../api';
import { markSignedIn } from './signedInHint';

export const SESSION_KEY = ['session'] as const;

export const SIGNED_OUT: SessionResponse = {
  user: null,
  setupRequired: false,
  mustAddPasskey: false,
  emailSignIn: false,
};

/** `GET /api/auth/session`: who is signed in, and whether first-run setup is still open. */
export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: async ({ signal }) => {
      const session = await apiGet<SessionResponse>('/api/auth/session', { signal });
      if (session.user) markSignedIn();
      return session;
    },
    retry: false,
    // Fresh data (including what sign-in just published) is not re-fetched on every mount; a
    // session that ends is noticed by the next API call (401), see setUnauthenticatedHandler.
    staleTime: 60_000,
    // The setup screen must not be yanked away when the user returns from a password manager.
    refetchOnWindowFocus: false,
  });
}

/** After a successful sign-in: publish the user and remember this device has had a session. */
export function publishSignedIn(
  client: QueryClient,
  user: NonNullable<SessionResponse['user']>,
  extra: Pick<SessionResponse, 'mustAddPasskey' | 'recoveryCodesRemaining'> = {
    mustAddPasskey: false,
  },
) {
  markSignedIn();
  client.setQueryData<SessionResponse>(SESSION_KEY, {
    user,
    setupRequired: false,
    emailSignIn: false,
    ...extra,
  });
}
