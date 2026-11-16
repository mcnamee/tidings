import type { HealthResponse } from '@tidings/shared';

export async function fetchHealth(fetchFn: typeof fetch = fetch): Promise<HealthResponse> {
  const res = await fetchFn('/api/health');
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return (await res.json()) as HealthResponse;
}
