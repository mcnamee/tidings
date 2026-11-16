/**
 * The only module that reaches `@simplewebauthn/server`, and only through `await import()`
 * (ADR 0002, TID-007 AC9). The library adds about 17 ms of start-up and 710 KiB to whatever
 * evaluates it, so hot API routes must never pull it in. `webauthn-import.test.ts` enforces this.
 */
import type { CreationOptionsJSON, RegistrationResponse } from '@tidings/shared';

type Lib = typeof import('@simplewebauthn/server');

/** Passkey parameters from spec 10.1: discoverable, user verification required, no attestation. */
const SUPPORTED_ALGORITHMS = [-7, -8, -257]; // ES256, EdDSA, RS256

export interface RelyingParty {
  rpID: string;
  rpName: string;
  origin: string;
}

export interface RegistrationOptionsInput extends RelyingParty {
  /** Becomes the WebAuthn user handle, so it must be the ID the user row will get. */
  userId: string;
  userName: string;
  displayName: string;
}

export interface VerifiedPasskey {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
}

/** The seam the handlers use. Tests can inject a fake; production uses `loadWebauthn`. */
export interface WebauthnApi {
  registrationOptions(input: RegistrationOptionsInput): Promise<CreationOptionsJSON>;
  /** Returns null when the response does not verify (any reason: signature, origin, challenge). */
  verifyRegistration(
    rp: RelyingParty,
    response: RegistrationResponse,
    expectedChallenge: string,
  ): Promise<VerifiedPasskey | null>;
}

let libPromise: Promise<Lib> | undefined;

/** Evaluated at most once per isolate, and only when an auth route needs it. */
function lib(): Promise<Lib> {
  libPromise ??= import('@simplewebauthn/server');
  return libPromise;
}

export const defaultWebauthn: WebauthnApi = {
  async registrationOptions(input) {
    const { generateRegistrationOptions } = await lib();
    const options = await generateRegistrationOptions({
      rpName: input.rpName,
      rpID: input.rpID,
      userName: input.userName,
      userDisplayName: input.displayName,
      userID: new Uint8Array(new TextEncoder().encode(input.userId)),
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
      supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    });
    return options as unknown as CreationOptionsJSON;
  },

  async verifyRegistration(rp, response, expectedChallenge) {
    const { verifyRegistrationResponse } = await lib();
    let result;
    try {
      result = await verifyRegistrationResponse({
        // The route has already checked the envelope shape; the library validates the rest.
        response: response as unknown as Parameters<
          typeof verifyRegistrationResponse
        >[0]['response'],
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
        supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
      });
    } catch {
      return null;
    }
    if (!result.verified) return null;
    const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
    return {
      credentialId: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ? [...credential.transports] : null,
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    };
  },
};
