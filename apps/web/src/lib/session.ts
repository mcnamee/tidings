import { useQuery } from '@tanstack/react-query';
import type { SessionResponse } from '@tidings/shared';
import { apiGet } from '../api';

export const SESSION_KEY = ['session'] as const;

/** `GET /api/auth/session`: who is signed in, and whether first-run setup is still open. */
export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: ({ signal }) => apiGet<SessionResponse>('/api/auth/session', { signal }),
    retry: false,
    // The setup screen must not be yanked away when the user returns from a password manager.
    refetchOnWindowFocus: false,
  });
}
