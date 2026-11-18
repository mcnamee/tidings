import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { reauthenticateWithPasskey } from '../auth/passkeyFlows';
import { publishSignedIn } from '../lib/session';

/**
 * Spec 8.3, ADR 0016: adding or removing a passkey and making new recovery codes need a recent
 * passkey sign-in, and an email-link session cannot do them at all. When the server says
 * `reauth_required`, Settings runs a passkey sign-in (the device prompt), publishes the fresh
 * session, and the caller retries. Returns a sentence to show when that did not work, else null.
 */
export function useReauth(): () => Promise<string | null> {
  const client = useQueryClient();
  return useCallback(async () => {
    const result = await reauthenticateWithPasskey();
    if (!result.ok) return result.message;
    publishSignedIn(client, result.value.user);
    return null;
  }, [client]);
}
