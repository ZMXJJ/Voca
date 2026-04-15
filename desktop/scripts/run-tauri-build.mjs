import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const releaseRoot = path.join(desktopRoot, "src-tauri", "target", "release");
const localTauriCliPath = path.join(desktopRoot, "node_modules", "@tauri-apps", "cli", "tauri.js");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function capture(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      stderr ? `Command failed: ${command} ${args.join(" ")}\n${stderr}` : `Command failed: ${command} ${args.join(" ")}`,
    );
  }

  return result.stdout.trim();
}

function cleanTauriStaging() {
  const cleanupTargets = ["_up_", "bundle"].map((name) => path.join(releaseRoot, name));

  for (const targetPath of cleanupTargets) {
    if (!existsSync(targetPath)) {
      continue;
    }
    rmSync(targetPath, { recursive: true, force: true });
    console.log(`Removed stale Tauri staging: ${path.relative(desktopRoot, targetPath)}`);
  }
}

function resolveMacBuildEnv() {
  if (process.platform !== "darwin") {
    return {};
  }

  const sdkRoot = capture("xcrun", ["--sdk", "macosx", "--show-sdk-path"]);
  const existingCPath = process.env.CPATH?.trim();

  return {
    SDKROOT: sdkRoot,
    CPATH: existingCPath ? `${sdkRoot}/usr/include:${existingCPath}` : `${sdkRoot}/usr/include`,
  };
}

function resolveTauriInvocation() {
  if (existsSync(localTauriCliPath)) {
    return {
      command: process.execPath,
      argsPrefix: [localTauriCliPath],
    };
  }

  return {
    command: "npx",
    argsPrefix: ["tauri"],
  };
}

function main() {
  cleanTauriStaging();

  const env = {
    ...process.env,
    ...resolveMacBuildEnv(),
  };
  const invocation = resolveTauriInvocation();
  const tauriArgs = [...invocation.argsPrefix, "build", ...process.argv.slice(2)];

  run(invocation.command, tauriArgs, {
    cwd: desktopRoot,
    env,
  });
}

main();
