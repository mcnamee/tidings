/**
 * The only module that reaches `@simplewebauthn/server`, and only through `await import()`
 * (ADR 0002, TID-007 AC9). The library adds about 17 ms of start-up and 710 KiB to whatever
 * evaluates it, so hot API routes must never pull it in. `webauthn-import.test.ts` enforces this.
 */
import type {
  AuthenticationResponse,
  CreationOptionsJSON,
  RegistrationResponse,
  RequestOptionsJSON,
} from '@tidings/shared';

type Lib = typeof import('@simplewebauthn/server');

type Transports = NonNullable<
  Parameters<Lib['verifyAuthenticationResponse']>[0]['credential']['transports']
>;

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

export interface StoredCredential {
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[] | null;
}

export interface VerifiedAssertion {
  newCounter: number;
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
  /** Discoverable credentials: no allowCredentials, user verification required. */
  authenticationOptions(rp: RelyingParty): Promise<RequestOptionsJSON>;
  /**
   * Returns null when the assertion does not verify (signature, origin, RP ID, challenge, user
   * verification, or a signature counter that did not move forward when it should have).
   */
  verifyAuthentication(
    rp: RelyingParty,
    response: AuthenticationResponse,
    expectedChallenge: string,
    credential: StoredCredential,
  ): Promise<VerifiedAssertion | null>;
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

  async authenticationOptions(rp) {
    const { generateAuthenticationOptions } = await lib();
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      allowCredentials: [],
      userVerification: 'required',
    });
    return options as unknown as RequestOptionsJSON;
  },

  async verifyAuthentication(rp, response, expectedChallenge, credential) {
    const { verifyAuthenticationResponse } = await lib();
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response: response as unknown as Parameters<
          typeof verifyAuthenticationResponse
        >[0]['response'],
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: credential.publicKey as Uint8Array<ArrayBuffer>,
          counter: credential.counter,
          ...(credential.transports
            ? {
                transports: credential.transports as unknown as Transports,
              }
            : {}),
        },
      });
    } catch {
      return null;
    }
    if (!result.verified) return null;
    return {
      newCounter: result.authenticationInfo.newCounter,
      backedUp: result.authenticationInfo.credentialBackedUp,
    };
  },
};
