# 0005. Frontend stack

- Status: Accepted
- Date: 2026-11-16
- Deciders: product-manager

## Context

Hard constraints: React SPA, Tailwind CSS, mobile first, dark mode, talks only to our JSON API. Goal: opening the app shows cached articles immediately.

## Decision (versions current on 2026-11-16)

| Concern | Choice | Rejected and why |
|---|---|---|
| Build | Vite 8 | CRA (dead), Next.js/Remix framework mode (SSR, not wanted) |
| UI | React 19 | – |
| Styling | Tailwind CSS 4 via `@tailwindcss/vite`; tokens as CSS variables; dark variant on `[data-theme=dark]` | `media`-only dark mode (no manual override) |
| Routing | React Router 8, declarative/data mode, no SSR | TanStack Router (fine, but less familiar; no strong need for typed search params) |
| Server state | TanStack Query 5 (`useInfiniteQuery`, optimistic mutations) | Redux/Zustand (we have no meaningful client-only state); SWR (weaker mutations/infinite support) |
| Persistence | `@tanstack/react-query-persist-client` + async-storage persister + `idb-keyval` (IndexedDB) | `localStorage` (5 MB, sync, blocks main thread) |
| Sanitising | DOMPurify 3, in one module, one component | Server-side sanitising (costs Worker CPU in a 10 ms budget) |
| PWA | `vite-plugin-pwa` 2 (Workbox): manifest + app-shell precache | Hand-written service worker |
| Passkeys | `@simplewebauthn/browser` 14 | – |
| Icons | `lucide-react` | – |
| Dates | `Intl` APIs | date-fns/dayjs (unneeded weight) |

Initial JS budget: 170 KB gzipped.

## Consequences

- No other runtime dependencies without PM approval.
- Flash-free theming uses a small external `theme-init.js` so the CSP needs no `'unsafe-inline'`.
- Offline reading of article bodies is M3; MVP persists lists, counts and the last 50 opened articles.
