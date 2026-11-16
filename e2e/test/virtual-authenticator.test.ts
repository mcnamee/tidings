import { describe, expect, it } from 'vitest';
import { addVirtualAuthenticator, type CdpSessionLike } from '../support/virtual-authenticator.ts';

function fakePage() {
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let detached = false;
  const session: CdpSessionLike = {
    async send(method, params) {
      sent.push({ method, params });
      if (method === 'WebAuthn.addVirtualAuthenticator') return { authenticatorId: 'auth-1' };
      if (method === 'WebAuthn.getCredentials') {
        return {
          credentials: [
            { credentialId: 'abc', isResidentCredential: true, rpId: 'localhost', signCount: 0 },
          ],
        };
      }
      return {};
    },
    async detach() {
      detached = true;
    },
  };
  const page = { context: () => ({ newCDPSession: async () => session }) };
  return { page, sent, isDetached: () => detached };
}

// TID-005 AC3 (unit-test part): the registration/assertion flow itself is covered against real
// Chromium by e2e/specs/webauthn-helper.spec.ts; the full app flow is verified once TID-007 lands.
describe('virtual authenticator helper (TID-005 AC3)', () => {
  it('AC3: enables WebAuthn and adds a ctap2 internal authenticator with resident keys and UV', async () => {
    const { page, sent } = fakePage();
    const auth = await addVirtualAuthenticator(page);
    expect(auth.authenticatorId).toBe('auth-1');
    expect(sent[0]?.method).toBe('WebAuthn.enable');
    expect(sent[1]).toEqual({
      method: 'WebAuthn.addVirtualAuthenticator',
      params: {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      },
    });
  });

  it('AC3: options can be overridden', async () => {
    const { page, sent } = fakePage();
    await addVirtualAuthenticator(page, {
      transport: 'usb',
      isUserVerified: false,
      hasResidentKey: false,
    });
    const opts = (sent[1]?.params as { options: Record<string, unknown> }).options;
    expect(opts).toMatchObject({ transport: 'usb', isUserVerified: false, hasResidentKey: false });
  });

  it('AC3: lists credentials, toggles verification, clears and removes', async () => {
    const { page, sent, isDetached } = fakePage();
    const auth = await addVirtualAuthenticator(page);
    expect(await auth.credentials()).toHaveLength(1);
    await auth.setUserVerified(false);
    await auth.setAutomaticPresenceSimulation(false);
    await auth.clearCredentials();
    await auth.remove();
    const methods = sent.map((s) => s.method);
    expect(methods).toEqual([
      'WebAuthn.enable',
      'WebAuthn.addVirtualAuthenticator',
      'WebAuthn.getCredentials',
      'WebAuthn.setUserVerified',
      'WebAuthn.setAutomaticPresenceSimulation',
      'WebAuthn.clearCredentials',
      'WebAuthn.removeVirtualAuthenticator',
      'WebAuthn.disable',
    ]);
    expect(sent[3]?.params).toEqual({ authenticatorId: 'auth-1', isUserVerified: false });
    expect(isDetached()).toBe(true);
  });
});
