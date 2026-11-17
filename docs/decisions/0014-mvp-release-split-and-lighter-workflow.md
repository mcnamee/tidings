# 0014. Split M1 into MVP, R2 and R3; defer the deployed CPU gate; lighter workflow

- Status: Accepted
- Date: 2026-11-17
- Deciders: the owner (user), orchestrator
- Stories: all former M1 stories; TID-024, TID-039, new TID-047

## Context

The owner is hitting their Claude usage limits and wants to use Tidings early, then add features over the next couple of weeks. M1 ("everything needed to cancel Inoreader") is too big to ship first, and the per-story workflow (build, verify, UX review, PM decision round) uses a lot of tokens.

## Decisions

1. **Releases.** M1 is split into **MVP** (read my feeds on my phone), **R2** (safe to cancel Inoreader) and **R3** (polish and hardening). Spec §2 and the backlog summary list what is in each. M2 and M3 are unchanged.
2. **Deployed CPU gate deferred (Q12).** TID-039 no longer blocks TID-024. Production deploys at the end of the MVP, and TID-047 (R2) checks real CPU and budget use after 48 hours. If it shows trouble, TID-039 or ADR 0006's ladder follows. This accepts a small risk that some large feeds hit the 10 ms CPU limit at first; they fail safely as `cpu_limit` or `too_large`, and nothing goes over the free plan.
3. **TID-024 MVP scope:** AC1, AC2, AC5 and AC8. AC3, AC4, AC6 and AC7 move to TID-047.
4. **Lighter workflow for the MVP.** Each story goes software-engineer, then tester. UX reviews all MVP screens once, and the PM accepts the release once, at the end of the MVP instead of per story. Agents run only unit and integration tests; the full E2E suite runs only when the orchestrator merges to `main`.

## Consequences

- Faster feedback from real use, and fewer tokens per story.
- UX and acceptance defects are found later and fixed in a batch before the MVP ships.
- Every story still needs tests for its ACs, and the definition of done is unchanged.
