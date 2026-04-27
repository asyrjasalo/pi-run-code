import { test } from "bun:test";
import assert from "node:assert/strict";
import { executeCode } from "../src/executor.js";

const cwd = process.cwd();

test("sandboxed: executes simple JS expression", async () => {
  const result = await executeCode('console.log("hello sandbox");', {
    cwd,
    sandboxed: true,
  });
  assert.equal(result.success, true);
  assert.ok(result.logs.length > 0);
  assert.ok(result.logs.some((l) => l.includes("hello sandbox")));
});

test("sandboxed: captures multiple console.log calls", async () => {
  const result = await executeCode(
    'console.log("line1"); console.log("line2");',
    { cwd, sandboxed: true },
  );
  assert.equal(result.success, true);
  assert.ok(result.logs.length >= 2);
});

test("sandboxed: return values work", async () => {
  const result = await executeCode('return "hello";', {
    cwd,
    sandboxed: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.returnValue, "hello");
});

test("sandboxed: return numeric values", async () => {
  const result = await executeCode("return 2 + 3;", {
    cwd,
    sandboxed: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.returnValue, 5);
});

test("sandboxed: print() outputs to logs", async () => {
  const result = await executeCode('print("from print");', {
    cwd,
    sandboxed: true,
  });
  assert.equal(result.success, true);
  assert.ok(result.logs.some((l) => l.includes("from print")));
});

test("sandboxed: $ shell shim works", async () => {
  const result = await executeCode(
    "const out = await $`echo hello`; return out.stdout.trim();",
    { cwd, sandboxed: true },
  );
  assert.equal(result.success, true);
  assert.equal(result.returnValue, "hello");
});

test("sandboxed: require('fs') reads real files", async () => {
  const result = await executeCode(
    `const fs = require("fs");
     const pkg = JSON.parse(fs.readFileSync("${cwd}/package.json", "utf8"));
     return pkg.name;`,
    { cwd, sandboxed: true },
  );
  assert.equal(result.success, true);
  assert.equal(result.returnValue, "pi-run-code");
});

test("sandboxed: require('child_process') works", async () => {
  const result = await executeCode(
    'const { execSync } = require("child_process"); return execSync("echo hi").toString().trim();',
    { cwd, sandboxed: true },
  );
  assert.equal(result.success, true);
  assert.equal(result.returnValue, "hi");
});

test("sandboxed: process.env has real values", async () => {
  const result = await executeCode("return typeof process.env.PATH;", {
    cwd,
    sandboxed: true,
  });
  assert.equal(result.success, true);
  assert.equal(result.returnValue, "string");
});

test("sandboxed: reports runtime error on throw", async () => {
  const result = await executeCode('throw new Error("boom");', {
    cwd,
    sandboxed: true,
  });
  assert.equal(result.success, false);
  assert.equal(result.errorKind, "runtime");
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0].message.includes("boom"));
});

test("sandboxed: TS types are transpiled", async () => {
  const result = await executeCode(
    `interface Foo { x: number; y: string }
     const foo: Foo = { x: 1, y: "bar" };
     return foo.y;`,
    { cwd, sandboxed: true },
  );
  assert.equal(result.success, true);
  assert.equal(result.returnValue, "bar");
});

test("sandboxed: truncates output beyond maxOutputSize", async () => {
  const bigStr = "x".repeat(2000);
  const result = await executeCode(
    `console.log("${bigStr}"); console.log("${bigStr}");`,
    { cwd, sandboxed: true, maxOutputSize: 1000 },
  );
  assert.equal(result.success, true);
  const totalSize = result.logs.reduce((sum, l) => sum + l.length, 0);
  assert.ok(totalSize <= 1100, `Expected <=1100, got ${totalSize}`);
});
