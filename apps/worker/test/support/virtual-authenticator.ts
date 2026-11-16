/**
 * A software WebAuthn authenticator for Worker tests: builds a real `fmt: none` registration
 * response (ES256) for a given challenge, so the real @simplewebauthn/server verifies it inside
 * workerd. Mirrors the Node client used in the TID-003 spike.
 */
import { toBase64Url, sha256 } from '../../src/auth/crypto';

type Cbor = number | string | Uint8Array | Cbor[] | Map<Cbor, Cbor>;

function head(major: number, n: number): number[] {
  if (n < 24) return [(major << 5) | n];
  if (n < 256) return [(major << 5) | 24, n];
  if (n < 65536) return [(major << 5) | 25, n >> 8, n & 255];
  throw new RangeError('test CBOR encoder: value too large');
}

export function cbor(v: Cbor): Uint8Array {
  if (typeof v === 'number') return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
  if (typeof v === 'string') {
    const b = new TextEncoder().encode(v);
    return Uint8Array.from([...head(3, b.length), ...b]);
  }
  if (v instanceof Uint8Array) return Uint8Array.from([...head(2, v.length), ...v]);
  if (Array.isArray(v))
    return Uint8Array.from([...head(4, v.length), ...v.flatMap((x) => [...cbor(x)])]);
  const out: number[] = head(5, v.size);
  for (const [k, val] of v) out.push(...cbor(k), ...cbor(val));
  return Uint8Array.from(out);
}

function b64urlToBytes(s: string): Uint8Array {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
}

export interface CreationOptionsLike {
  challenge: string;
  rp: { id?: string };
}

export interface FakeRegistrationOptions {
  /** Defaults to the options' rp.id. */
  rpId?: string;
  origin: string;
  /** Clear the user-verified flag to simulate a failed biometric. */
  userVerified?: boolean;
  /** Override the signed challenge (to prove a wrong challenge is refused). */
  challenge?: string;
  /** Set the backup-eligible and backed-up flags (a synced passkey). */
  backedUp?: boolean;
}

export interface FakeRegistration {
  credentialId: string;
  response: {
    id: string;
    rawId: string;
    type: 'public-key';
    response: { clientDataJSON: string; attestationObject: string; transports: string[] };
    clientExtensionResults: Record<string, never>;
    authenticatorAttachment: 'platform';
  };
}

export async function fakeRegistration(
  options: CreationOptionsLike,
  opts: FakeRegistrationOptions,
): Promise<FakeRegistration> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const x = b64urlToBytes(jwk.x as string);
  const y = b64urlToBytes(jwk.y as string);
  const credId = crypto.getRandomValues(new Uint8Array(32));
  const coseKey = cbor(
    new Map<Cbor, Cbor>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, x],
      [-3, y],
    ]),
  );
  const rpIdHash = await sha256(opts.rpId ?? options.rp.id ?? '');
  // flags: UP (1) | UV (4) | AT (64), plus BE (8) and BS (16) for a synced passkey.
  const flags = 0x01 | (opts.userVerified === false ? 0 : 0x04) | 0x40 | (opts.backedUp ? 0x18 : 0);
  const authData = Uint8Array.from([
    ...rpIdHash,
    flags,
    0,
    0,
    0,
    0, // signature counter
    ...new Uint8Array(16), // AAGUID
    credId.length >> 8,
    credId.length & 255,
    ...credId,
    ...coseKey,
  ]);
  const attestationObject = cbor(
    new Map<Cbor, Cbor>([
      ['fmt', 'none'],
      ['attStmt', new Map()],
      ['authData', authData],
    ]),
  );
  const clientData = new TextEncoder().encode(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: opts.challenge ?? options.challenge,
      origin: opts.origin,
      crossOrigin: false,
    }),
  );
  const id = toBase64Url(credId);
  return {
    credentialId: id,
    response: {
      id,
      rawId: id,
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(clientData),
        attestationObject: toBase64Url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    },
  };
}
