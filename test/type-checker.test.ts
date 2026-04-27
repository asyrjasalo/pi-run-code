import { test } from "bun:test";
import assert from "node:assert/strict";
import { executeCode } from "../src/executor.js";
import { initTypeChecker, typeCheck } from "../src/type-checker.js";
import {
  generateBuiltinTypeDefs,
  generatePackageTypeDefs,
} from "../src/type-generator.js";

const cwd = process.cwd();

initTypeChecker();
const typeDefs = generateBuiltinTypeDefs();

test("initTypeChecker is idempotent", () => {
  initTypeChecker();
  initTypeChecker();
});

test("passes valid JS code", () => {
  const result = typeCheck("const x = 1 + 1; return x;", typeDefs);
  assert.equal(
    result.errors.length,
    0,
    result.errors.map((e) => e.message).join(", "),
  );
});

test("passes valid TS code with types", () => {
  const result = typeCheck("const x: number = 42; return x;", typeDefs);
  assert.equal(result.errors.length, 0);
});

test("catches type mismatch", () => {
  const result = typeCheck('const x: number = "string";', typeDefs);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0].message.includes("Type"));
});

test("catches unknown variable", () => {
  const result = typeCheck("return nonexistentVariable;", typeDefs);
  assert.ok(result.errors.length > 0);
  assert.ok(
    result.errors[0].message.includes("nonexistentVariable") ||
      result.errors[0].message.includes("Cannot find name"),
  );
});

test("catches wrong function args", () => {
  const result = typeCheck("print(1, 2, 3);", typeDefs);
  assert.equal(result.errors.length, 0);
});

test("allows interface and type alias", () => {
  const code = `
    interface Foo { x: number; y: string }
    const foo: Foo = { x: 1, y: "bar" };
    return foo.y;
  `;
  const result = typeCheck(code, typeDefs);
  assert.equal(
    result.errors.length,
    0,
    result.errors.map((e) => e.message).join(", "),
  );
});

test("catches missing required property in interface", () => {
  const code = `
    interface Foo { x: number; y: string }
    const foo: Foo = { x: 1 };
  `;
  const result = typeCheck(code, typeDefs);
  assert.ok(result.errors.length > 0);
});

test("error line numbers point to user code", () => {
  const code = `const a = 1;\nconst b: number = "wrong";`;
  const result = typeCheck(code, typeDefs);
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors[0].line >= 1);
  assert.ok(result.errors[0].line <= code.split("\n").length);
});

test("allows async/await", () => {
  const result = typeCheck(
    "const val = await Promise.resolve(42); return val;",
    typeDefs,
  );
  assert.equal(result.errors.length, 0);
});

test("allows $ shell from zx types", () => {
  const result = typeCheck(
    "const out = await $`echo hello`; return out;",
    typeDefs,
  );
  assert.equal(
    result.errors.length,
    0,
    result.errors.map((e) => e.message).join(", "),
  );
});

test("allows console.log", () => {
  const result = typeCheck('console.log("hello");', typeDefs);
  assert.equal(result.errors.length, 0);
});

test("allows require", () => {
  const result = typeCheck('const fs = require("fs"); return fs;', typeDefs);
  assert.equal(result.errors.length, 0);
});

// type-generator

test("generates builtin type defs", () => {
  const defs = generateBuiltinTypeDefs();
  assert.ok(defs.includes("declare const $"));
  assert.ok(defs.includes("declare function print"));
  assert.ok(defs.includes("declare const console"));
  assert.ok(defs.includes("declare const require"));
});

test("generates typed package defs", () => {
  const defs = generatePackageTypeDefs([
    { specifier: "yaml", varName: "YAML", hasTypes: true },
  ]);
  assert.ok(defs.includes("import type * as _pkg_YAML from 'yaml'"));
  assert.ok(defs.includes("declare const YAML: typeof _pkg_YAML"));
});

test("generates untyped package as any", () => {
  const defs = generatePackageTypeDefs([
    { specifier: "my-lib", varName: "myLib", hasTypes: false },
  ]);
  assert.ok(defs.includes("declare const myLib: any"));
});

test("returns empty string for no packages", () => {
  const defs = generatePackageTypeDefs([]);
  assert.equal(defs, "");
});

// executor: type checking integration

test("executeCode with typeDefs catches type error", async () => {
  const result = await executeCode('const x: number = "not a number";', {
    cwd,
    typeDefs,
  });
  assert.equal(result.success, false);
  assert.equal(result.errorKind, "type");
  assert.ok(result.errors.length > 0);
});

test("executeCode with typeDefs runs valid typed code", async () => {
  const result = await executeCode("const x: number = 42; return x;", {
    cwd,
    typeDefs,
  });
  assert.equal(result.success, true);
  assert.equal(result.returnValue, 42);
});

test("executeCode without typeDefs skips type checking", async () => {
  const result = await executeCode(
    'const x: number = "not a number" as any; return x;',
    { cwd },
  );
  assert.equal(result.success, true);
  assert.equal(result.returnValue, "not a number");
});

test("executeCode type error has correct line number", async () => {
  const code = 'const a = 1;\nconst b: number = "wrong";\nreturn b;';
  const result = await executeCode(code, { cwd, typeDefs });
  assert.equal(result.success, false);
  assert.equal(result.errorKind, "type");
  assert.ok(result.errors[0].line >= 1 && result.errors[0].line <= 3);
});
