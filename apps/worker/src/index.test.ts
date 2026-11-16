import { describe, expect, it, vi } from 'vitest';
import worker from './index';

describe('worker entry', () => {
  it('scheduled() logs and does not throw', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    worker.scheduled({ cron: '* * * * *', scheduledTime: 0 } as ScheduledController);
    expect(log).toHaveBeenCalledOnce();
    log.mockRestore();
  });
});
