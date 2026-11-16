/**
 * Chromium virtual WebAuthn authenticator, driven over CDP (spec §13).
 *
 *   const auth = await addVirtualAuthenticator(page);   // before the page calls navigator.credentials
 *   ... click "Create passkey" ...
 *   expect(await auth.credentials()).toHaveLength(1);
 *   await auth.setUserVerified(false);                   // simulate a failed biometric
 *   await auth.remove();
 *
 * Passkeys only work on a secure context: use http://localhost (not 127.0.0.1 or a LAN IP).
 * Defaults are a platform authenticator with resident keys and user verification, which is what a
 * phone's passkey looks like to the app.
 */

/** The subset of Playwright's CDPSession we use, so the helper can be unit tested with a fake. */
export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach?(): Promise<void>;
}

export interface CdpPageLike {
  context(): { newCDPSession(page: unknown): Promise<CdpSessionLike> };
}

export interface VirtualAuthenticatorOptions {
  protocol?: 'ctap2' | 'u2f';
  transport?: 'internal' | 'usb' | 'nfc' | 'ble';
  hasResidentKey?: boolean;
  hasUserVerification?: boolean;
  /** Whether the simulated user passes user verification (biometric/PIN). Default true. */
  isUserVerified?: boolean;
  /** Auto-confirm user presence without a prompt. Default true. */
  automaticPresenceSimulation?: boolean;
}

export interface VirtualCredential {
  credentialId: string;
  isResidentCredential: boolean;
  rpId?: string;
  userHandle?: string;
  signCount: number;
}

export interface VirtualAuthenticator {
  readonly authenticatorId: string;
  /** All credentials currently stored on the authenticator. */
  credentials(): Promise<VirtualCredential[]>;
  clearCredentials(): Promise<void>;
  /** Make future user-verification checks pass or fail. */
  setUserVerified(verified: boolean): Promise<void>;
  /** Turn automatic presence confirmation on or off. */
  setAutomaticPresenceSimulation(enabled: boolean): Promise<void>;
  remove(): Promise<void>;
}

export async function addVirtualAuthenticator(
  page: CdpPageLike,
  options: VirtualAuthenticatorOptions = {},
): Promise<VirtualAuthenticator> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = (await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: options.protocol ?? 'ctap2',
      transport: options.transport ?? 'internal',
      hasResidentKey: options.hasResidentKey ?? true,
      hasUserVerification: options.hasUserVerification ?? true,
      isUserVerified: options.isUserVerified ?? true,
      automaticPresenceSimulation: options.automaticPresenceSimulation ?? true,
    },
  })) as { authenticatorId: string };

  return {
    authenticatorId,
    async credentials() {
      const { credentials } = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })) as {
        credentials: VirtualCredential[];
      };
      return credentials;
    },
    async clearCredentials() {
      await cdp.send('WebAuthn.clearCredentials', { authenticatorId });
    },
    async setUserVerified(verified) {
      await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: verified });
    },
    async setAutomaticPresenceSimulation(enabled) {
      await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled });
    },
    async remove() {
      await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
      await cdp.send('WebAuthn.disable');
      await cdp.detach?.();
    },
  };
}
