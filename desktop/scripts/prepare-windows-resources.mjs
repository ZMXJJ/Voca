/**
 * Prepare Voca's Windows bundle resources (x86_64-pc-windows-msvc).
 *
 * Mirrors scripts/prepare-dmg-resources.mjs but:
 *   - Uses `uv python install` to fetch a python-build-standalone distribution.
 *   - Builds a lean sidecar venv; CUDA torch is downloaded during first-run bootstrap.
 *   - Skips codesigning, FFmpeg dylib bundling, and symlink materialization.
 *
 * Output directory: desktop/.bundle-resources-win/
 *   - python-runtime/  (python-build-standalone distribution)
 *   - python-service/app/
 *   - python-service/.venv/
 *   - VoxCPM/src/
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const stageRoot = path.join(desktopRoot, ".bundle-resources-win");
const pythonServiceRoot = path.join(desktopRoot, "python-service");
const voxcpmSrcRoot = path.join(repoRoot, "VoxCPM", "src");
const runtimeRequirementsPath = path.join(pythonServiceRoot, "requirements.runtime.txt");
const runtimeRequirementsWinPath = path.join(pythonServiceRoot, "requirements.runtime.windows.txt");
const pythonRuntimeCacheRoot = path.join(desktopRoot, ".cache", "python-runtime-win");
const stageServiceRoot = path.join(stageRoot, "python-service");
const stageVenvRoot = path.join(stageServiceRoot, ".venv");
const stageRuntimeRoot = path.join(stageRoot, "python-runtime");

const PYTHON_VERSION_SPEC = process.env.VOCA_PYTHON_VERSION?.trim() || "3.11";
function ensureExists(targetPath, label) {
  if (!existsSync(targetPath)) {
    throw new Error(`${label} does not exist: ${targetPath}`);
  }
}

function copyDirectory(sourcePath, destinationPath, options = {}) {
  ensureExists(sourcePath, "Source path");
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    preserveTimestamps: true,
    dereference: options.dereference ?? true,
  });
}

function runCommand(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
    shell: process.platform === "win32" && /\.(cmd|bat)$/i.test(command),
  });
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(" ")}`);
  }
}

function runCommandCapture(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(
      stderr
        ? `Command failed: ${command} ${args.join(" ")}\n${stderr}`
        : `Command failed: ${command} ${args.join(" ")}`,
    );
  }
  return result.stdout.trim();
}

function resolveUvBinary() {
  const candidates = [process.env.UV_BIN, "uv"].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (result.status === 0) {
      return candidate;
    }
  }
  throw new Error("uv is required to prepare the Windows Python runtime. Install uv and/or set UV_BIN.");
}

function installPythonRuntime(uv) {
  mkdirSync(pythonRuntimeCacheRoot, { recursive: true });

  const uvEnv = {
    UV_PYTHON_INSTALL_DIR: pythonRuntimeCacheRoot,
    UV_MANAGED_PYTHON: "1",
  };

  runCommand(uv, ["python", "install", PYTHON_VERSION_SPEC], uvEnv);

  const installed = runCommandCapture(
    uv,
    ["python", "find", "--managed-python", PYTHON_VERSION_SPEC],
    uvEnv,
  );

  const trimmed = installed.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
  if (trimmed.length === 0) {
    throw new Error("uv python find returned no interpreters");
  }
  return trimmed[0];
}

function findRuntimeRoot(pythonExecutable) {
  let candidate = path.dirname(pythonExecutable);
  for (let i = 0; i < 4; i += 1) {
    const marker = path.join(candidate, "python.exe");
    if (existsSync(marker) || existsSync(path.join(candidate, "Scripts", "python.exe"))) {
      return candidate;
    }
    candidate = path.resolve(candidate, "..");
  }
  return path.dirname(pythonExecutable);
}

function buildReleaseVenv(runtimePythonPath) {
  const uv = resolveUvBinary();

  runCommand(uv, ["venv", "--python", runtimePythonPath, stageVenvRoot], {
    UV_LINK_MODE: "copy",
  });

  const stagePythonPath = path.join(stageVenvRoot, "Scripts", "python.exe");

  runCommand(
    uv,
    [
      "pip",
      "install",
      "--python",
      stagePythonPath,
      "-r",
      runtimeRequirementsPath,
      "-r",
      runtimeRequirementsWinPath,
    ],
    {
      UV_LINK_MODE: "copy",
    },
  );

  return stagePythonPath;
}

function stripVenvForRelease() {
  const sitePackagesRoot = path.join(stageVenvRoot, "Lib", "site-packages");
  if (!existsSync(sitePackagesRoot)) return;

  // Keep .dist-info directories: transformers reads dependency metadata via
  // importlib.metadata.version() during import, and pruning metadata breaks
  // the packaged runtime with PackageNotFoundError for transitive deps such
  // as tqdm.
  //
  // Also prune modelscope's msdatasets subtree: it contains deeply-nested
  // CV/NLP dataset classes (e.g. image_quality_assessment_degradation) that
  // exceed Windows MAX_PATH during NSIS packaging and are not used by Voca's
  // TTS runtime.
  const prunePatterns = [/^__pycache__$/, /^tests$/, /^test$/, /^msdatasets$/];
  const stack = [sitePackagesRoot];
  let freedBytes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      if (prunePatterns.some((re) => re.test(entry.name))) {
        try {
          rmSync(fullPath, { recursive: true, force: true });
          freedBytes += 1;
        } catch {
          /* best effort */
        }
      } else {
        stack.push(fullPath);
      }
    }
  }
  console.log(`- pruned ${freedBytes} cache/test directories from site-packages`);
}

function stripRuntimeForRelease() {
  if (!existsSync(stageRuntimeRoot)) return;
  const prunable = ["tcl", "Tools", "test", "Tests", "Doc"];
  for (const item of prunable) {
    const target = path.join(stageRuntimeRoot, item);
    if (existsSync(target)) {
      try {
        rmSync(target, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
}

async function main() {
  ensureExists(path.join(pythonServiceRoot, "app"), "Python service app directory");
  ensureExists(voxcpmSrcRoot, "VoxCPM src directory");
  ensureExists(runtimeRequirementsPath, "Runtime requirements file");
  ensureExists(runtimeRequirementsWinPath, "Windows runtime requirements file");

  const uv = resolveUvBinary();

  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });
  mkdirSync(stageServiceRoot, { recursive: true });

  console.log(`Installing python-build-standalone (${PYTHON_VERSION_SPEC})…`);
  const runtimePythonPath = installPythonRuntime(uv);
  const runtimeRoot = findRuntimeRoot(runtimePythonPath);
  console.log(`- runtime python: ${runtimePythonPath}`);
  console.log(`- runtime root:   ${runtimeRoot}`);

  console.log("Copying python runtime into stage…");
  copyDirectory(runtimeRoot, stageRuntimeRoot, { dereference: true });

  console.log("Building release venv (bootstrap downloads CUDA runtime later)…");
  const stagePythonPath = buildReleaseVenv(runtimePythonPath);

  console.log("Copying app/ and VoxCPM sources…");
  copyDirectory(path.join(pythonServiceRoot, "app"), path.join(stageServiceRoot, "app"));
  copyDirectory(voxcpmSrcRoot, path.join(stageRoot, "VoxCPM", "src"));

  console.log("Pruning bundle…");
  stripVenvForRelease();
  stripRuntimeForRelease();

  writeFileSync(
    path.join(stageServiceRoot, "manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        platform: "windows-x86_64",
        runtimePythonPath,
        runtimeRoot,
        pythonServiceRoot,
        runtimeRequirementsPath,
        runtimeRequirementsWinPath,
        stagePythonPath,
        voxcpmSrcRoot,
        torchBackend: "bootstrap-download",
      },
      null,
      2,
    ),
  );

  console.log("Prepared Windows bundle resources:");
  console.log(`- staged root:          ${stageRoot}`);
  console.log(`- python runtime stage: ${stageRuntimeRoot}`);
  console.log(`- release venv:         ${stageVenvRoot}`);
  console.log(`- runtime requirements: ${runtimeRequirementsPath}`);
  console.log(`- VoxCPM src:           ${voxcpmSrcRoot}`);
}

await main();
