// index.ts — Pi Run Code extension entry point.
//
// Adds a `run_code` tool that executes TypeScript code.
// Does NOT replace or disable any existing Pi tools.
//
// Execution modes:
// - **Sandboxed (default)**: Code runs inside a secure-exec V8 isolate
//   with deny-by-default permissions (no fs, no network, no child processes).
// - **Unsandboxed**: Set PI_RUN_CODE_UNSANDBOXED=1 to use the
//   AsyncFunction path with full host access (zx shell, require, etc.).

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { disposeSandbox } from "./executor.js";
import { loadUserPackages, type ResolvedPackage } from "./package-resolver.js";
import { piRunCodeUnsandboxedAcknowledged } from "./pi-run-code-env.js";
import { createRunCodeTool, type RunCodeToolOptions } from "./run-code-tool.js";
import { initTypeChecker, loadPackageTypes } from "./type-checker.js";
import {
  generateBuiltinTypeDefs,
  generatePackageTypeDefs,
} from "./type-generator.js";

export default function runCodeExtension(pi: ExtensionAPI) {
  const unsandboxed = piRunCodeUnsandboxedAcknowledged(
    process.env.PI_RUN_CODE_UNSANDBOXED,
  );

  if (unsandboxed) {
    console.warn(
      "pi-run-code: running in UNSANDBOXED mode — code has full host access.",
    );
  }
  let userPackages: ResolvedPackage[] = [];
  let userPackageMap: Record<string, unknown> = {};
  try {
    const { packages, warnings } = loadUserPackages(process.cwd());
    userPackages = packages;
    userPackageMap = Object.fromEntries(
      packages.map((p) => [p.varName, p.module]),
    );
    for (const w of warnings) {
      console.warn(`Run Code: ${w}`);
    }
  } catch (e: any) {
    console.warn(`Run Code: Failed to load user packages: ${e.message}`);
  }

  initTypeChecker();

  const packagesWithTypes = userPackages.filter((p) => p.hasTypes);
  if (packagesWithTypes.length > 0) {
    loadPackageTypes(packagesWithTypes);
  }

  const typeDefs = `${generateBuiltinTypeDefs()}\n${generatePackageTypeDefs(userPackages)}`;

  let shellPrefix: string | undefined;
  try {
    const settings = SettingsManager.create();
    shellPrefix = settings.getShellCommandPrefix();
  } catch {}

  const packageDescriptions = userPackages
    .map(
      (p) =>
        `- ${p.varName} (${p.specifier}@${p.versionRange}): ${p.description}`,
    )
    .join("\n");

  const toolOptions: RunCodeToolOptions = {
    cwd: process.cwd(),
    shellPrefix,
    userPackages: userPackageMap,
    packageDescriptions,
    typeDefs,
    sandboxed: !unsandboxed,
  };

  pi.registerTool(createRunCodeTool(toolOptions));

  // Cleanup sandbox runtime on process exit
  process.on("exit", () => {
    disposeSandbox();
  });
}
