import { describe, expect, it } from 'vitest';
import { heroByRule, rowLayout } from './rowLayout';

const img = 'https://img.example.com/a.jpg';
const ids = Array.from({ length: 1000 }, (_, i) => `entry-${i}`);

describe('rowLayout', () => {
  it('is text-only without an image', () => {
    for (const id of ids.slice(0, 50)) expect(rowLayout({ id, imageUrl: null })).toBe('text');
  });
  it('is deterministic and about 1 in 5 image entries are hero', () => {
    const run = () => ids.map((id) => rowLayout({ id, imageUrl: img }));
    expect(run()).toEqual(run());
    const heroes = run().filter((l) => l === 'hero').length;
    expect(heroes).toBeGreaterThan(150);
    expect(heroes).toBeLessThan(250);
  });
  it('never makes two hero rows adjacent', () => {
    const items = ids.map((id) => ({ id, imageUrl: img }));
    const layouts = items.map((e, i) => rowLayout(e, items[i - 1]));
    layouts.forEach((l, i) => expect(l === 'hero' && layouts[i - 1] === 'hero').toBe(false));
    const [id, prev] = ids.filter(heroByRule);
    expect(rowLayout({ id: id!, imageUrl: img })).toBe('hero');
    expect(rowLayout({ id: prev!, imageUrl: img }, { id: id!, imageUrl: img })).toBe('thumb');
  });
});
