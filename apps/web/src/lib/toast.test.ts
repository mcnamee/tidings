import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createToastStore } from './toast';

describe('toast store', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const make = () => createToastStore();

  it('auto-dismisses after the documented durations', () => {
    const s = make();
    s.show('info', 'a');
    vi.advanceTimersByTime(3999);
    expect(s.getSnapshot()?.message).toBe('a');
    vi.advanceTimersByTime(1);
    expect(s.getSnapshot()).toBeNull();

    s.show('error', 'e');
    vi.advanceTimersByTime(7999);
    expect(s.getSnapshot()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(s.getSnapshot()).toBeNull();
  });

  it('keeps an Undo toast for 5 s and an action toast never shorter than 5 s', () => {
    const s = make();
    s.show('undo', 'u', { action: { label: 'Undo', run: () => {} } });
    vi.advanceTimersByTime(4999);
    expect(s.getSnapshot()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(s.getSnapshot()).toBeNull();

    s.show('info', 'x', { action: { label: 'Go', run: () => {} } });
    expect(s.getSnapshot()?.duration).toBe(5000);
  });

  it('replaces the visible info toast with a new one', () => {
    const s = make();
    s.show('info', 'one');
    s.show('success', 'two');
    expect(s.getSnapshot()?.message).toBe('two');
  });

  it('never replaces an Undo toast with info; queue of 1, newest wins', () => {
    const s = make();
    s.show('undo', 'undo me');
    s.show('info', 'first');
    s.show('info', 'second');
    expect(s.getSnapshot()?.message).toBe('undo me');
    vi.advanceTimersByTime(5000);
    expect(s.getSnapshot()?.message).toBe('second');
  });

  it('errors replace info but queue behind Undo', () => {
    const s = make();
    s.show('info', 'i');
    s.show('error', 'boom');
    expect(s.getSnapshot()?.message).toBe('boom');

    const t = make();
    t.show('undo', 'u');
    t.show('error', 'boom');
    expect(t.getSnapshot()?.message).toBe('u');
    t.dismiss();
    expect(t.getSnapshot()?.message).toBe('boom');
  });

  it('pauses and resumes the timer', () => {
    const s = make();
    s.show('info', 'a');
    vi.advanceTimersByTime(3000);
    s.pause();
    vi.advanceTimersByTime(60_000);
    expect(s.getSnapshot()).not.toBeNull();
    s.resume();
    vi.advanceTimersByTime(999);
    expect(s.getSnapshot()).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(s.getSnapshot()).toBeNull();
  });

  it('keeps a toast with a null duration until dismissed', () => {
    const s = make();
    const id = s.show('info', 'new version', { duration: null });
    vi.advanceTimersByTime(600_000);
    expect(s.getSnapshot()?.id).toBe(id);
    s.dismiss(id);
    expect(s.getSnapshot()).toBeNull();
  });
});
