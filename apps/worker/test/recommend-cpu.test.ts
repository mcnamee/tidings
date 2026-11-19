import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { Db, sql } from '../src/db';
import { runProfiles } from '../src/recommend/profile';
import { listRecommended } from '../src/recommend/rank';
import { blendScore, buildProfile, scoreKey } from '../src/recommend/score';
import {
  DIMS,
  decodeEmbedding,
  decodeProfile,
  dotEncoded,
  encodeEmbedding,
  encodeProfile,
  normalise,
} from '../src/recommend/vector';
import { seedUser } from './support/seed';

// TID-067 AC7: the CPU of ranking, measured in workerd (ADR 0018 amendment, spec 9.7). Timings use
// `performance.now()` around synchronous work, so they are CPU time in the local runtime; the
// numbers are logged for the record and asserted only against the Free plan's 10 ms with margin.
const U = 'cpu-user';
const BASE = 1_760_000_000;
const db = new Db(env.DB);
const N = 1000;

function vec(seed: number): number[] {
  let x = seed;
  return Array.from({ length: DIMS }, () => {
    x = (x * 1_103_515_245 + 12_345) % 2_147_483_648;
    return x / 2_147_483_648 - 0.5;
  });
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number;
const time = (fn: () => void, runs = 15) => {
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  return { median: median(t), max: Math.max(...t) };
};

let profileText = '';

beforeAll(async () => {
  await seedUser(U);
  await env.DB.exec(
    "INSERT INTO feeds (id, url, title, next_fetch_at, state, created_at) VALUES (1, 'https://f.example.com/rss', 'F', 0, 'ok', 0)",
  );
  await env.DB.exec(
    `INSERT INTO subscriptions (id, user_id, feed_id, created_at) VALUES ('cpu-sub', '${U}', 1, 0)`,
  );
  const statements = [];
  for (let i = 1; i <= N; i++) {
    statements.push(
      sql(
        'INSERT INTO entries (id, feed_id, guid_hash, url, title, summary, published_at, fetched_at) VALUES (?, 1, ?, ?, ?, ?, ?, ?)',
        i,
        `g${i}`,
        `https://f.example.com/${i}`,
        `Title ${i}`,
        'A short plain-text summary of about three hundred characters. '.repeat(4),
        BASE - i * 300,
        BASE,
      ),
      sql(
        'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read) VALUES (?, ?, 1, ?, 0)',
        U,
        i,
        BASE - i * 300,
      ),
      sql('INSERT INTO entry_embeddings (entry_id, vec) VALUES (?, ?)', i, encodeEmbedding(vec(i))),
    );
    if (statements.length >= 90) await db.batch(statements.splice(0));
  }
  await db.batch(statements);
  profileText = encodeProfile(normalise(vec(7)));
});

describe('CPU of ranking and of the profile (spec 9.7)', () => {
  it('scoring 1,000 candidates is well under the 10 ms Free-plan limit, and a text embedding beats a BLOB on the way in', async () => {
    const { rows } = await db.all<{ id: number; p: number; v: string }>(
      sql(
        'SELECT ue.entry_id AS id, ue.published_at AS p, ee.vec AS v FROM user_entries ue JOIN entry_embeddings ee ON ee.entry_id = ue.entry_id WHERE ue.user_id = ? ORDER BY ue.published_at DESC, ue.entry_id DESC',
        U,
      ),
    );
    expect(rows).toHaveLength(N);
    const profile = decodeProfile(profileText) as Float32Array;
    const score = time(() => {
      const out: { id: number; key: number }[] = [];
      for (const r of rows) {
        out.push({ id: r.id, key: scoreKey(blendScore(dotEncoded(profile, r.v), r.p, BASE)) });
      }
      out.sort((a, b) => b.key - a.key || b.id - a.id);
    });

    // What D1 would hand over for the same vectors as a BLOB (a JSON array of 388 integers) vs text.
    const asBlob = JSON.stringify(
      rows.map((r) => ({ id: r.id, p: r.p, v: Array.from(atob(r.v), (c) => c.charCodeAt(0)) })),
    );
    const asText = JSON.stringify(rows);
    const parseBlob = time(() => JSON.parse(asBlob));
    const parseText = time(() => JSON.parse(asText));

    console.log(
      `TID-067 CPU (workerd, 1,000 candidates, median/max ms of 15): score+sort ${score.median.toFixed(2)}/${score.max.toFixed(2)}; ` +
        `JSON.parse as text ${parseText.median.toFixed(2)}/${parseText.max.toFixed(2)} (${asText.length} bytes) vs as BLOB ints ` +
        `${parseBlob.median.toFixed(2)}/${parseBlob.max.toFixed(2)} (${asBlob.length} bytes)`,
    );
    expect(score.median).toBeLessThan(5);
    expect(parseText.median + score.median).toBeLessThan(8);
  });

  it.each([
    ['default cap (500)', {}, 500],
    ['1,000 candidates', { candidateLimit: 1000 }, 1000],
  ])(
    'the whole listRecommended call (query, scoring, page lookup), %s',
    async (name, extra, cap) => {
      const run = () =>
        listRecommended(db, U, {
          view: 'all',
          limit: 50,
          cursor: null,
          profile: profileText,
          now: BASE,
          ...extra,
        });
      await run(); // warm
      const t: number[] = [];
      let rowsRead = 0;
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        const page = await run();
        t.push(performance.now() - t0);
        rowsRead = page.rowsRead;
        expect(page.items).toHaveLength(50);
      }
      console.log(
        `TID-067 listRecommended ${name}: wall (includes the local D1 simulator's I/O) median ${median(t).toFixed(1)} ms, max ${Math.max(...t).toFixed(1)} ms; rows read ${rowsRead}`,
      );
      // cap + 1 candidate rows and as many embedding probes, plus about 4 reads per page row.
      expect(rowsRead).toBeLessThanOrEqual(2 * (cap + 1) + 4 * 50 + 10);
    },
  );

  it('encoding one embed batch (25 model outputs: normalise, quantise, base64)', () => {
    const outputs = Array.from({ length: 25 }, (_, i) => vec(i + 1));
    const enc = time(() => outputs.forEach((o) => encodeEmbedding(o)));
    console.log(
      `TID-067 embed-step CPU (encode 25 vectors): ${enc.median.toFixed(2)} ms (median of 15)`,
    );
    expect(enc.median).toBeLessThan(5);
  });

  it('building a profile from 500 signals', async () => {
    const inputs = Array.from({ length: 500 }, (_, i) => ({
      opened_at: BASE,
      clicked_at: i % 3 === 0 ? BASE : null,
      last_at: BASE - i * 600,
      vec: decodeEmbedding(encodeEmbedding(vec(i + 1))) as Float32Array,
    }));
    const texts = inputs.map((r) => encodeEmbedding(Array.from(r.vec)));
    const decode = time(() => texts.forEach((t) => decodeEmbedding(t)));
    const build = time(() => buildProfile(inputs, BASE));
    console.log(
      `TID-067 profile CPU (500 signals): decode ${decode.median.toFixed(2)} ms + build ${build.median.toFixed(2)} ms (median of 15)`,
    );
    expect(decode.median + build.median).toBeLessThan(8);
    expect(await runProfiles({ db, embedder: null, clock: () => BASE * 1000 })).toMatchObject({
      users: 0,
    });
  });
});
