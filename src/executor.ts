// executor.ts — Execute TypeScript code via esbuild + AsyncFunction or secure-exec sandbox.
//
// When `sandboxed: true` (default), code runs inside a secure-exec V8 isolate
// with deny-by-default permissions. Falls back to AsyncFunction for unsandboxed mode.

import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { transformSync } from "esbuild";
import { $ } from "zx";
import { disposeSandbox, executeInSandbox } from "./sandbox-executor.js";
import { type TypeCheckError, typeCheck } from "./type-checker.js";

const nodeRequire: NodeRequire = createRequire(
  typeof __filename !== "undefined"
    ? __filename
    : (() => {
        throw new Error("CJS context required");
      })(),
);

// --- Types ---

export interface ExecutionError {
  line: number;
  message: string;
}

export interface ExecutionResult {
  success: boolean;
  errorKind?: "type" | "runtime";
  errors: ExecutionError[];
  logs: string[];
  returnValue?: unknown;
  elapsedMs: number;
}

interface ExecutionOptions {
  cwd: string;
  timeout?: number;
  maxOutputSize?: number;
  signal?: AbortSignal;
  onUpdate?: any;
  shellPrefix?: string;
  userPackages?: Record<string, unknown>;
  typeDefs?: string;
  /** When true, run code inside a secure-exec V8 isolate. Default: false (legacy). */
  sandboxed?: boolean;
}

// --- Transpile ---

function rewriteImports(code: string): string {
  return code
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      const indent = line.slice(0, line.length - trimmed.length);

      // import { a, b } from 'module'
      let m = trimmed.match(
        /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/,
      );
      if (m) {
        const specifier = m[2];
        const names = m[1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const requires = names.map((n) => {
          const parts = n.split(/\s+as\s+/);
          const orig = parts[0].trim();
          const alias = parts[1]?.trim() ?? orig;
          return `const ${alias} = require("${specifier}").${orig};`;
        });
        return indent + requires.join(" ");
      }

      // import defaultExport from 'module'
      m = trimmed.match(/^import\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?\s*$/);
      if (m) {
        return `${indent}const ${m[1]} = require("${m[2]}");`;
      }

      // import * as ns from 'module'
      m = trimmed.match(
        /^import\s*\*\s*as\s+(\w+)\s+from\s*['"]([^'"]+)['"]\s*;?\s*$/,
      );
      if (m) {
        return `${indent}const ${m[1]} = require("${m[2]}");`;
      }

      // import 'module' (side-effect)
      m = trimmed.match(/^import\s*['"]([^'"]+)['"]\s*;?\s*$/);
      if (m) {
        return `${indent}require("${m[1]}");`;
      }

      return line;
    })
    .join("\n");
}

function transpile(code: string): string {
  const rewritten = rewriteImports(code);
  const wrapped = `(async () => {\n${rewritten}\n})()`;
  const result = transformSync(wrapped, {
    loader: "ts",
    target: "es2022",
    format: "cjs",
    platform: "node",
    sourcemap: "inline",
    tsconfigRaw: JSON.stringify({
      compilerOptions: {
        strict: false,
        esModuleInterop: true,
      },
    }),
  });
  return result.code;
}

function parseTypeErrors(diagnosticText: string): ExecutionError[] {
  const errors: ExecutionError[] = [];
  const lines = diagnosticText.split("\n");
  for (const line of lines) {
    const match = line.match(/^.*?\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.+)$/);
    if (match) {
      errors.push({
        line: parseInt(match[1], 10),
        message: `${match[2]}: ${match[3]}`,
      });
    }
  }
  // Fallback: if no structured errors parsed, return the whole text
  if (errors.length === 0 && diagnosticText.trim()) {
    errors.push({ line: 0, message: diagnosticText.trim() });
  }
  return errors;
}

// --- Shared helpers ---

export function truncateLogs(logs: string[], maxSize: number): string[] {
  if (maxSize <= 0) return logs;
  let totalSize = logs.reduce((sum, l) => sum + l.length, 0);
  const result = [...logs];
  while (totalSize > maxSize && result.length > 1) {
    const last = result.pop()!;
    totalSize -= last.length;
  }
  if (totalSize > maxSize && result.length > 0) {
    return [`${result[0].slice(0, maxSize)}\n... (truncated)`];
  }
  return result;
}

// Re-export for cleanup on extension unload
export { disposeSandbox };

// --- Execute ---

export async function executeCode(
  code: string,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  const {
    cwd,
    timeout = 30_000,
    maxOutputSize = 100_000,
    sandboxed = false,
  } = options;

  // Type-check with real TS compiler if typeDefs provided (both paths)
  if (options.typeDefs) {
    const tcResult = typeCheck(rewriteImports(code), options.typeDefs);
    if (tcResult.errors.length > 0) {
      return {
        success: false,
        errorKind: "type",
        errors: tcResult.errors.map((e: TypeCheckError) => ({
          line: e.line,
          message: e.message,
        })),
        logs: [],
        elapsedMs: 0,
      };
    }
  }

  // Transpile TS → JS before routing (sandbox and unsandboxed both need this)
  let transpiledCode: string;
  try {
    transpiledCode = transpile(code);
  } catch (err: any) {
    const errors = parseTypeErrors(err.message || String(err));
    return {
      success: false,
      errorKind: "type",
      errors:
        errors.length > 0
          ? errors
          : [{ line: 0, message: err.message || "Transpilation failed" }],
      logs: [],
      elapsedMs: 0,
    };
  }

  // Route through secure-exec V8 isolate sandbox when requested
  if (sandboxed) {
    return executeInSandbox(transpiledCode, {
      cwd,
      timeout,
      maxOutputSize,
      userPackages: options.userPackages,
    });
  }

  // Unsandboxed AsyncFunction path
  return executeUnsandboxed(code, options);
}

async function executeUnsandboxed(
  code: string,
  options: ExecutionOptions,
): Promise<ExecutionResult> {
  const {
    cwd,
    timeout: _timeout = 30_000,
    maxOutputSize = 100_000,
    signal: _signal,
    shellPrefix,
    userPackages = {},
  } = options;

  const start = performance.now();
  const logs: string[] = [];

  // Transpile TS → JS
  let jsCode: string;
  try {
    jsCode = transpile(code);
  } catch (err: any) {
    const elapsedMs = performance.now() - start;
    const errors = parseTypeErrors(err.message || String(err));
    return {
      success: false,
      errorKind: "type",
      errors:
        errors.length > 0
          ? errors
          : [{ line: 0, message: err.message || "Transpilation failed" }],
      logs: [],
      elapsedMs,
    };
  }

  // 2. Build execution globals
  const print = (...args: unknown[]) => {
    const text = args
      .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 2)))
      .join(" ");
    logs.push(text);
  };

  const consoleProxy = {
    log: (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    },
    warn: (...args: unknown[]) => {
      logs.push(`[warn] ${args.map(String).join(" ")}`);
    },
    error: (...args: unknown[]) => {
      logs.push(`[error] ${args.map(String).join(" ")}`);
    },
    info: (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    },
    debug: (...args: unknown[]) => {
      logs.push(`[debug] ${args.map(String).join(" ")}`);
    },
  };

  // Set up zx $ with cwd and optional shell prefix
  const $local = $({ cwd });
  if (shellPrefix) {
    $.prefix = shellPrefix;
  }

  // Build global scope
  const execGlobals: Record<string, unknown> = {
    $: $local,
    $local,
    print,
    console: consoleProxy,
    require: nodeRequire,
    process,
    Buffer,
    __filename: undefined,
    __dirname: undefined,
    ...userPackages,
  };

  // 3. Execute in AsyncFunction sandbox
  const globalKeys = Object.keys(execGlobals);
  const globalValues = Object.values(execGlobals);

  const wrappedCode = `"use strict";\nreturn ${jsCode};`;

  let returnValue: unknown;
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    const fn = new AsyncFunction(...globalKeys, wrappedCode);
    returnValue = await fn(...globalValues);
  } catch (err: any) {
    const elapsedMs = performance.now() - start;
    return {
      success: false,
      errorKind: "runtime",
      errors: [{ line: 0, message: err.message || "Runtime error" }],
      logs,
      elapsedMs,
    };
  }

  const elapsedMs = performance.now() - start;

  // 4. Truncate logs if needed
  const finalLogs = truncateLogs(logs, maxOutputSize);

  return {
    success: true,
    errors: [],
    logs: finalLogs,
    returnValue,
    elapsedMs,
  };
}
