import { env } from 'cloudflare:workers';
import { createExecutionContext } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import worker from './index';

describe('worker entry', () => {
  it('scheduled() runs the dispatcher (nothing due) and logs one summary', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.scheduled(
      { cron: '* * * * *', scheduledTime: 0 } as ScheduledController,
      env,
      createExecutionContext(),
    );
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain('"leased":0');
    log.mockRestore();
  });
});
