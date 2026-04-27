#!/usr/bin/env node

const { buildSync } = require("esbuild");
const path = require("node:path");
const fs = require("node:fs");

fs.mkdirSync(path.join(__dirname, ".cache"), { recursive: true });

const files = [
  "executor.test.ts",
  "sandbox-executor.test.ts",
  "package-resolver.test.ts",
  "type-checker.test.ts",
  "pi-run-code-env.test.ts",
];

for (const file of files) {
  const src = path.join(__dirname, file);
  if (!fs.existsSync(src)) continue;
  const outfile = path.join(__dirname, ".cache", file.replace(".ts", ".cjs"));

  buildSync({
    entryPoints: [src],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "es2022",
    outfile,
    packages: "bundle",
    external: [
      "esbuild",
      "typescript",
      "zx",
      "secure-exec",
      "@secure-exec/core",
      "@secure-exec/nodejs",
    ],
    sourcemap: "inline",
    logLevel: "error",
  });

  require(outfile);
}
