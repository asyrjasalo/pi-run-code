// sandbox-executor.ts — Execute TypeScript/JavaScript code inside a secure-exec V8 isolate.
//
// Uses NodeRuntime from secure-exec with host adapters (NodeFileSystem,
// network, command executor) so the sandbox can do real work. Safety comes
// from the V8 isolate boundary + memory/CPU resource limits.

import type { ExecutionResult } from "./executor.js";
import { truncateLogs } from "./executor.js";

// secure-exec is ESM-only; dynamically import from this CJS module.
type SecureExecModule = typeof import("secure-exec");

let _cached: SecureExecModule | null = null;

async function loadSecureExec(): Promise<SecureExecModule> {
  if (_cached) return _cached;
  _cached = await import("secure-exec");
  return _cached;
}

interface SandboxOptions {
  cwd: string;
  timeout?: number;
  memoryLimitMb?: number;
  cpuTimeLimitMs?: number;
  maxOutputSize?: number;
  userPackages?: Record<string, unknown>;
}

/**
 * Execute code inside a secure-exec V8 isolate.
 *
 * The sandbox has access to host capabilities (filesystem, network,
 * child processes, env) but runs in an isolated V8 context with
 * memory and CPU limits. This provides:
 *   - V8 isolate boundary (separate heap/stack from host process)
 *   - Memory limit (default 128 MB)
 *   - CPU time limit (default 15 s)
 *   - Cannot corrupt host process memory
 *
 * Globals injected: $ (shell via child_process), print, require, process, Buffer,
 * plus any user packages from .pi/pi-run-code.json.
 */
export async function executeInSandbox(
  code: string,
  options: SandboxOptions,
): Promise<ExecutionResult> {
  const start = performance.now();
  const logs: string[] = [];

  const {
    cwd,
    timeout = 30_000,
    memoryLimitMb = 128,
    cpuTimeLimitMs = 15_000,
    maxOutputSize = 100_000,
    userPackages = {},
  } = options;

  const se = await loadSecureExec();

  // Preamble: inject globals that the unsandboxed executor also provides.
  // zx $ can't run inside the V8 isolate (TextDecoder polyfill conflict),
  // so we shim it with child_process.execSync.
  const preamble = buildPreamble(cwd, userPackages);

  // Code is already transpiled to: (async () => { ... })() — a Promise expression.
  // Just await it and export the result.
  const wrappedCode = `${preamble}\nconst __result = await ${code};\nexport default __result;`;

  try {
    const runtime = createRuntime(se, {
      cwd,
      memoryLimitMb,
      cpuTimeLimitMs: Math.min(cpuTimeLimitMs, timeout),
      onStdio: (event: { channel: "stdout" | "stderr"; message: string }) => {
        logs.push(event.message.replace(/\n$/, ""));
      },
    });

    // Use run() to capture the return value via export default.
    const result = await runtime.run<unknown>(wrappedCode, "/entry.mjs");

    runtime.dispose();

    const elapsedMs = performance.now() - start;
    const finalLogs = truncateLogs(logs, maxOutputSize);

    if (result.code !== 0) {
      const errorMsg =
        result.errorMessage ?? `Process exited with code ${result.code}`;
      return {
        success: false,
        errorKind: "runtime",
        errors: [{ line: 0, message: errorMsg }],
        logs: finalLogs,
        elapsedMs,
      };
    }

    // Extract the default export value
    const returnValue = (result.exports as Record<string, unknown>)?.default;

    return {
      success: true,
      errors: [],
      logs: finalLogs,
      returnValue,
      elapsedMs,
    };
  } catch (err: any) {
    const elapsedMs = performance.now() - start;
    return {
      success: false,
      errorKind: "runtime",
      errors: [{ line: 0, message: err.message || "Sandbox execution error" }],
      logs,
      elapsedMs,
    };
  }
}

/**
 * Dispose any cached resources. Call on process exit.
 */
export async function disposeSandbox(): Promise<void> {
  // Currently no-op; runtime is created/disposed per execution.
  // If we add singleton caching later, clean up here.
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RuntimeConfig {
  cwd: string;
  memoryLimitMb: number;
  cpuTimeLimitMs: number;
  onStdio: (event: { channel: "stdout" | "stderr"; message: string }) => void;
}

function createRuntime(
  se: SecureExecModule,
  config: RuntimeConfig,
): InstanceType<SecureExecModule["NodeRuntime"]> {
  // Connect to real host resources through secure-exec adapters.
  // The V8 isolate boundary + resource limits provide the security layer.
  const driver = se.createNodeDriver({
    filesystem: new se.NodeFileSystem(),
    networkAdapter: se.createDefaultNetworkAdapter(),
    commandExecutor: se.createNodeHostCommandExecutor(),
    permissions: se.allowAll,
    processConfig: {
      cwd: config.cwd,
      env: process.env as Record<string, string>,
    },
  });
  const factory = se.createNodeRuntimeDriverFactory();

  return new se.NodeRuntime({
    systemDriver: driver,
    runtimeDriverFactory: factory,
    memoryLimit: config.memoryLimitMb,
    cpuTimeLimitMs: config.cpuTimeLimitMs,
    onStdio: config.onStdio,
  });
}

function buildPreamble(
  cwd: string,
  userPackages: Record<string, unknown>,
): string {
  const lines: string[] = [];

  // print() — same API as unsandboxed mode
  lines.push(`var print = (...args) => {`);
  lines.push(
    `  const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a, null, 2)).join(" ");`,
  );
  lines.push(`  console.log(text);`);
  lines.push(`};`);

  // $ shim — zx can't run inside the V8 isolate, so we use child_process.
  // Provides the same `await $\`cmd\`` API as zx.
  lines.push(`var $ = function(strings, ...values) {`);
  lines.push(`  const cp = require("child_process");`);
  lines.push(`  const cmd = String.raw({ raw: strings }, ...values);`);
  lines.push(`  try {`);
  lines.push(
    `    const stdout = cp.execSync(cmd, { encoding: "utf8", cwd: ${JSON.stringify(cwd)} });`,
  );
  lines.push(
    `    const result = { stdout: stdout || "", stderr: "", exitCode: 0, toString() { return this.stdout; } };`,
  );
  lines.push(`    return Promise.resolve(result);`);
  lines.push(`  } catch(e) {`);
  lines.push(
    `    const result = { stdout: e.stdout || "", stderr: e.stderr || "", exitCode: e.status || 1, toString() { return this.stdout; } };`,
  );
  lines.push(`    if (e.status !== undefined) return Promise.resolve(result);`);
  lines.push(`    return Promise.reject(e);`);
  lines.push(`  }`);
  lines.push(`};`);

  // User packages — declare as globals so `require()` can resolve them.
  // In the sandbox, require() is virtualized and resolves from host node_modules
  // via NodeFileSystem. We alias the var names for convenience.
  const entries = Object.entries(userPackages);
  for (const [name, _value] of entries) {
    // User packages are available via require() since we use NodeFileSystem.
    // Create a global alias: `var yaml = require("yaml")`
    lines.push(`var ${name} = require("${name}");`);
  }

  return lines.join("\n");
}
