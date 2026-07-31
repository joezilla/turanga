# turanga PRD — Addendum

Technical-how and downstream detail deliberately kept out of the capabilities PRD. Primary consumer: `bmad-architecture` (Winston). Not audit info — that lives in `.memlog.md`.

## Architecture-bound decisions (for Winston)

These are the "how" behind the PRD's guarantees — the mechanism, not the guarantee itself.

### Sandbox / isolation (FR-7)
- **Runtime options to evaluate:** shared-kernel containers (Docker/OCI/runc) vs. stronger isolation (gVisor, Firecracker microVMs, Kata). 2026 consensus (see brief `research/competitive-findings.md`): shared-kernel Docker is no longer considered sufficient for untrusted agent code; default-deny container-per-task on gVisor or Firecracker is the recommended baseline. Off-the-shelf building blocks: E2B (Firecracker), Modal (gVisor), Kubernetes Agent Sandbox.
- **Requirement translation:** per-Run isolation, no shared filesystem/memory/runtime identity across concurrent Runs (FR-7), fail-closed on sandbox-establish failure (NFR-1).

### Ingress/Egress Guard (FR-8..10)
- **This is the load-bearing, hardest surface** and the roadmap moat. MVP scope is default-deny network allowlist + a Filter Hook seam.
- **Open design questions:** network boundary (deny-all + endpoint/DNS/SNI allowlist) vs. data boundary (payload inspection) — MVP does the former; the Hook is the seam for the latter. Where does the Guard sit (network namespace, proxy, syscall layer)? The 2026 literature ("Silent Egress," covert-channel/sharded exfiltration) shows naive allowlists are eventually defeated by injection-driven exfiltration — the *adversarial reference monitor* is roadmap, but the Hook contract should be designed now so it can host it without rework.

### Cost meter & Kill-on-breach (FR-11..12, NFR-3)
- **Observability ≠ enforcement:** tracing tools (Langfuse/Helicone) see spend only after the paid call. Enforcement needs a gateway/proxy layer with atomic shared accounting.
- **Concurrency race:** output tokens unknown until completion → concurrent Runs can transiently overshoot a cap; the known mitigation is **reserve-then-reconcile** with a proxy-layer atomic counter (e.g. Redis). LiteLLM offers per-key hard budgets but has documented enforcement-bypass bugs — evaluate whether to build on it or implement the metering boundary directly. Mid-stream kill (closing the SSE connection on breach) is a specialty capability, not a default.
- **Requirement translation:** meter matches summed Run metrics (no drift, FR-12), kill holds under concurrency (NFR-3).

### Model & data connections (FR-13..14)
- Model provider: single provider for MVP (no routing/OpenRouter). Data connection: one generic interface; first impl email (IMAP vs Gmail API vs both; app-password vs OAuth — Open Question 2).

## Deferred / rejected for MVP (rationale)
- **Multi-window / per-run / per-group cost caps** — deferred; single per-agent time-window cap is enough to prove the thesis.
- **Content-inspection / PII engine** — deferred behind the Filter Hook; shipping it in MVP would blur "the seam works" (FR-10) with "the inspector is good," two different claims.
- **Adversarial egress reference monitor** — the moat, deliberately roadmap; MVP proves the boundary exists and is default-deny.
- **Local inference / OpenRouter / model routing / MCP marketplace / workflows / eventing / self-learning / multi-user** — all roadmap per the brief; each is a separate build.

## Downstream mapping
- **Visual/behavioral specs** already exist: UX spines at `../../ux-designs/ux-turanga-2026-07-30/` (`DESIGN.md`, `EXPERIENCE.md`) cover Login, Agent-definition, Settings surfaces and the agent-status/cost-metric rendering. The PRD references these rather than duplicating them.
- **Next BMAD steps:** `bmad-architecture` (the Guard + sandbox + cost enforcement are the architecture spine), then `bmad-create-epics-and-stories`.
