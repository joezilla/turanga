# turanga — Brief Addendum

Depth that belongs downstream (PRD, architecture) or that earned a place but not in the 1–2 page brief. Not audit info — that lives in `.memlog.md`.

## Full feature inventory (roadmap, not MVP)

Captured verbatim-ish from the founder's original dump, tagged for sequencing. **MVP** items are in the brief's Scope; everything else is roadmap.

**Agent lifecycle**
- Create · Manage · Secure · Run — the four verbs. `[MVP: create, secure, run + draft/test/Activate; Manage-at-scale is thin in MVP]`

**Agent features**
- Create in scratchpad / draft mode `[MVP]`
- Test `[MVP]`
- Promote to production / Activate `[MVP]`
- Cost control `[MVP: per-agent time-window cap]`
- Models / model routing `[MVP: pick a model; routing = roadmap]`
- Security: sandbox run `[MVP]`, PII detection `[roadmap — filter hook in MVP]`, prompt-injection defense `[partial — isolation + egress guard in MVP; detection engine roadmap]`, custom checks before activation `[roadmap]`
- Run custom code / libraries `[roadmap]`
- Enable skills / MCPs `[MVP: skills attachable; MCP marketplace roadmap]`
- Manage permissions of what agents can do with skills `[MVP: scoped permissions]`
- Self-learning / skill updating, optionally human-gated `[roadmap]`
- Memory management `[roadmap]`

**Skill features**
- Centrally manage skills `[MVP: central mgmt]`
- Scratchpad / activate `[MVP: mirrors agent lifecycle]`
- Environment-specific features / a macro language in skills executed dynamically at runtime `[roadmap]`

**MCP features**
- Centrally manage MCPs / tools `[roadmap]`

**Connections**
- Manage connections `[MVP: one generic connector + central mgmt]`
- Manage models available in connections `[MVP-lite]`
- Local inference with llama.cpp `[roadmap]`
- API integrations into OpenRouter `[roadmap — MVP can use a single provider]`

**Workflows**
- Create workflows that agents sit in `[roadmap]`
- Eventing mechanism that kicks off workflows and agents `[roadmap]`

## Rejected alternative — the vertical "inbox product" MVP

Early in the roundtable the PM proposed making the MVP *the email agent itself* — a trustworthy inbox product — on the reasoning that vertical slices avoid building a platform nobody uses.

**Rejected by the founder**, decisively: turanga must not code specific use cases; it is a generic platform he builds *in*. Email/portfolio/home are things built on top.

**Reconciliation adopted:** build the platform horizontal, but keep the *proof* singular — dogfood one email agent, in public, until it's undeniable, with zero use-case code in the platform. The forcing function is not a use case; it is the **exhale test** (would the founder arm it against his own inbox?), which is brutally falsifiable without hardcoding a vertical. This preserves scope discipline without betraying the generic thesis.

## Open questions for downstream work

**For architecture (Winston) — the ingress/egress guard is load-bearing and underspecified:**
- Is the egress boundary a *network* boundary (allowlisted destinations), a *data* boundary (payload inspection), or both? MVP commits to allowlist rules + a pluggable filter interface; the interface contract needs design so content inspection slots in without rework.
- Container-per-agent runtime: what provides isolation (Docker/OCI, gVisor, Firecracker microVMs)? What's the network default (deny-all + allowlist)?
- Where does the cost meter observe spend (proxy at the model-connection layer?), and how does "kill on breach" interrupt an in-flight run cleanly?
- Secrets/keys handling inside a sandbox that by design shouldn't be able to leak them.

**For product / PRD:**
- Cost-cap unit is intentionally simple for MVP (per-agent, time-window). Per-run and per-agent-group budgets are deferred — confirm the window granularity ($/day? rolling?) in the PRD. `[ASSUMPTION: daily]`
- "One generic connector": is email (IMAP/Gmail API) the first connector implementation, given it's also the dogfood proof? `[ASSUMPTION: yes — but the connector abstraction stays generic]`
- The self-learning + always-on vision interacts with cost caps in a non-obvious way (an agent that learns can learn to spend more). Flagged as a roadmap design concern ("the meter is a character, not plumbing").

## Stakes & context

Personal / prosumer project, founder is the sole initial user and builder. Serious ambition (a real ecosystem), but MVP rigor is right-sized to solo dogfooding, not investor-grade. Competitors referenced: Dify, Openclaw, Hermes — capable, not isolation-first. Competitive specifics on Openclaw/Hermes were **not verified** in-session and should be confirmed (via `bmad-market-research`) before any external-facing positioning relies on them.
