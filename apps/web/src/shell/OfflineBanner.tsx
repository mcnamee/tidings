import { useLocation } from 'react-router';
import { WifiOff } from 'lucide-react';
import { useOffline } from '../lib/connectivity';

/** Routes with nothing saved to show, only changes to make (Manage, Add feed, Import, Settings). */
const OFFLINE_NO_SAVE = /^\/(manage|settings)(\/|$)/;

/** The "You're offline" strip under a header (the shell's, and the article layer's own). */
export function OfflineBanner() {
  const offline = useOffline();
  const { pathname } = useLocation();
  if (!offline) return null;
  return (
    <div
      role="status"
      className="flex min-h-10 items-center gap-2 bg-warning-subtle py-2 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] text-sm text-warning-subtle-fg"
    >
      <WifiOff aria-hidden="true" className="size-4 shrink-0" />
      {OFFLINE_NO_SAVE.test(pathname)
        ? "You're offline. Changes can't be saved."
        : "You're offline. Showing saved articles."}
    </div>
  );
}
