import { addVirtualAuthenticator } from '../support/virtual-authenticator.ts';
import { expect, test } from '../support/test.ts';

// TID-005 AC3: registration and assertion complete in Chromium through the helper. This drives the
// browser's WebAuthn API directly on the app origin (http://localhost, a secure context); the real
// setup/sign-in screens are covered by their own specs once TID-007/TID-008 land.
test('AC3: virtual authenticator completes a passkey registration and assertion', async ({
  page,
}) => {
  await page.goto('/');
  const auth = await addVirtualAuthenticator(page);
  try {
    const registered = await page.evaluate(async () => {
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge,
          rp: { id: 'localhost', name: 'Tidings E2E' },
          user: { id: new Uint8Array([1, 2, 3, 4]), name: 'owner', displayName: 'Owner' },
          pubKeyCredParams: [
            { type: 'public-key', alg: -7 },
            { type: 'public-key', alg: -257 },
          ],
          authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        },
      })) as PublicKeyCredential;
      return Array.from(new Uint8Array(cred.rawId));
    });
    expect(registered.length).toBeGreaterThan(0);
    expect(await auth.credentials()).toHaveLength(1);

    const asserted = await page.evaluate(async (rawId) => {
      const cred = (await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          rpId: 'localhost',
          userVerification: 'required',
          allowCredentials: [{ type: 'public-key', id: new Uint8Array(rawId) }],
        },
      })) as PublicKeyCredential;
      const response = cred.response as AuthenticatorAssertionResponse;
      return { id: Array.from(new Uint8Array(cred.rawId)), sig: response.signature.byteLength };
    }, registered);
    expect(asserted.id).toEqual(registered);
    expect(asserted.sig).toBeGreaterThan(0);

    // A failed biometric must fail the ceremony.
    await auth.setUserVerified(false);
    const failure = await page.evaluate(async (rawId) => {
      try {
        await navigator.credentials.get({
          publicKey: {
            challenge: crypto.getRandomValues(new Uint8Array(32)),
            rpId: 'localhost',
            userVerification: 'required',
            allowCredentials: [{ type: 'public-key', id: new Uint8Array(rawId) }],
          },
        });
        return null;
      } catch (e) {
        return (e as Error).name;
      }
    }, registered);
    expect(failure).toBe('NotAllowedError');
  } finally {
    await auth.remove();
  }
});
