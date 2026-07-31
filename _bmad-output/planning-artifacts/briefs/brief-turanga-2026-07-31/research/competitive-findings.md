# turanga — Competitive Deep Research (open-source alternatives)

*Date: 2026-07-31. Four parallel investigators, focused on turanga's wedge: isolation-first (container + guarded ingress/egress), hard cost caps, generic platform. Verified claims cite primary sources; synthesis/impressions are flagged.*

## TL;DR

- **No open-source platform is isolation-first-by-default AND cost-capped AND generic.** The bundle is white space. The pieces exist; the conjunction doesn't.
- **The wedge is validated by evidence, not just intuition.** Dify rejected microVM isolation and pre-execution tool policy; Openclaw/Hermes ship sandboxing OFF by default; a 2026 CVE wave (n8n 9.9 RCE, Langflow on CISA's must-patch list, Dify cross-tenant breach) shows capability-first is the norm and the attack surface is real.
- **The brief's "no technical moat" claim is essentially TRUE** — isolation and per-key budgets are off-the-shelf (Firecracker/gVisor/Kata/E2B, LiteLLM). The edge is opinionated default + integration discipline.
- **But the brief undersells two genuinely hard things** it should claim as the real defensibility: (1) a **generic egress guard that defeats prompt-injection exfiltration** (open research problem), and (2) **true hard cost caps under concurrency/streaming** (a specialty capability the leading gateways mostly lack, with live enforcement bugs).
- **Closest threat: Superagent** — the one genuinely safety-first OSS project. Its gap (turanga's opening): scoped to governing *coding agents*, no hard cost cap.

---

## 1. Dify

Not isolation-first. Has a real code sandbox (**DifySandbox**: seccomp + chroot + proxied egress) but it's **process-level, shared-kernel, single-container multi-task** — Imperva documented a cross-tenant source-code disclosure (shared runtime identity, weak crypto; later patched). Maintainers **closed as "not planned"** both (a) per-execution QEMU-microVM isolation + domain-allowlist egress (#32987) and (b) a pre-execution tool/egress policy hook (#34021) — so a successful injection reaches any tool. Egress is coarse (proxy SSRF), not per-agent allow/deny. **No hard $ cost cap / kill-on-breach** — meters platform credits; model spend is externalized. Positioning: capability-first.
→ *turanga targets 3 of Dify's 4 soft spots; not differentiated on "a sandbox exists at all" or basic moderation.*

## 2. Openclaw & Hermes (the ones you like)

Both confirmed as agent runtimes; **neither isolation-first by default** — validating your complaint.
- **OpenClaw** (`github.com/openclaw/openclaw`): sandbox **opt-in** (`sandbox.mode` OFF by default), but *hardened Docker defaults once enabled* (`network:none`, read-only root, `capDrop:ALL`). Tool-policy scoping. No injection defense, no cost limits. Public sandbox-escape write-ups (Snyk, Lasso).
- **Hermes** (`NousResearch/hermes-agent`, MIT ~Feb 2026): default `local` backend runs on the **host with no isolation**; containers opt-in. Adds prompt-injection context scanning + command-approval + SSRF blocking — but also a "YOLO mode." No egress filter, no cost limits. Public critical issues on record.
→ *Both leave sandboxing to the operator and neither caps spend. This is the exact gap turanga closes by making isolation the default, not a flag.*

## 3. OSS landscape (capability-first vs safety-first)

Capability-first (isolation is bolt-on via Modal/E2B/Daytona): **n8n** (2026 9.9-CVSS RCE), **Flowise**, **Langflow** (documents its *own* lack of isolation; CVE on CISA list), **LangGraph/LangChain**, **CrewAI** (removed its code interpreter, points to E2B), **AutoGen/AG2** (best built-in Docker exec of the frameworks, still shared-kernel), **Activepieces**, **Rivet**, **AutoGPT**, **Letta** (memory-first; tools via E2B).

**The outlier — Superagent** (`superagent.sh`): genuinely **safety-first** positioning — a Safety Agent policy layer (evaluates/blocks prompts, tool calls, responses), sensitive-data redaction, prompt-injection blocking, reputation-scoring of packages/MCP/repos, and an isolated sandbox (VibeKit). Real egress/data control. **But** oriented around governing *coding agents*, and **no hard cost cap**.
→ *Closest philosophical match and closest threat. turanga's opening vs Superagent: generic personal-agent platform (not coding-agent governance) + hard cost cap. [Verify Superagent's roadmap before treating as settled — this is synthesis.]*

Secondary threats: **Dify** (if it finishes per-agent isolation + adds budgets), and the **DIY reference stack** (LangGraph + Modal/E2B + LiteLLM) a funded competitor could productize.

## 4. Sandbox + cost-cap tech (does the "no moat" claim hold?)

**Isolation primitives are commoditized:** Firecracker microVMs, gVisor, Kata, E2B, Modal, Cloudflare Sandboxes, K8s Agent Sandbox. 2026 consensus: shared-kernel Docker is no longer sufficient for untrusted agent code; default-deny container-per-task on gVisor/Firecracker is the baseline. **Basic egress control** (block-all + allowlist) is a known pattern, not novel.

**Cost caps:** observability (Langfuse, Helicone) ≠ enforcement (it sees spend only *after* the paid call). Gateways (**LiteLLM** OSS, Portkey, OpenRouter) *do* enforce hard per-key budgets that block future calls.

**What's genuinely HARD (the undersold moat):**
- **Generic egress defense vs prompt-injection exfiltration is an OPEN RESEARCH PROBLEM.** 2026 papers ("Silent Egress" P(egress)=0.89 evading 95% of output checks; sharded exfiltration cutting per-request leakage 73%; backdoored tool-use) show naive allowlists/DLP are defeated, and that **network/system-layer controls beat prompt-layer defenses** — directly validating "egress as a first-class control."
- **True hard cost cap under concurrency/streaming overshoots.** Output tokens are unknown until completion → concurrent requests transiently exceed caps; only proxy-layer atomic accounting (reserve-then-reconcile) enforces centrally. LiteLLM has *live enforcement-bypass bugs* (#26672, #27735). Reliable **mid-stream kill-on-breach** is a specialty feature (LLMCap, Tokonomics, AgentKavach) the incumbents mostly lack.

**Verdict:** "no proprietary secret in *assembling* the stack" = true. But if turanga treats the egress guard as mere allowlist config, it has **no edge**; if it treats it as the hard, adversarial security surface the literature says it is — plus provably-hard cost enforcement — **that is the most defensible part of the whole product.**

---

## Implications for the brief (candidate revisions)

1. **Strengthen "What Makes This Different" with evidence, not assertion** — cite the pattern: rejected isolation in Dify, opt-in/off sandboxing in Openclaw/Hermes, the 2026 CVE wave. The claim "nobody is isolation-first" should become "one project (Superagent) is, and it's scoped elsewhere; the generic + cost-capped + default-on bundle is unclaimed."
2. **Name Superagent honestly** as the nearest competitor and state the specific opening (generic personal-agent scope + hard cost cap).
3. **Reframe the moat.** Keep the honesty ("primitives are off-the-shelf") but stop underselling: the defensibility is (a) a **generic egress guard that survives adversarial exfiltration** and (b) **provably-hard cost enforcement** — both genuinely hard, both validated as unsolved by 2026 research. That's a stronger, still-honest moat than "execution + coherence."
4. **Elevate the egress guard** from an implementation detail to a headline security surface (and flag it for Winston as the hardest architecture problem, not just "allowlist rules").
5. **Add a "Risks" note:** the pieces are cheap to stitch → fast-follower risk; defensibility must be earned on the two hard surfaces, or turanga is just a nicer wrapper.

## Confidence

Platform architectures, CVEs, rejected-issue statuses, sandbox/cost-tech capabilities, and the research-frontier findings are **verified from primary sources**. "No OSS product bundles all four properties" and "Superagent is the closest threat" are **synthesis** across the survey — worth a hands-on Superagent check before external positioning relies on them. Openclaw/Hermes identification is high-confidence but a few supporting hits were aggregator/future-dated; load-bearing claims came from the primary repos/docs.
