// Talks to the egress-guard's run-admin API (compose network, control-plane only). Registering
// a run provisions its per-run UDS on the shared volume + the run's allowlist + held credentials;
// teardown removes them. (E4-AD-1, AD-5.) The provision (allowlist + tokens) travels ONLY over this
// admin-token-guarded control-plane path — never through the sandbox's job spec (AD-10).

/** A credential + allowlist the Guard holds for a run. The access token is short-lived (minted by
 *  control-api). This is control-plane data; it never enters the sandbox. */
export interface ProvisionConnection {
  connectionId: string;
  provider: "gmail";
  destinations: string[];
  accessToken: string;
}
/** The agent's attached-skill grants — the authority the Guard enforces per op (Story 4.4). Also
 *  control-plane only; the jobSpec carries skill IDs but never the authoritative scope/send. */
export interface SkillGrant {
  scope: "none" | "read" | "read-write";
  send: boolean;
}
export interface RunProvision {
  connections: ProvisionConnection[];
  grants: SkillGrant[];
  costKey?: string; // the per-run LiteLLM cost key (Story 4.5) — control-plane only, never the jobSpec
}

export interface RunGuard {
  registerRun(runId: string, provision?: RunProvision): Promise<void>;
  teardownRun(runId: string): Promise<void>;
}

export function httpRunGuard(adminUrl: string, adminToken: string): RunGuard {
  const headers = { "content-type": "application/json", "x-guard-admin": adminToken };
  return {
    async registerRun(runId, provision = { connections: [], grants: [] }) {
      const r = await fetch(`${adminUrl}/admin/runs/${encodeURIComponent(runId)}/register`, {
        method: "POST",
        headers,
        body: JSON.stringify(provision),
      });
      if (!r.ok) throw new Error(`guard register failed (HTTP ${r.status})`);
    },
    async teardownRun(runId) {
      // best-effort — teardown must never block reaping
      await fetch(`${adminUrl}/admin/runs/${encodeURIComponent(runId)}/teardown`, { method: "POST", headers }).catch(() => {});
    },
  };
}

// A no-op guard for unit tests / no-guard boot. Records the provision so tests can assert the
// allowlist + that a credential was passed (and, crucially, that it never leaked into the jobSpec).
export function fakeRunGuard(): RunGuard & { registered: { runId: string; provision: RunProvision }[]; toreDown: string[] } {
  const registered: { runId: string; provision: RunProvision }[] = [];
  const toreDown: string[] = [];
  return {
    registered,
    toreDown,
    async registerRun(runId, provision = { connections: [], grants: [] }) {
      registered.push({ runId, provision });
    },
    async teardownRun(runId) {
      toreDown.push(runId);
    },
  };
}
