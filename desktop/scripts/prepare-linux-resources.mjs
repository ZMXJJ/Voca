/**
 * Prepare Voca's Linux bundle resources.
 *
 * Output directory: desktop/.bundle-resources-linux/
 *   - python-runtime/  (python-build-standalone distribution)
 *   - python-service/app/
 *   - python-service/.venv/
 *   - VoxCPM/src/
 *
 * Set VOCA_LINUX_ACCELERATOR=nvidia to build a CUDA-enabled bundle. The
 * default CPU bundle uses CPU wheels and CPU ONNX Runtime.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const stageRoot = path.join(desktopRoot, ".bundle-resources-linux");
const pythonServiceRoot = path.join(desktopRoot, "python-service");
const voxcpmSrcRoot = path.join(repoRoot, "VoxCPM", "src");
const runtimeRequirementsPath = path.join(pythonServiceRoot, "requirements.runtime.txt");
const runtimeRequirementsLinuxPath = path.join(pythonServiceRoot, "requirements.runtime.linux.txt");
const runtimeRequirementsLinuxCpuPath = path.join(pythonServiceRoot, "requirements.runtime.linux.cpu.txt");
const runtimeRequirementsLinuxNvidiaPath = path.join(pythonServiceRoot, "requirements.runtime.linux.nvidia.txt");
const runtimeRequirementsLinuxTorchPath = path.join(pythonServiceRoot, "requirements.runtime.linux.torch.txt");
const pythonRuntimeCacheRoot = path.join(desktopRoot, ".cache", "python-runtime-linux");
const stageServiceRoot = path.join(stageRoot, "python-service");
const stageVenvRoot = path.join(stageServiceRoot, ".venv");
const stageRuntimeRoot = path.join(stageRoot, "python-runtime");

const PYTHON_VERSION_SPEC = process.env.VOCA_PYTHON_VERSION?.trim() || "3.11";
const accelerator = (process.env.VOCA_LINUX_ACCELERATOR?.trim().toLowerCase() || "cpu");
const torchIndexUrl =
  process.env.VOCA_LINUX_TORCH_INDEX_URL?.trim() ||
  (accelerator === "nvidia"
    ? "https://download.pytorch.org/whl/cu128"
    : "https://download.pytorch.org/whl/cpu");

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
      stderr ? `Command failed: ${command} ${args.join(" ")}\n${stderr}` : `Command failed: ${command} ${args.join(" ")}`,
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
  throw new Error("uv is required to prepare the Linux Python runtime. Install uv and/or set UV_BIN.");
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
  for (let i = 0; i < 5; i += 1) {
    if (
      existsSync(path.join(candidate, "bin", "python3")) ||
      existsSync(path.join(candidate, "bin", "python"))
    ) {
      return candidate;
    }
    candidate = path.resolve(candidate, "..");
  }
  return path.resolve(path.dirname(pythonExecutable), "..");
}

function linuxModeRequirementsPath() {
  if (accelerator === "cpu") {
    return runtimeRequirementsLinuxCpuPath;
  }
  if (accelerator === "nvidia") {
    return runtimeRequirementsLinuxNvidiaPath;
  }
  throw new Error("VOCA_LINUX_ACCELERATOR must be either 'cpu' or 'nvidia'.");
}

function buildReleaseVenv(runtimePythonPath) {
  const uv = resolveUvBinary();

  runCommand(uv, ["venv", "--python", runtimePythonPath, stageVenvRoot], {
    UV_LINK_MODE: "copy",
  });

  const stagePythonPath = path.join(stageVenvRoot, "bin", "python");
  const modeRequirementsPath = linuxModeRequirementsPath();

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
      runtimeRequirementsLinuxPath,
      "-r",
      modeRequirementsPath,
    ],
    {
      UV_LINK_MODE: "copy",
    },
  );

  runCommand(
    uv,
    [
      "pip",
      "install",
      "--python",
      stagePythonPath,
      "--index-url",
      torchIndexUrl,
      "--extra-index-url",
      "https://pypi.org/simple",
      "-r",
      runtimeRequirementsLinuxTorchPath,
    ],
    {
      UV_LINK_MODE: "copy",
    },
  );

  return { stagePythonPath, modeRequirementsPath };
}

function detectSitePackagesRoot() {
  const libRoot = path.join(stageVenvRoot, "lib");
  if (!existsSync(libRoot)) return null;
  for (const entry of readdirSync(libRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sitePackages = path.join(libRoot, entry.name, "site-packages");
    if (existsSync(sitePackages)) {
      return sitePackages;
    }
  }
  return null;
}

function stripVenvForRelease() {
  const sitePackagesRoot = detectSitePackagesRoot();
  if (!sitePackagesRoot) return;

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
  const prunable = ["tcl", "Tools", "test", "Tests", "Doc", path.join("share", "man")];
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
  if (process.platform !== "linux") {
    throw new Error("prepare-linux-resources.mjs must be run on Linux.");
  }

  ensureExists(path.join(pythonServiceRoot, "app"), "Python service app directory");
  ensureExists(voxcpmSrcRoot, "VoxCPM src directory");
  ensureExists(runtimeRequirementsPath, "Runtime requirements file");
  ensureExists(runtimeRequirementsLinuxPath, "Linux runtime requirements file");
  ensureExists(linuxModeRequirementsPath(), "Linux mode requirements file");
  ensureExists(runtimeRequirementsLinuxTorchPath, "Linux torch requirements file");

  const uv = resolveUvBinary();

  rmSync(stageRoot, { recursive: true, force: true });
  mkdirSync(stageRoot, { recursive: true });
  mkdirSync(stageServiceRoot, { recursive: true });

  console.log(`Installing python-build-standalone (${PYTHON_VERSION_SPEC})...`);
  const runtimePythonPath = installPythonRuntime(uv);
  const runtimeRoot = findRuntimeRoot(runtimePythonPath);
  console.log(`- runtime python: ${runtimePythonPath}`);
  console.log(`- runtime root:   ${runtimeRoot}`);
  console.log(`- accelerator:    ${accelerator}`);
  console.log(`- torch index:    ${torchIndexUrl}`);

  console.log("Copying python runtime into stage...");
  copyDirectory(runtimeRoot, stageRuntimeRoot, { dereference: true });

  console.log("Building Linux release venv...");
  const { stagePythonPath, modeRequirementsPath } = buildReleaseVenv(runtimePythonPath);

  console.log("Copying app/ and VoxCPM sources...");
  copyDirectory(path.join(pythonServiceRoot, "app"), path.join(stageServiceRoot, "app"));
  copyDirectory(voxcpmSrcRoot, path.join(stageRoot, "VoxCPM", "src"));

  console.log("Pruning bundle...");
  stripVenvForRelease();
  stripRuntimeForRelease();

  writeFileSync(
    path.join(stageServiceRoot, "manifest.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        platform: `linux-${process.arch}`,
        accelerator,
        runtimePythonPath,
        runtimeRoot,
        pythonServiceRoot,
        runtimeRequirementsPath,
        runtimeRequirementsLinuxPath,
        modeRequirementsPath,
        runtimeRequirementsLinuxTorchPath,
        stagePythonPath,
        voxcpmSrcRoot,
        torchBackend: accelerator === "nvidia" ? "cuda" : "cpu",
        torchIndexUrl,
      },
      null,
      2,
    ),
  );

  console.log("Prepared Linux bundle resources:");
  console.log(`- staged root:          ${stageRoot}`);
  console.log(`- python runtime stage: ${stageRuntimeRoot}`);
  console.log(`- release venv:         ${stageVenvRoot}`);
  console.log(`- runtime requirements: ${runtimeRequirementsPath}`);
  console.log(`- mode requirements:    ${modeRequirementsPath}`);
  console.log(`- VoxCPM src:           ${voxcpmSrcRoot}`);
}

await main();
