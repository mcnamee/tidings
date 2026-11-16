/** `guid_hash` dedup key (spec §6.3): base64url(SHA-256(feedId + "\n" + key)).slice(0, 22). */
export async function guidHash(feedId: number, key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${feedId}\n${key}`),
  );
  let bin = '';
  for (const b of new Uint8Array(digest)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 22);
}
