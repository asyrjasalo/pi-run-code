import { test } from "bun:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserPackages } from "../src/package-resolver.js";

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-pkg-resolver-test-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  return dir;
}

test("returns empty when no config exists", async () => {
  const dir = makeTmpDir();
  try {
    const result = loadUserPackages(dir);
    assert.equal(result.packages.length, 0);
    assert.equal(result.warnings.length, 0);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("installs string shorthand package", async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(
      join(dir, ".pi", "pi-run-code.json"),
      JSON.stringify({
        packages: { "humanize-duration": "*" },
      }),
    );
    const result = loadUserPackages(dir);
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].varName, "humanizeDuration");
    assert.equal(result.packages[0].specifier, "humanize-duration");
    assert.equal(result.packages[0].scope, "project");
    assert.equal(typeof result.packages[0].module, "function");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("installs object config with custom var name", async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(
      join(dir, ".pi", "pi-run-code.json"),
      JSON.stringify({
        packages: {
          yaml: { version: "^2", as: "YAML", description: "YAML parser" },
        },
      }),
    );
    const result = loadUserPackages(dir);
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].varName, "YAML");
    assert.equal(result.packages[0].specifier, "yaml");
    assert.equal(result.packages[0].description, "YAML parser");
    assert.equal(typeof (result.packages[0].module as any).parse, "function");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("detects @types for installed package", async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(
      join(dir, ".pi", "pi-run-code.json"),
      JSON.stringify({
        packages: { "humanize-duration": "*" },
      }),
    );
    const result = loadUserPackages(dir);
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].hasTypes, true);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("skips reinstall when package.json unchanged", async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(
      join(dir, ".pi", "pi-run-code.json"),
      JSON.stringify({
        packages: { "humanize-duration": "*" },
      }),
    );
    loadUserPackages(dir);
    const pkgJsonPath = join(dir, ".pi", "pi-run-code", "package.json");
    assert.ok(existsSync(pkgJsonPath));
    const mtime1 = readFileSync(pkgJsonPath, "utf8");

    loadUserPackages(dir);
    const mtime2 = readFileSync(pkgJsonPath, "utf8");
    assert.equal(mtime1, mtime2);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("reinstalls when config changes", async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(
      join(dir, ".pi", "pi-run-code.json"),
      JSON.stringify({
        packages: { "humanize-duration": "*" },
      }),
    );
    loadUserPackages(dir);

    writeFileSync(
      join(dir, ".pi", "pi-run-code.json"),
      JSON.stringify({
        packages: { yaml: "^2" },
      }),
    );
    const result = loadUserPackages(dir);
    assert.equal(result.packages.length, 1);
    assert.equal(result.packages[0].varName, "yaml");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("description falls back to package.json", async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(
      join(dir, ".pi", "pi-run-code.json"),
      JSON.stringify({
        packages: { "humanize-duration": "*" },
      }),
    );
    const result = loadUserPackages(dir);
    assert.equal(result.packages.length, 1);
    assert.ok(result.packages[0].description.length > 0);
    assert.ok(result.packages[0].description !== "humanize-duration");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("warns on invalid package", async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(
      join(dir, ".pi", "pi-run-code.json"),
      JSON.stringify({
        packages: { "nonexistent-pkg-xyz-999": "^99.99.99" },
      }),
    );
    const result = loadUserPackages(dir);
    assert.equal(result.packages.length, 0);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes("nonexistent-pkg-xyz-999"));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("converts scoped package to var name", async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(
      join(dir, ".pi", "pi-run-code.json"),
      JSON.stringify({
        packages: { "humanize-duration": "*" },
      }),
    );
    const result = loadUserPackages(dir);
    const pkg = result.packages.find(
      (p) => p.specifier === "humanize-duration",
    );
    assert.ok(pkg);
    assert.equal(pkg.varName, "humanizeDuration");
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("handles invalid JSON config", async () => {
  const dir = makeTmpDir();
  try {
    writeFileSync(join(dir, ".pi", "pi-run-code.json"), "not valid json!!!");
    const result = loadUserPackages(dir);
    assert.equal(result.packages.length, 0);
    assert.ok(result.warnings.length > 0);
    assert.ok(result.warnings[0].includes("Failed to parse"));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
