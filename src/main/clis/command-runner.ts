import { spawn } from "node:child_process";
import path from "node:path";
import type {
  CliCommandResult,
  CliCommandRunner,
  CliCommandSpec,
} from "./types";

const MAX_ARGUMENTS = 64;
const MAX_ARGUMENT_LENGTH = 16_384;
const MAX_TOTAL_ARGUMENT_LENGTH = 24_576;
const CREDENTIAL_NAME =
  /(token|secret|password|passwd|credential|private[_-]?key|api[_-]?key|auth)/i;

export class RealCliCommandRunner implements CliCommandRunner {
  constructor(private readonly neutralWorkingDirectory: string) {}

  run(spec: CliCommandSpec, signal?: AbortSignal): Promise<CliCommandResult> {
    validateCliCommandSpec(spec);
    const cwd = spec.cwd ?? this.neutralWorkingDirectory;
    const env = buildMinimalEnvironment(spec.env);

    return new Promise((resolve) => {
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let timedOut = false;
      let cancelled = false;
      let outputExceeded = false;
      let settled = false;
      let child: ReturnType<typeof spawn>;

      const finish = (
        result: Omit<CliCommandResult, "executable" | "stdout" | "stderr">,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        resolve({
          executable: spec.executable,
          stdout: stdout.toString("utf8"),
          stderr: sanitizeProcessText(stderr.toString("utf8")),
          ...result,
        });
      };

      const terminateExactChild = (): void => {
        if (child && child.exitCode === null && !child.killed) child.kill();
      };

      const onAbort = (): void => {
        cancelled = true;
        terminateExactChild();
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        terminateExactChild();
      }, spec.timeoutMs);

      try {
        child = spawn(spec.executable, spec.args, {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        finish({
          exitCode: null,
          timedOut: false,
          cancelled: false,
          outputExceeded: false,
          errorCode: "SPAWN_FAILED",
          message: "The selected command could not be started.",
        });
        return;
      }

      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>,
        limit: number,
      ): Buffer<ArrayBufferLike> => {
        if (current.length + chunk.length > limit) {
          outputExceeded = true;
          terminateExactChild();
          return Buffer.concat([current, chunk]).subarray(0, limit);
        }
        return Buffer.concat([current, chunk]);
      };

      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk, spec.maxStdoutBytes);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk, spec.maxStderrBytes);
      });
      child.on("error", () => {
        finish({
          exitCode: null,
          timedOut,
          cancelled,
          outputExceeded,
          errorCode: "PROCESS_ERROR",
          message: "The selected command could not be completed.",
        });
      });
      child.on("close", (exitCode) => {
        finish({
          exitCode,
          timedOut,
          cancelled,
          outputExceeded,
          ...(timedOut
            ? {
                errorCode: "TIMEOUT",
                message: "The command exceeded its time limit.",
              }
            : cancelled
              ? { errorCode: "CANCELLED", message: "The command was cancelled." }
              : outputExceeded
                ? {
                    errorCode: "OUTPUT_LIMIT",
                    message: "The command produced too much output.",
                  }
                : {}),
        });
      });

      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export function buildMinimalEnvironment(
  additional?: Readonly<Record<string, string | undefined>>,
): NodeJS.ProcessEnv {
  const allowed = [
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "TEMP",
    "TMP",
    "PATH",
    "PATHEXT",
    "LANG",
    "LC_ALL",
    "SCOOP",
    "CARGO_HOME",
    "PIPX_HOME",
    "PIPX_BIN_DIR",
    "PNPM_HOME",
  ];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  for (const [name, value] of Object.entries(additional ?? {})) {
    if (value !== undefined && !CREDENTIAL_NAME.test(name)) env[name] = value;
  }
  return env;
}

export function sanitizeProcessText(value: string): string {
  return value
    .replace(
      /((?:token|secret|password|api[_-]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi,
      "$1[redacted]",
    )
    .slice(0, 4_096)
    .trim();
}

export function validateCliCommandSpec(spec: CliCommandSpec): void {
  if (!path.isAbsolute(spec.executable) || spec.executable.includes("\0")) {
    throw new Error("CLI command executable must be an absolute path.");
  }
  if (
    spec.args.length > MAX_ARGUMENTS ||
    spec.args.reduce((total, argument) => total + argument.length, 0) >
      MAX_TOTAL_ARGUMENT_LENGTH ||
    spec.args.some(
      (argument) =>
        argument.length > MAX_ARGUMENT_LENGTH || argument.includes("\0"),
    )
  ) {
    throw new Error("CLI command arguments are invalid.");
  }
  if (
    !Number.isFinite(spec.timeoutMs) ||
    spec.timeoutMs < 100 ||
    spec.timeoutMs > 120_000
  ) {
    throw new Error("CLI command timeout is invalid.");
  }
  if (
    spec.maxStdoutBytes < 1 ||
    spec.maxStderrBytes < 1 ||
    spec.maxStdoutBytes > 8 * 1024 * 1024 ||
    spec.maxStderrBytes > 8 * 1024 * 1024
  ) {
    throw new Error("CLI command output limit is invalid.");
  }
}
