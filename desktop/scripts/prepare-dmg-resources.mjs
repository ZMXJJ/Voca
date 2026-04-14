import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const stageRoot = path.join(desktopRoot, ".bundle-resources");
const pythonServiceRoot = path.join(desktopRoot, "python-service");
const voxcpmSrcRoot = path.join(repoRoot, "VoxCPM", "src");
const runtimeRequirementsPath = path.join(pythonServiceRoot, "requirements.runtime.txt");
const venvPythonPath = path.join(pythonServiceRoot, ".venv", "bin", "python");
const runtimePythonPath = realpathSync(venvPythonPath);
const runtimeRoot = path.resolve(path.dirname(runtimePythonPath), "..");
const stageServiceRoot = path.join(stageRoot, "python-service");
const stageVenvRoot = path.join(stageServiceRoot, ".venv");
const stagePythonPath = path.join(stageVenvRoot, "bin", "python");

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
    dereference: options.dereference ?? false,
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

function resolveUvBinary() {
  const candidates = [process.env.UV_BIN, "uv"].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { stdio: "ignore" });
    if (result.status === 0) {
      return candidate;
    }
  }
  throw new Error("uv is required to prepare the release Python runtime. Set UV_BIN if it is not on PATH.");
}

function buildReleaseVenv() {
  const uv = resolveUvBinary();
  runCommand(uv, ["venv", "--python", runtimePythonPath, stageVenvRoot], {
    UV_LINK_MODE: "copy",
  });
  runCommand(uv, ["pip", "install", "--python", stagePythonPath, "-r", runtimeRequirementsPath], {
    UV_LINK_MODE: "copy",
  });
}

function walkFiles(rootPath) {
  const files = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const currentPath = stack.pop();
    const entries = readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function collectSymlinks(rootPath) {
  const symlinks = [];
  const stack = [rootPath];
  while (stack.length > 0) {
    const currentPath = stack.pop();
    const entries = readdirSync(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isSymbolicLink()) {
        symlinks.push(fullPath);
      }
    }
  }
  return symlinks.sort((left, right) => right.split(path.sep).length - left.split(path.sep).length);
}

function materializeSymlinks(rootPath) {
  while (true) {
    const symlinks = collectSymlinks(rootPath);
    if (symlinks.length === 0) {
      return;
    }
    for (const symlinkPath of symlinks) {
      const targetPath = realpathSync(symlinkPath);
      const targetStats = statSync(targetPath);
      rmSync(symlinkPath, { recursive: true, force: true });
      cpSync(targetPath, symlinkPath, {
        recursive: targetStats.isDirectory(),
        preserveTimestamps: true,
        dereference: true,
      });
      if (lstatSync(symlinkPath).isSymbolicLink()) {
        throw new Error(`Failed to materialize symlink: ${symlinkPath}`);
      }
    }
  }
}

function isMachOBinary(filePath) {
  const result = spawnSync("file", ["-b", filePath], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    return { isMachO: false, requiresRuntime: false };
  }
  const description = result.stdout.trim();
  if (!description.includes("Mach-O")) {
    return { isMachO: false, requiresRuntime: false };
  }
  const requiresRuntime = description.includes("executable");
  return { isMachO: true, requiresRuntime };
}

function collectSignTargets(rootPath) {
  return walkFiles(rootPath)
    .map((filePath) => {
      const analysis = isMachOBinary(filePath);
      return analysis.isMachO
        ? {
            filePath,
            requiresRuntime: analysis.requiresRuntime,
            depth: filePath.split(path.sep).length,
          }
        : null;
    })
    .filter(Boolean)
    .sort((left, right) => right.depth - left.depth || left.filePath.localeCompare(right.filePath));
}

function signEmbeddedMachOBinaries() {
  const identity = process.env.APPLE_SIGNING_IDENTITY?.trim();
  if (!identity) {
    console.log("Skipping embedded Python binary signing because APPLE_SIGNING_IDENTITY is not set.");
    return;
  }

  const signTargets = [
    ...collectSignTargets(path.join(stageRoot, "python-runtime")),
    ...collectSignTargets(stageVenvRoot),
  ];

  if (signTargets.length === 0) {
    console.log("No embedded Mach-O binaries found to sign.");
    return;
  }

  console.log(`Signing ${signTargets.length} embedded Python binaries with ${identity}...`);
  for (const target of signTargets) {
    const args = ["--force", "--sign", identity, "--timestamp"];
    if (target.requiresRuntime) {
      args.push("--options", "runtime");
    }
    args.push(target.filePath);
    runCommand("codesign", args);
  }
}

ensureExists(path.join(pythonServiceRoot, "app"), "Python service app directory");
ensureExists(path.join(pythonServiceRoot, ".venv"), "Python service virtual environment");
ensureExists(voxcpmSrcRoot, "VoxCPM src directory");
ensureExists(runtimeRoot, "Resolved Python runtime root");
ensureExists(runtimeRequirementsPath, "Runtime requirements file");

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });

copyDirectory(path.join(pythonServiceRoot, "app"), path.join(stageServiceRoot, "app"));
buildReleaseVenv();
copyDirectory(voxcpmSrcRoot, path.join(stageRoot, "VoxCPM", "src"));
copyDirectory(runtimeRoot, path.join(stageRoot, "python-runtime"), { dereference: true });
materializeSymlinks(path.join(stageRoot, "python-runtime"));
materializeSymlinks(stageVenvRoot);
signEmbeddedMachOBinaries();

writeFileSync(
  path.join(stageServiceRoot, "manifest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runtimePythonPath,
      runtimeRoot,
      pythonServiceRoot,
      runtimeRequirementsPath,
      stagePythonPath,
      voxcpmSrcRoot,
    },
    null,
    2,
  ),
);

console.log("Prepared DMG bundle resources:");
console.log(`- staged root: ${stageRoot}`);
console.log(`- python runtime: ${runtimeRoot}`);
console.log(`- release venv: ${stageVenvRoot}`);
console.log(`- runtime requirements: ${runtimeRequirementsPath}`);
console.log(`- VoxCPM src: ${voxcpmSrcRoot}`);
