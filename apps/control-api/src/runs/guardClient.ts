// Talks to the egress-guard's run-admin API (compose network, control-plane only). Registering
// a run provisions its per-run UDS on the shared volume; teardown removes it. (E4-AD-1.)
export interface RunGuard {
  registerRun(runId: string): Promise<void>;
  teardownRun(runId: string): Promise<void>;
}

export function httpRunGuard(adminUrl: string, adminToken: string): RunGuard {
  const headers = { "content-type": "application/json", "x-guard-admin": adminToken };
  return {
    async registerRun(runId) {
      const r = await fetch(`${adminUrl}/admin/runs/${encodeURIComponent(runId)}/register`, { method: "POST", headers });
      if (!r.ok) throw new Error(`guard register failed (HTTP ${r.status})`);
    },
    async teardownRun(runId) {
      // best-effort — teardown must never block reaping
      await fetch(`${adminUrl}/admin/runs/${encodeURIComponent(runId)}/teardown`, { method: "POST", headers }).catch(() => {});
    },
  };
}

// A no-op guard for unit tests / no-guard boot.
export function fakeRunGuard(): RunGuard & { registered: string[]; toreDown: string[] } {
  const registered: string[] = [];
  const toreDown: string[] = [];
  return {
    registered,
    toreDown,
    async registerRun(id) {
      registered.push(id);
    },
    async teardownRun(id) {
      toreDown.push(id);
    },
  };
}
