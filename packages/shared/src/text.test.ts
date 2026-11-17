import { describe, expect, it } from 'vitest';
import {
  folderRequestSchema,
  subscribeRequestSchema,
  updateSubscriptionRequestSchema,
} from './schemas';
import { cleanName, clipCodePoints, tidyText } from './text';

describe('tidyText', () => {
  it('makes a name with nothing visible blank', () => {
    expect(tidyText(' ​‌‍⁠﻿ ')).toBe('');
  });
  it('trims invisible characters at the ends and keeps a joiner inside an emoji', () => {
    expect(tidyText('​ Tech ﻿')).toBe('Tech');
    const family = '\u{1F468}‍\u{1F469}';
    expect(tidyText(family)).toBe(family);
  });
});

describe('clipCodePoints', () => {
  it('never leaves half of a surrogate pair', () => {
    const out = clipCodePoints('a'.repeat(63) + '\u{1F600}\u{1F600}', 64);
    expect(Array.from(out)).toHaveLength(64);
    expect(out.endsWith('\u{1F600}')).toBe(true);
    expect(cleanName('a'.repeat(199) + '\u{1F600}\u{1F600}', 200)).toHaveLength(201);
  });
});

describe('schemas treat invisible-only text as blank', () => {
  it('folder name: rejected', () => {
    expect(folderRequestSchema.safeParse({ name: '​​' }).success).toBe(false);
    expect(folderRequestSchema.parse({ name: '​ Tech' }).name).toBe('Tech');
  });
  it('subscribe and rename title: no title', () => {
    const sub = subscribeRequestSchema.parse({ url: 'https://a.example.com/f', title: '​' });
    expect(sub.title).toBeUndefined();
    expect(updateSubscriptionRequestSchema.parse({ title: '​‌' }).title).toBeNull();
  });
});
