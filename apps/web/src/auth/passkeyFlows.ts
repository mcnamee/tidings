import type {
  CreationOptionsJSON,
  LoginVerifyResponse,
  Passkey,
  RequestOptionsJSON,
} from '@tidings/shared';
import { ApiRequestError, NetworkError, apiPost } from '../api';
import { passkeyLabel } from './helpers';

/**
 * The two passkey ceremonies that happen outside the sign-in screen: adding a passkey to the
 * signed-in account (the recovery banner, Settings) and signing in again with one to prove it is
 * still you (Settings, before new recovery codes). Each answers with data or a sentence for the
 * screen to show; none throws.
 */
export type FlowResult<T> =
  { ok: true; value: T } | { ok: false; message: string; reauth?: boolean };

const SERVER = 'Something went wrong on our side. Try again.';
const REAUTH = 'Sign in with a passkey to do this.';

function ceremonyMessage(err: unknown, cancelled: string): string {
  const name = err instanceof Error ? err.name : '';
  if (name === 'NotAllowedError' || name === 'AbortError') return cancelled;
  if (name === 'InvalidStateError') {
    return 'This device already has a passkey for Tidings. Sign in with it next time.';
  }
  if (name === 'NotSupportedError') {
    return "This device can't use passkeys. Turn on a screen lock, or connect a security key, then try again.";
  }
  return SERVER;
}

function apiMessage(err: unknown): { message: string; reauth?: boolean } {
  if (err instanceof ApiRequestError) {
    if (err.status === 429) return { message: 'Too many attempts. Try again in a few minutes.' };
    if (err.code === 'reauth_required') return { message: REAUTH, reauth: true };
    if (err.code === 'webauthn_failed') {
      return { message: "We couldn't verify that passkey. Try again." };
    }
    return { message: SERVER };
  }
  if (err instanceof NetworkError) {
    return { message: "Couldn't reach Tidings. Check your connection and try again." };
  }
  return { message: SERVER };
}

/** Options, device prompt, verify. */
export async function addPasskey(): Promise<FlowResult<Passkey>> {
  try {
    const options = await apiPost<CreationOptionsJSON>('/api/auth/passkeys/options', {});
    let credential;
    try {
      const { startRegistration } = await import('@simplewebauthn/browser');
      credential = await startRegistration({
        optionsJSON: options as unknown as Parameters<typeof startRegistration>[0]['optionsJSON'],
      });
    } catch (err) {
      return {
        ok: false,
        message: ceremonyMessage(err, 'Passkey setup was cancelled. Try again.'),
      };
    }
    const value = await apiPost<Passkey>('/api/auth/passkeys/verify', {
      response: credential,
      name: passkeyLabel(navigator.userAgent),
    });
    return { ok: true, value };
  } catch (err) {
    return { ok: false, ...apiMessage(err) };
  }
}

/** A fresh passkey sign-in. The server replaces the session cookie, so `authenticated_at` is now. */
export async function reauthenticateWithPasskey(): Promise<FlowResult<LoginVerifyResponse>> {
  try {
    const options = await apiPost<RequestOptionsJSON>('/api/auth/login/options', {});
    let credential;
    try {
      const { startAuthentication } = await import('@simplewebauthn/browser');
      credential = await startAuthentication({
        optionsJSON: options as unknown as Parameters<typeof startAuthentication>[0]['optionsJSON'],
      });
    } catch (err) {
      return { ok: false, message: ceremonyMessage(err, 'Sign-in was cancelled. Try again.') };
    }
    const value = await apiPost<LoginVerifyResponse>('/api/auth/login/verify', {
      response: credential,
    });
    return { ok: true, value };
  } catch (err) {
    return { ok: false, ...apiMessage(err) };
  }
}
