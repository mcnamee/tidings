import { useQuery } from '@tanstack/react-query';
import { Route, Routes } from 'react-router';
import { fetchHealth } from './api';

function Home() {
  const health = useQuery({ queryKey: ['health'], queryFn: () => fetchHealth() });
  return (
    <main className="min-h-screen bg-white p-4 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <h1 className="text-2xl font-semibold">Tidings</h1>
      <p data-testid="api-status" className="mt-2">
        {health.isPending && 'Checking API...'}
        {health.isError && 'API unreachable'}
        {health.data && `API ok (v${health.data.version})`}
      </p>
    </main>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="*" element={<Home />} />
    </Routes>
  );
}
