// Memory consolidation tuning (Story 8.4/8.6). Shared so the SAME distance threshold governs both the
// reflect loop (orchestrator) and the accept-time deferred supersede (memory routes) — a stale
// same-topic fact must be closed by exactly the same rule whether the new memory is auto-applied or
// approved later. Single source of truth; changing it changes both paths together.
export const SUPERSEDE_MAX_DISTANCE = 0.25; // a same-topic memory this close (but not a dup) is the stale prior fact ⇒ close it
