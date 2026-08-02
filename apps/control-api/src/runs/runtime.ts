// SandboxRuntime (E4-AD-3): one interface, runtime chosen by explicit config, fail-closed —
// never a silent downgrade. `gvisor` (--runtime=runsc) for production; `dev-insecure` (plain
// runc, still --network=none + UDS + stdio, NO kernel isolation) for gVisor-less dev, refused
// in production. The sandbox has NO network; its only egress is the per-run guard socket, mounted
// as its OWN subpath of the shared volume (E4-AD-1) so it can never see another run's socket.
import Docker from "dockerode";
import { PassThrough } from "node:stream";

export type SandboxRuntimeKind = "gvisor" | "dev-insecure";

const MAX_LINE = 1024 * 1024; // a control line is small; cap to prevent memory-exhaustion DoS

export interface EstablishInput {
  runId: string;
  image: string; // the prebuilt agent-harness image tag
  jobSpecJson: string; // injected at create time as JOB_SPEC (immutable, AD-9 / E4-AD-2)
  guardVolume: string; // shared volume; the run's OWN subpath (=runId) is mounted at /guard
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

/** Resolve the runtime kind from SANDBOX_RUNTIME. It MUST be set explicitly (E4-AD-3) — an unset
 *  value fails closed rather than defaulting to the insecure runtime. dev-insecure is refused in
 *  production. */
export function resolveSandboxRuntimeKind(env = process.env): SandboxRuntimeKind {
  const raw = env.SANDBOX_RUNTIME;
  if (raw !== "gvisor" && raw !== "dev-insecure") {
    throw new Error(`SANDBOX_RUNTIME must be set to 'gvisor' or 'dev-insecure' (got ${raw === undefined ? "unset" : `'${raw}'`}).`);
  }
  if (raw === "dev-insecure" && env.NODE_ENV === "production") {
    throw new Error("SANDBOX_RUNTIME=dev-insecure is refused in production — it has no kernel isolation.");
  }
  return raw;
}

// Split a byte stream into newline-delimited lines. Throws if a single line exceeds MAX_LINE so a
// runaway sandbox can't OOM the control plane.
async function* lineIterator(stream: NodeJS.ReadableStream): AsyncIterable<string> {
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk.toString();
    if (buf.length > MAX_LINE && !buf.includes("\n")) throw new Error("Control line exceeded the size limit.");
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
    async establish({ runId, image, jobSpecJson, guardVolume }) {
      // FAIL-CLOSED: any error here propagates to the orchestrator, which fails the run. We never
      // catch-and-retry with a weaker runtime, and we force-remove a container that was created but
      // failed to attach/start (AutoRemove only reaps a container that started and exited).
      let container: Docker.Container | undefined;
      try {
        // Mount ONLY this run's subdir of the shared volume (per-run isolation — the sandbox can
        // never see another run's socket). RW is required to connect() to the UDS. (@types/dockerode
        // over-requires VolumeOptions fields; the Docker API accepts Subpath alone.)
        const createOpts = {
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
            Mounts: [{ Type: "volume", Source: guardVolume, Target: "/guard", ReadOnly: false, VolumeOptions: { Subpath: runId } }],
          },
        } as unknown as Docker.ContainerCreateOptions;
        container = (await docker.createContainer(createOpts)) as Docker.Container;
        const c = container;

        const stream = await c.attach({ stream: true, stdout: true, stderr: true });
        const stdout = new PassThrough();
        const stderr = new PassThrough();
        docker.modem.demuxStream(stream, stdout, stderr);
        stderr.resume(); // drain stderr; it is never the control channel (E4-AD-2)
        // demuxStream doesn't propagate end/error to its targets — do it ourselves so the stdout
        // line iterator terminates when the container exits, and a stream error fails the run
        // (rather than masquerading as a clean EOF).
        const endOutputs = () => {
          stdout.end();
          stderr.end();
        };
        stream.on("end", endOutputs);
        stream.on("close", endOutputs);
        stream.on("error", (e) => {
          stdout.destroy(e instanceof Error ? e : new Error(String(e)));
          stderr.destroy();
        });

        await c.start();

        const done = c
          .wait()
          .then((r: { StatusCode: number }) => ({ exitCode: r.StatusCode }))
          .catch(() => ({ exitCode: -1 })); // AutoRemove can race the wait; treat as reaped

        return {
          lines: lineIterator(stdout),
          done,
          async kill() {
            await c.remove({ force: true }).catch(() => {});
          },
        };
      } catch (e) {
        // Force-remove the created-but-unstarted container so a failed launch can't leak it.
        if (container) await container.remove({ force: true }).catch(() => {});
        throw e;
      }
    },
  };
}

/** Test double: emits scripted NDJSON control lines, then resolves `done`. No Docker. */
export function fakeSandboxRuntime(script: {
  lines?: string[];
  exitCode?: number;
  failEstablish?: string; // if set, establish() throws this message (fail-closed test)
  hang?: boolean; // if set, lines never end + done never resolves (timeout test)
} = {}): SandboxRuntime & { established: EstablishInput[]; killed: number } {
  const established: EstablishInput[] = [];
  const state = { killed: 0 };
  return {
    kind: "dev-insecure",
    established,
    get killed() {
      return state.killed;
    },
    async establish(input) {
      established.push(input);
      if (script.failEstablish) throw new Error(script.failEstablish);
      if (script.hang) {
        let stop!: () => void;
        const gate = new Promise<void>((r) => (stop = r));
        return {
          // eslint-disable-next-line require-yield
          lines: (async function* () {
            await gate; // blocks until killed, then returns without yielding
          })(),
          done: new Promise<{ exitCode: number }>(() => {}), // never resolves
          async kill() {
            state.killed++;
            stop();
          },
        };
      }
      const lines = script.lines ?? [];
      return {
        lines: (async function* () {
          for (const l of lines) yield l;
        })(),
        done: Promise.resolve({ exitCode: script.exitCode ?? 0 }),
        async kill() {
          state.killed++;
        },
      };
    },
  };
}
