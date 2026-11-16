// Seeds the local D1 with a deterministic dataset: 1 user, 3 folders, 10 feeds, 500 entries.
// Usage: npm run db:seed:local   (run db:migrate:local first). Local D1 only, never remote.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 1_760_000_000; // fixed epoch seconds so seeds are reproducible
const USER = 'seed-user';
const q = (s) => "'" + String(s).replaceAll("'", "''") + "'";

export function buildSeedSql() {
  const out = [];
  for (const t of ['user_entries', 'entries', 'subscriptions', 'folders', 'feeds', 'users']) {
    out.push('DELETE FROM ' + t + ';');
  }
  out.push(
    'INSERT INTO users (id, display_name, role, created_at) VALUES (' +
      [q(USER), q('Seed User'), q('owner'), BASE].join(', ') +
      ');',
  );
  const folders = ['News', 'Tech', 'Fun'];
  folders.forEach((name, n) => {
    out.push(
      'INSERT INTO folders (id, user_id, name, position, created_at) VALUES (' +
        [q('seed-folder-' + (n + 1)), q(USER), q(name), n, BASE].join(', ') +
        ');',
    );
  });
  for (let f = 1; f <= 10; f++) {
    out.push(
      'INSERT INTO feeds (id, url, title, next_fetch_at, state, created_at) VALUES (' +
        [
          f,
          q('https://feed' + f + '.example.com/rss'),
          q('Feed ' + f),
          BASE + 1800,
          q('ok'),
          BASE,
        ].join(', ') +
        ');',
    );
    // Feeds 1-3 News, 4-6 Tech, 7-8 Fun, 9-10 no folder.
    const folderNo = f <= 3 ? 1 : f <= 6 ? 2 : f <= 8 ? 3 : 0;
    const folder = folderNo ? q('seed-folder-' + folderNo) : 'NULL';
    out.push(
      'INSERT INTO subscriptions (id, user_id, feed_id, folder_id, created_at) VALUES (' +
        [q('seed-sub-' + f), q(USER), f, folder, BASE].join(', ') +
        ');',
    );
  }
  for (let i = 1; i <= 500; i++) {
    const feed = ((i - 1) % 10) + 1;
    // Newest first by id; every 5th pair shares a timestamp to exercise the id tiebreak.
    const published = BASE - Math.floor((500 - i) / 2) * 600;
    const isRead = i % 4 === 0 ? 1 : 0;
    out.push(
      'INSERT INTO entries (id, feed_id, guid_hash, url, title, author, summary, image_url, published_at, fetched_at) VALUES (' +
        [
          i,
          feed,
          q('guid-' + i),
          q('https://feed' + feed + '.example.com/post/' + i),
          q('Entry ' + i),
          q('Author ' + feed),
          q('Summary of entry ' + i),
          'NULL',
          published,
          published,
        ].join(', ') +
        ');',
    );
    out.push(
      'INSERT INTO user_entries (user_id, entry_id, feed_id, published_at, is_read, read_at) VALUES (' +
        [q(USER), i, feed, published, isRead, isRead ? published : 'NULL'].join(', ') +
        ');',
    );
  }
  return out.join('\n') + '\n';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = join(root, '.wrangler');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'seed.sql');
  writeFileSync(file, buildSeedSql());
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'tidings', '--local', '--file', file], {
    cwd: root,
    stdio: 'inherit',
  });
}
