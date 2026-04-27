import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeCode } from "../src/executor.js";

const cwd = process.cwd();

test("returns value from simple expression", async () => {
  const result = await executeCode("return 1 + 1", { cwd });
  assert.equal(result.success, true);
  assert.equal(result.returnValue, 2);
  assert.equal(result.errors.length, 0);
});

test("captures console.log output", async () => {
  const result = await executeCode('console.log("hello"); return "ok";', {
    cwd,
  });
  assert.equal(result.success, true);
  assert.deepEqual(result.logs, ["hello"]);
  assert.equal(result.returnValue, "ok");
});

test("captures print() output", async () => {
  const result = await executeCode('print("from print"); return undefined;', {
    cwd,
  });
  assert.equal(result.success, true);
  assert.ok(result.logs.includes("from print"));
});

test("captures console.warn with prefix", async () => {
  const result = await executeCode('console.warn("careful");', { cwd });
  assert.equal(result.success, true);
  assert.ok(result.logs[0].includes("[warn]"));
});

test("captures console.error with prefix", async () => {
  const result = await executeCode('console.error("boom");', { cwd });
  assert.equal(result.success, true);
  assert.ok(result.logs[0].includes("[error]"));
});

test("strips TS types via esbuild (no type checking)", async () => {
  const result = await executeCode("const x: number = 1; return x;", { cwd });
  assert.equal(result.success, true);
  assert.equal(result.returnValue, 1);
});

test("returns transpile error for invalid syntax", async () => {
  const result = await executeCode("function (", { cwd });
  assert.equal(result.success, false);
  assert.ok(result.errors.length > 0);
});

test("returns runtime error for thrown exception", async () => {
  const result = await executeCode('throw new Error("kaboom");', { cwd });
  assert.equal(result.success, false);
  assert.equal(result.errorKind, "runtime");
  assert.ok(result.errors[0].message.includes("kaboom"));
});

test("supports async/await", async () => {
  const result = await executeCode(
    "const val = await Promise.resolve(42); return val;",
    { cwd },
  );
  assert.equal(result.success, true);
  assert.equal(result.returnValue, 42);
});

test("supports zx $ for shell commands", async () => {
  const result = await executeCode(
    "const out = await $`echo hello`; return out.stdout.trim();",
    { cwd },
  );
  assert.equal(result.success, true);
  assert.equal(result.returnValue, "hello");
});

test("supports TS types (interface, type alias)", async () => {
  const code = `
    interface Foo { x: number; y: string }
    const foo: Foo = { x: 1, y: "bar" };
    return foo.y;
  `;
  const result = await executeCode(code, { cwd });
  assert.equal(result.success, true);
  assert.equal(result.returnValue, "bar");
});

test("has require available", async () => {
  const result = await executeCode(
    'const path = require("path"); return path.sep;',
    { cwd },
  );
  assert.equal(result.success, true);
  assert.equal(result.returnValue, "/");
});

test("elapsedMs is populated", async () => {
  const result = await executeCode("return 1", { cwd });
  assert.equal(result.success, true);
  assert.ok(result.elapsedMs >= 0);
});

test("user packages injected as globals", async () => {
  const result = await executeCode("return myPkg.value;", {
    cwd,
    userPackages: { myPkg: { value: 99 } },
  });
  assert.equal(result.success, true);
  assert.equal(result.returnValue, 99);
});

test("transpiles ESM import to CJS require", async () => {
  const code = `
    import { join } from "path";
    return join("a", "b");
  `;
  const result = await executeCode(code, { cwd });
  assert.equal(result.success, true);
  assert.equal(result.returnValue, "a/b");
});

test("transpiles ESM named import from Node built-in", async () => {
  const code = `
    import { readdirSync } from "fs";
    const files = readdirSync(process.cwd());
    return Array.isArray(files);
  `;
  const result = await executeCode(code, { cwd });
  assert.equal(result.success, true);
  assert.equal(result.returnValue, true);
});

test("transpiles ESM import with top-level await", async () => {
  const code = `
    import { basename } from "path";
    const name = basename(process.cwd());
    return name;
  `;
  const result = await executeCode(code, { cwd });
  assert.equal(result.success, true);
  assert.equal(typeof result.returnValue, "string");
  assert.ok((result.returnValue as string).length > 0);
});

test("ESM imports pass type-check when typeDefs provided", async () => {
  const typeDefs = `
interface FileInfo { name: string; path: string }
declare const cwd: string;
`;
  const code = `
    import { join } from "path";
    import { readdirSync } from "fs";
    const files: string[] = readdirSync(process.cwd());
    return files.length > 0;
  `;
  const result = await executeCode(code, { cwd, typeDefs });
  assert.equal(result.success, true);
  assert.equal(result.returnValue, true);
});

test("truncates output when maxOutputSize exceeded", async () => {
  const bigStr = "x".repeat(2000);
  const result = await executeCode(
    `console.log("${bigStr}"); console.log("${bigStr}");`,
    { cwd, maxOutputSize: 1000 },
  );
  assert.equal(result.success, true);
  assert.ok(result.logs.length <= 2);
});

test("zx $ respects cwd for shell commands", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "pi-run-code-test-"));
  try {
    writeFileSync(join(tmpDir, "test.txt"), "content");
    const result = await executeCode(
      "const out = await $`ls`; return out.stdout.trim();",
      { cwd: tmpDir },
    );
    assert.equal(result.success, true);
    assert.equal(result.returnValue, "test.txt");
  } finally {
    rmSync(tmpDir, { recursive: true });
  }
});
