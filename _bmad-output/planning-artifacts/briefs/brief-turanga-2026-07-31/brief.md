---
title: "Product Brief: turanga"
status: final
created: 2026-07-31
updated: 2026-07-31
---

# Product Brief: turanga

## Executive Summary

turanga is a generic platform for building, securing, and operating your own ecosystem of agents. Every agent it runs lives in a sandbox you control — a container with guarded data ingress/egress and a hard cost ceiling — and moves deliberately from *draft* to *test* to *Activate*. The platform never knows or cares what any given agent does; email triage, portfolio watching, and home automation are things you *build on* turanga, not features baked into it.

The category today — Dify, Openclaw, Hermes — optimizes for capability: look how much your agent can *do*. turanga inverts the default and optimizes for the opposite fear: how much can it do *to you*. Agents are guilty until sandboxed. That single inversion is the product. It is what lets a person hand an agent real access to their life — their inbox, their money, their home — without betting that life on the model's good behavior.

The first version proves exactly one thing, end to end: that you can take a generic agent from a draft to doing real work against real data, inside isolation you trust, under a cost cap it cannot breach — and that you'd actually click Activate against your own inbox. If that click feels safe, turanga works. Everything else is roadmap.

## The Problem

People who can build capable agents today cannot safely *run* them against anything that matters. The tooling assumes trust the technology has not earned:

- An agent useful enough to read your email is, by construction, an agent exposed to untrusted text from strangers — the highest-signal prompt-injection surface there is. Give it broad access and a single crafted message can turn it against you (forward a password reset, exfiltrate a document). Today you either don't give it access, or you give it access and don't sleep.
- Cost is unbounded by default. An always-on agent with model access is a meter with no ceiling, and a self-improving one gets *better at spending* over time.
- Existing platforms treat isolation and spend limits as configuration footnotes, not as the spine of the product. Dify, Openclaw, and Hermes are capable and pleasant to build in; none of them is isolation-first.

The result: the people most equipped to benefit from a personal agent ecosystem are the ones most aware of why they can't trust one. The status quo is a choice between usefulness and safety, and safety keeps losing.

## The Solution

turanga makes the sandbox the product, not a setting. You define an agent (its model, its instructions, the skills and tools it may use, and scoped permissions for each), and turanga runs it inside a controlled cell:

- **Containerized isolation** — each agent runs in its own container.
- **A guarded ingress/egress wrapper** around the agent harness — you control what data goes in and, critically, what is allowed back out. For the first version this is a rules/allowlist boundary (a connection may only reach approved destinations), built behind a **pluggable filter interface** so content inspection (secret/PII scanning) can drop in later without rework.
- **A hard cost ceiling** — a per-agent, time-window budget with a live meter and a kill on breach.
- **A deliberate lifecycle** — draft (scratchpad) → test → **Activate**. Promotion is an intentional act, like arming something: you open one door on purpose and watch the meter start to tick.
- **Central management** — agents, connections, and keys live in one place, so the second agent is a fork of the same machinery, not a rewrite.

The experience is designed against the Warm Ink design system already established in this repo: neutral, dense, and disciplined, where the only saturated color on a resting screen is a status dot — so when your eye catches color, it always means an agent is running, needs review, or has breached something.

## What Makes This Different

**Isolation-first, generic by design.** The differentiator is the inversion of the default (guilty until sandboxed) and the discipline to keep the platform ignorant of use case. Two honest claims:

- **The wedge is trust, not capability.** "Agents you can trust with real access." Security leads, cost control rides shotgun, the ecosystem is the promise. Competitors lead with reach; turanga leads with blast-radius control.
- **The platform never knows what an agent does.** The code that runs the email agent must not contain the word "email." That is what makes the sandbox, the cost meter, and the permission model reusable — and what turns the second use case into a weekend instead of a rebuild.

The evidence backs the wedge, not just the intuition. A competitive scan of open-source alternatives (see `research/competitive-findings.md`) found the field is overwhelmingly capability-first, with isolation treated as an operator's bolt-on: Dify's maintainers *declined* to add per-agent microVM isolation and a pre-execution tool-policy hook; the runtimes the founder admires — Openclaw and Hermes — ship sandboxing **off by default** and cap no spend; and a 2026 wave of critical CVEs (an n8n 9.9-CVSS RCE, Langflow on CISA's must-patch list, a documented Dify cross-tenant breach) shows the capability-first posture and its attack surface are the norm, not a strawman.

**Where the real moat is — and it is not where it first looks.** The isolation and budgeting *primitives* are commodity: Firecracker/gVisor/E2B for containment, LiteLLM for per-key budgets. There is no proprietary secret in *assembling* the stack, and the brief will not pretend otherwise. The defensibility lives in the two things the 2026 research shows are genuinely hard and mostly unsolved:

1. **A generic egress guard that assumes the agent is already compromised.** Not an allowlist — a boundary built to survive prompt-injection-driven *exfiltration*, where sharded and covert-channel attacks defeat naive filters and where network/system-layer control provably beats prompt-layer defense. Treated as a checkbox, this is nothing; treated as the hard security surface it is, it is the most defensible part of the product.
2. **Provably-hard cost enforcement under streaming and concurrency.** A cap that actually kills a running, concurrent agent mid-stream — where output tokens are unknown until completion and even the leading gateway (LiteLLM) carries open enforcement-bypass bugs. Reliable mid-stream kill with reserve-then-reconcile accounting is a specialty capability, not a config flag.

The honest moat, then, is not "a patent" and not merely "execution and coherence" — it is *earned engineering on two adversarial surfaces* plus the opinionated default that keeps isolation generic across arbitrary agents.

## The Field and the Nearest Enemy

turanga is not entering an empty room. One open-source project — **Superagent** — is genuinely safety-first: a policy layer that evaluates and blocks prompts, tool calls, and responses, with data redaction and reputation-gated ingress. It is the nearest enemy and should be treated as one.

The opening is specific and defensible: Superagent is oriented around governing **coding agents**, and it caps **no spend**. turanga is a *generic* personal-agent platform with a *hard cost ceiling* as a first-class promise — the one thing no safety-first competitor currently offers. Framed plainly: **the only isolation-first agent platform that also won't let your agent bankrupt you.** Secondary threats are Dify (should it finish per-agent isolation and add budgets) and the assemble-it-yourself stack (LangGraph + E2B + LiteLLM) a funded team could productize — which is the fast-follower risk named below.

## Risks

- **Fast-follower risk (real).** The primitives are cheap to stitch together; a funded team could ship a look-alike MVP quickly. Defensibility is not the bundle — it is out-executing on the two hard surfaces (adversarial egress guard, provable cost enforcement) and keeping isolation generic. A turanga that ships the easy 80% and treats egress as allowlist config has no durable edge.
- **Moat-erosion risk.** If Superagent adds a cost cap, or Dify finishes per-agent isolation and budgets, the white space narrows. The mitigation is depth on the adversarial security surface, not breadth of features.
- **Positioning risk.** Competitive specifics on Openclaw/Hermes/Superagent were verified from primary sources in-session, but the landscape moves weekly; any external-facing positioning should be re-confirmed (e.g., via `bmad-market-research`) before it is relied upon.

## Who This Serves

- **Primary (now): the builder-operator — you.** One person who can define an agent *and* is accountable when it misbehaves, wearing both hats. Success is visceral and singular: you are willing to Activate an agent against your own real data and you sleep afterward.
- **Secondary (later): business owners and operators.** People who consume and supervise agents others built. This implies a multi-user security and roles model — explicitly out of the first version, deliberately kept in view.

## Success Criteria

The MVP is falsifiable by a single human test and three hard guarantees:

- **The exhale test.** You build an email agent entirely on turanga and are actually willing to click Activate against a real inbox. If you hesitate, the product has failed its one job.
- **The cost cap holds.** An agent cannot exceed its time-window budget; on breach it is killed, and the meter reflected the spend truthfully the whole way.
- **The guard holds.** An agent cannot send data to a destination outside its allowlist, and the boundary is demonstrable (you can show it refusing).
- **Genericity holds.** The email agent is built with zero email-specific code in the platform — proven by the platform source containing no use-case logic.

## Scope

**In (the irreducible generic core):**

1. Define an agent — model + instructions + skills/tools + scoped permissions.
2. Lifecycle — draft (scratchpad) → test → promote (Activate).
3. Sandboxed run — a container per agent + the ingress/egress guard wrapper. **MVP: allowlist rules + a pluggable filter hook.** The adversarial-grade egress reference monitor (survives injection-driven exfiltration) is the deliberate roadmap moat, and the hook is the seam it drops into.
4. Hard cost cap — per-agent, time-window budget, live meter, kill on breach.
5. One generic connector + central management of agents, connections, and keys.
6. Dogfood proof — an email agent built *on* the platform, Activatable against a real inbox, with no email-specific platform code.

Single-user, single-machine.

**Out (roadmap, deliberately deferred):** workflows and an eventing engine; self-learning / skill auto-updating; the runtime macro language in skills; an MCP/tool marketplace; model routing; local inference (llama.cpp); multi-agent orchestration; a full PII/content-inspection engine (the *hook* is in, the engine is not); multi-user and roles. See `addendum.md` for the full inventory and sequencing rationale.

## Vision

If the first click feels safe, turanga becomes the place you keep a household of trusted agents — one watching your stock portfolio, one running your inbox, one managing your home — each in its own cell, each on its own leash, all centrally governed by you. The generic core earns each new use case cheaply, so the ecosystem grows by addition, not rewrite. Workflows let agents sit in larger processes; an eventing layer lets the world wake them; self-learning lets them improve — always inside the sandbox, always under a ceiling, optionally gated by your approval before they change themselves.

The meter, over time, stops being plumbing and becomes a character: a leash on a thing that pulls. turanga's long game is to make that leash strong enough, and legible enough, that giving capable agents real reach into your life stops being a leap of faith and becomes an ordinary, controlled decision.

---

*Distilled from a party-mode roundtable (John/PM, Mary/Analyst, Carson) on 2026-07-30–31. Companion detail in `addendum.md`. Visual identity: the Warm Ink design system (`.claude/skills/warm-ink-design`). Prior UX discovery: `_bmad-output/planning-artifacts/ux-designs/ux-turanga-2026-07-30`.*
