# turanga — Project Context (durable conventions)

Loaded automatically by BMAD dev/story workflows. Keep it short; it is guidance every future story inherits. Authoritative specs: `_bmad-output/planning-artifacts/` (PRD, architecture spine, UX spines DESIGN.md/EXPERIENCE.md). The Warm Ink design system baseline is `.claude/skills/warm-ink-design/`.

## Stack
- **All-TypeScript** monorepo (pnpm workspaces, Node 22). Frontend: **SvelteKit 2.69 / Svelte 5 (runes)**. Services: **Hono**. Model gateway: **LiteLLM** (sidecar, only non-TS box). Postgres 17, Redis 8, Docker + gVisor for per-run sandboxes.
- No Tailwind — **Warm Ink tokens are the design layer**.

## UI conventions (NFR-6)
- **Consume semantic tokens only** — `--bg-canvas`, `--surface-card`, `--text-primary`, `--action-primary-bg`, `--state-*`, `--border-*`, spacing/shape/motion vars. Never raw hex or ramp steps. Tokens live in `apps/web/src/lib/design/warm-ink/`.
- **Theme:** light default; dark is `:root[data-theme="dark"]`, which re-declares semantic aliases — so **no per-surface light/dark branches**. Set theme via `apps/web/src/lib/theme.ts`; FOUC-guard is the inline script in `app.html`.
- **The one rule:** neutrals do the work, ink carries action, saturated colour is reserved for agent/connection **state**. Primary actions are **ink, not colour**.
- **Icons:** `@lucide/svelte` (NOT the deprecated `lucide-svelte`), `currentColor`, 16/20px. **No emoji, no unicode glyphs as icons.**
- **Numbers:** model IDs, tokens, latency, cost, cap amounts render **mono + tabular** (`--font-mono` + `font-variant-numeric: tabular-nums`; `.mono-num` helper).

## Accessibility floor (UX-DR15)
- Every interactive element keyboard-reachable with a **visible focus ring** (never removed).
- **Status is never colour-only** — a coloured dot always pairs with a word.
- WCAG AA body-text contrast; persistent form labels (not placeholder-only) with associated, announced errors; mono metric text ≥ 12px.

## Voice / microcopy (UX-DR16)
- Sentence case. **Verb-first buttons:** Activate, Run test, Connect, Add skill, Remove (never Submit/OK/Deploy).
- Second person for the user, third for the agent. Numbers specific and unrounded.
- Empty states = fact + one action. Errors = cause → consequence → recovery. Refusals stated plainly.
- No exclamation marks, no emoji. Agent state is **stated, never celebrated**.

## Build / test expectations
- `pnpm -r build`, `pnpm -r test`, `pnpm lint` must stay clean. Web e2e (Playwright) runs a dev server on `:5173` (the control-api CORS-allowed origin) against a running compose stack.
- Secrets never committed (`.env` gitignored; only `.env.example`). Single-writer ownership (AD-7): `control-api` owns Agent/Connection state, the orchestrator owns Run state, LiteLLM owns spend.
