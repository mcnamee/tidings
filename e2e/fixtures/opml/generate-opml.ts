// Generates e2e/fixtures/opml/inoreader-export.opml deterministically.
// Run: node e2e/fixtures/opml/generate-opml.ts
// A unit test (e2e/test/opml-fixture.test.ts) fails if the committed file drifts from this output.
//
// Shape (mirrors an Inoreader export):
//  - 18 top-level folders (outline without xmlUrl), one of which ("Tech") has a nested folder
//  - ~250 feed outlines (type="rss", xmlUrl, htmlUrl, title/text)
//  - one feed that appears in two folders (https://shared.example.test/feed.xml)
//  - a few feeds at the root, outside any folder
//  - a few invalid entries (no xmlUrl, bad scheme) for the import preview's "invalid" count

const FOLDERS = [
  'Tech',
  'News',
  'Science',
  'Design',
  'Programming',
  'Culture',
  'Finance',
  'Health',
  'Sport',
  'Travel',
  'Food',
  'Music',
  'Film &amp; TV',
  'Gaming',
  'Photography',
  'Podcasts',
  'Comics',
  'Local',
];

const NESTED = { parent: 'Tech', name: 'Tech / Open Source', feeds: 8 };
const SHARED = {
  title: 'Shared Feed (in two folders)',
  xmlUrl: 'https://shared.example.test/feed.xml',
  htmlUrl: 'https://shared.example.test/',
  folders: ['Science', 'Culture'],
};

function esc(s: string): string {
  return s.replace(/&(?!amp;)/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function feed(title: string, host: string, indent: string): string {
  const t = esc(title);
  return `${indent}<outline type="rss" text="${t}" title="${t}" xmlUrl="https://${host}/feed.xml" htmlUrl="https://${host}/"/>`;
}

export function generateOpml(): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<opml version="1.0">');
  lines.push('  <head><title>Subscriptions from Inoreader</title></head>');
  lines.push('  <body>');

  const FEEDS_PER_FOLDER = 13; // 18 * 13 = 234, + nested 8 + shared 1 + root 5 = 248 unique feeds

  FOLDERS.forEach((folder, fi) => {
    const f = folder;
    lines.push(`    <outline text="${f}" title="${f}">`);
    for (let n = 0; n < FEEDS_PER_FOLDER; n++) {
      lines.push(feed(`${folder.replace('&amp;', '&')} Feed ${n + 1}`, `f${fi}-${n}.example.test`, '      '));
    }
    if (folder === NESTED.parent) {
      lines.push(`      <outline text="Open Source" title="Open Source">`);
      for (let n = 0; n < NESTED.feeds; n++) {
        lines.push(feed(`Open Source Feed ${n + 1}`, `oss-${n}.example.test`, '        '));
      }
      lines.push('      </outline>');
    }
    if (SHARED.folders.includes(folder)) {
      lines.push(feed(SHARED.title, 'shared.example.test', '      '));
    }
    lines.push('    </outline>');
  });

  // Root-level feeds (Inoreader exports unfiled feeds here).
  for (let n = 0; n < 5; n++) {
    lines.push(feed(`Unfiled Feed ${n + 1}`, `root-${n}.example.test`, '    '));
  }

  // Invalid entries.
  lines.push('    <outline type="rss" text="Missing URL" title="Missing URL"/>');
  lines.push(
    '    <outline type="rss" text="Bad scheme" title="Bad scheme" xmlUrl="javascript:alert(1)"/>',
  );
  lines.push(
    '    <outline type="rss" text="Private host" title="Private host" xmlUrl="http://127.0.0.1/feed.xml"/>',
  );

  lines.push('  </body>');
  lines.push('</opml>');
  lines.push('');
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { writeFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const out = fileURLToPath(new URL('./inoreader-export.opml', import.meta.url));
  writeFileSync(out, generateOpml());
  console.log(`wrote ${out}`);
}
