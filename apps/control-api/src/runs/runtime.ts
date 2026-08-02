// SandboxRuntime (E4-AD-3): one interface, runtime chosen by explicit config, fail-closed —
// never a silent downgrade. `gvisor` (--runtime=runsc) for production; `dev-insecure` (plain
// runc, still --network=none + UDS + stdio, NO kernel isolation) for gVisor-less dev, refused
// in production. The sandbox has NO network; its only egress is the bind-mounted guard UDS.
import Docker from "dockerode";
import { PassThrough } from "node:stream";

export type SandboxRuntimeKind = "gvisor" | "dev-insecure";

export interface EstablishInput {
  runId: string;
  image: string; // the prebuilt agent-harness image tag
  jobSpecJson: string; // injected on stdin (immutable, AD-9)
  guardSocketDir: string; // host dir holding <runId>.sock; bind-mounted to /guard in the sandbox
}

export interface SandboxHandle {
  lines: AsyncIterable<string>; // NDJSON control-channel lines from the container stdout (E4-AD-2)
  done: Promise<{ exitCode: number }>;
  kill(): Promise<void>;
}

export interface SandboxRuntime {
  readonly kind: SandboxRuntimeKind;
  establish(input: EstablishInput): Promise<SandboxHandle>;
}

/** Resolve the runtime kind from SANDBOX_RUNTIME, refusing the insecure dev runtime in prod. */
export function resolveSandboxRuntimeKind(env = process.env): SandboxRuntimeKind {
  const raw = env.SANDBOX_RUNTIME ?? "dev-insecure";
  if (raw !== "gvisor" && raw !== "dev-insecure") {
    throw new Error(`SANDBOX_RUNTIME must be 'gvisor' or 'dev-insecure', got '${raw}'.`);
  }
  if (raw === "dev-insecure" && env.NODE_ENV === "production") {
    throw new Error("SANDBOX_RUNTIME=dev-insecure is refused in production — it has no kernel isolation.");
  }
  return raw;
}

// Split a byte stream into complete newline-delimited lines, yielded as they arrive.
async function* lineIterator(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk.toString();
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield line;
    }
  }
  const tail = buf.trim();
  if (tail) yield tail;
}

export function dockerRuntime(kind: SandboxRuntimeKind, docker = new Docker()): SandboxRuntime {
  return {
    kind,
    async establish({ runId, image, jobSpecJson, guardSocketDir }) {
      // FAIL-CLOSED: any error here propagates to the orchestrator, which fails the run.
      // We never catch-and-retry with a weaker runtime.
      const container = await docker.createContainer({
        Image: image,
        name: `turanga-run-${runId}`,
        Tty: false,
        AttachStdout: true,
        AttachStderr: true,
        Env: [`JOB_SPEC=${jobSpecJson}`], // the immutable job spec, injected at create time (E4-AD-2)
        Labels: { "turanga.run": runId },
        HostConfig: {
          NetworkMode: "none", // no network — the ONLY egress is the guard UDS (E4-AD-1)
          AutoRemove: true, // reaped on exit (AD-4)
          Runtime: kind === "gvisor" ? "runsc" : undefined, // undefined → the daemon default (runc)
          Binds: [`${guardSocketDir}:/guard:rw`], // the per-run guard socket
        },
      });

      const stream = await container.attach({ stream: true, stdout: true, stderr: true });
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      // Non-Tty streams are multiplexed; demux stdout (the control channel) from stderr.
      docker.modem.demuxStream(stream, stdout, stderr);
      stderr.resume(); // drain stderr; it is never the control channel (E4-AD-2)
      // demuxStream doesn't propagate end/close to its targets — do it ourselves so the stdout
      // line iterator terminates when the container exits (otherwise the read hangs forever).
      const closeOutputs = () => {
        stdout.end();
        stderr.end();
      };
      stream.on("end", closeOutputs);
      stream.on("close", closeOutputs);
      stream.on("error", closeOutputs);

      await container.start();

      const done = container
        .wait()
        .then((r: { StatusCode: number }) => ({ exitCode: r.StatusCode }))
        .catch(() => ({ exitCode: -1 })); // AutoRemove can race the wait; treat as reaped

      return {
        lines: lineIterator(stdout),
        done,
        async kill() {
          await container.remove({ force: true }).catch(() => {});
        },
      };
    },
  };
}

/** Test double: emits scripted NDJSON control lines, then resolves `done`. No Docker. */
export function fakeSandboxRuntime(script: {
  lines?: string[];
  exitCode?: number;
  failEstablish?: string; // if set, establish() throws this message (fail-closed test)
} = {}): SandboxRuntime & { established: EstablishInput[] } {
  const established: EstablishInput[] = [];
  return {
    kind: "dev-insecure",
    established,
    async establish(input) {
      established.push(input);
      if (script.failEstablish) throw new Error(script.failEstablish);
      const lines = script.lines ?? [];
      return {
        lines: (async function* () {
          for (const l of lines) yield l;
        })(),
        done: Promise.resolve({ exitCode: script.exitCode ?? 0 }),
        async kill() {},
      };
    },
  };
}
