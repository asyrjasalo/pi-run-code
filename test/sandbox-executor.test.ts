import assert from "node:assert/strict";
import { executeCode } from "../src/executor.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

function summarize() {
  const total = passed + failed;
  console.log(`\n${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

async function main() {
  console.log("\nsandbox-executor: secure-exec V8 isolate tests");

  await test("sandboxed: executes simple JS expression", async () => {
    const result = await executeCode('console.log("hello sandbox");', {
      cwd: process.cwd(),
      sandboxed: true,
    });
    assert.equal(result.success, true);
    assert.ok(result.logs.length > 0);
    assert.ok(result.logs.some((l) => l.includes("hello sandbox")));
  });

  await test("sandboxed: captures multiple console.log calls", async () => {
    const result = await executeCode(
      'console.log("line1"); console.log("line2");',
      { cwd: process.cwd(), sandboxed: true },
    );
    assert.equal(result.success, true);
    assert.ok(result.logs.length >= 2);
  });

  await test("sandboxed: return values work via export default", async () => {
    const result = await executeCode('return "hello";', {
      cwd: process.cwd(),
      sandboxed: true,
    });
    assert.equal(result.success, true);
    assert.equal(result.returnValue, "hello");
  });

  await test("sandboxed: return numeric values", async () => {
    const result = await executeCode("return 2 + 3;", {
      cwd: process.cwd(),
      sandboxed: true,
    });
    assert.equal(result.success, true);
    assert.equal(result.returnValue, 5);
  });

  await test("sandboxed: print() outputs to logs", async () => {
    const result = await executeCode('print("from print");', {
      cwd: process.cwd(),
      sandboxed: true,
    });
    assert.equal(result.success, true);
    assert.ok(result.logs.some((l) => l.includes("from print")));
  });

  await test("sandboxed: $ shell shim works", async () => {
    const result = await executeCode(
      "const out = await $`echo hello`; return out.stdout.trim();",
      {
        cwd: process.cwd(),
        sandboxed: true,
      },
    );
    assert.equal(result.success, true);
    assert.equal(result.returnValue, "hello");
  });

  await test("sandboxed: require('fs') reads real files", async () => {
    const result = await executeCode(
      `const fs = require("fs");
       const pkg = JSON.parse(fs.readFileSync("${process.cwd()}/package.json", "utf8"));
       return pkg.name;`,
      { cwd: process.cwd(), sandboxed: true },
    );
    assert.equal(result.success, true);
    assert.equal(result.returnValue, "pi-run-code");
  });

  await test("sandboxed: require('child_process') works", async () => {
    const result = await executeCode(
      'const { execSync } = require("child_process"); return execSync("echo hi").toString().trim();',
      { cwd: process.cwd(), sandboxed: true },
    );
    assert.equal(result.success, true);
    assert.equal(result.returnValue, "hi");
  });

  await test("sandboxed: process.env has real values", async () => {
    const result = await executeCode("return typeof process.env.PATH;", {
      cwd: process.cwd(),
      sandboxed: true,
    });
    assert.equal(result.success, true);
    assert.equal(result.returnValue, "string");
  });

  await test("sandboxed: reports runtime error on throw", async () => {
    const result = await executeCode('throw new Error("boom");', {
      cwd: process.cwd(),
      sandboxed: true,
    });
    assert.equal(result.success, false);
    assert.equal(result.errorKind, "runtime");
    assert.ok(result.errors.length > 0);
    assert.ok(result.errors[0].message.includes("boom"));
  });

  await test("sandboxed: TS types are transpiled", async () => {
    const result = await executeCode(
      `interface Foo { x: number; y: string }
       const foo: Foo = { x: 1, y: "bar" };
       return foo.y;`,
      { cwd: process.cwd(), sandboxed: true },
    );
    assert.equal(result.success, true);
    assert.equal(result.returnValue, "bar");
  });

  await test("sandboxed: truncates output beyond maxOutputSize", async () => {
    const bigStr = "x".repeat(2000);
    const result = await executeCode(
      `console.log("${bigStr}"); console.log("${bigStr}");`,
      { cwd: process.cwd(), sandboxed: true, maxOutputSize: 1000 },
    );
    assert.equal(result.success, true);
    const totalSize = result.logs.reduce((sum, l) => sum + l.length, 0);
    assert.ok(totalSize <= 1100, `Expected <=1100, got ${totalSize}`);
  });

  summarize();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
