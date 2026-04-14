import { cpSync, existsSync, linkSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
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
const ffmpegCacheRoot = path.join(desktopRoot, ".cache", "ffmpeg-runtime");
const homebrewEnv = { HOMEBREW_NO_AUTO_UPDATE: "1" };
const homebrewFfmpegFormula = process.env.VOCA_FFMPEG_BREW_FORMULA?.trim() || "ffmpeg";

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

function runCommandAsync(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Command failed (${code}): ${command} ${args.join(" ")}`));
        return;
      }
      resolve();
    });
  });
}

function resolveCodesignConcurrency() {
  const raw = process.env.VOCA_CODESIGN_CONCURRENCY?.trim();
  if (raw) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(parsed, 32);
    }
  }
  const cpus =
    typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.min(8, Math.max(1, cpus));
}

async function runWithConcurrency(limit, tasks) {
  if (tasks.length === 0) {
    return;
  }
  let next = 0;
  const workerCount = Math.min(limit, tasks.length);
  async function worker() {
    while (true) {
      const index = next;
      next += 1;
      if (index >= tasks.length) {
        return;
      }
      await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
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

function detectSitePackagesRoot(venvRoot) {
  const libRoot = path.join(venvRoot, "lib");
  ensureExists(libRoot, "Virtualenv lib directory");
  for (const entry of readdirSync(libRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const sitePackages = path.join(libRoot, entry.name, "site-packages");
    if (existsSync(sitePackages)) {
      return sitePackages;
    }
  }
  throw new Error(`Unable to locate site-packages under ${venvRoot}`);
}

function listDynamicLibraryDependencies(filePath) {
  return runCommandCapture("otool", ["-L", filePath])
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(" (compatibility version")[0]?.trim())
    .filter(Boolean);
}

function listMachORpaths(filePath) {
  const output = runCommandCapture("otool", ["-l", filePath]);
  const lines = output.split("\n");
  const rpaths = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].trim() !== "cmd LC_RPATH") {
      continue;
    }
    for (let inner = index + 1; inner < Math.min(index + 8, lines.length); inner += 1) {
      const line = lines[inner].trim();
      if (!line.startsWith("path ")) {
        continue;
      }
      const rawPath = line.slice("path ".length);
      const pathValue = rawPath.includes(" (offset") ? rawPath.split(" (offset")[0].trim() : rawPath.trim();
      if (pathValue) {
        rpaths.push(pathValue);
      }
      break;
    }
  }
  return rpaths;
}

function resolveDynamicLibraryReference(reference, loaderDir, rpaths) {
  if (reference.startsWith("/")) {
    return existsSync(reference) ? realpathSync(reference) : null;
  }

  if (reference.startsWith("@loader_path/")) {
    const candidate = path.resolve(loaderDir, reference.slice("@loader_path/".length));
    return existsSync(candidate) ? realpathSync(candidate) : null;
  }

  if (reference.startsWith("@executable_path/")) {
    return null;
  }

  if (!reference.startsWith("@rpath/")) {
    return null;
  }

  const suffix = reference.slice("@rpath/".length);
  for (const rawRpath of rpaths) {
    let baseDir = rawRpath;
    if (rawRpath === "@loader_path") {
      baseDir = loaderDir;
    } else if (rawRpath.startsWith("@loader_path/")) {
      baseDir = path.resolve(loaderDir, rawRpath.slice("@loader_path/".length));
    } else if (rawRpath.startsWith("@executable_path")) {
      continue;
    }

    const candidate = path.resolve(baseDir, suffix);
    if (existsSync(candidate)) {
      return realpathSync(candidate);
    }
  }

  return null;
}

function isSystemLibrary(libraryPath) {
  return libraryPath.startsWith("/System/") || libraryPath.startsWith("/usr/lib/");
}

function isFfmpegRelatedRpath(rpath) {
  return /(?:^|\/)ffmpeg(?:@[\d.]+)?(?:\/|$)/.test(rpath);
}

function normalizeCacheSegment(value) {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function resolveBrewPrefix(formula) {
  const result = spawnSync("brew", ["--prefix", formula], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...homebrewEnv,
    },
  });
  if (result.status !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  return value || null;
}

function queryHomebrewFormulaInfo(formula) {
  const parsed = JSON.parse(runCommandCapture("brew", ["info", "--json=v2", formula], homebrewEnv));
  const entry = parsed?.formulae?.[0];
  if (!entry) {
    throw new Error(`Unable to query Homebrew metadata for formula: ${formula}`);
  }
  return entry;
}

function resolveInstalledHomebrewFfmpegInfo() {
  let info = queryHomebrewFormulaInfo(homebrewFfmpegFormula);
  if (!Array.isArray(info.installed) || info.installed.length === 0) {
    console.log(`Homebrew formula ${homebrewFfmpegFormula} is not installed. Installing it now for FFmpeg runtime bundling...`);
    runCommand("brew", ["install", homebrewFfmpegFormula], homebrewEnv);
    info = queryHomebrewFormulaInfo(homebrewFfmpegFormula);
  }

  const prefix = runCommandCapture("brew", ["--prefix", homebrewFfmpegFormula], homebrewEnv);
  const libDir = path.join(prefix, "lib");
  ensureExists(libDir, `Homebrew ${homebrewFfmpegFormula} lib directory`);

  return {
    formula: info.name || homebrewFfmpegFormula,
    version: info.installed?.[0]?.version || info.versions?.stable || "unknown",
    prefix,
    libDir,
  };
}

function vendorDynamicLibraries(entryLibraryPaths, destinationLibDir) {
  mkdirSync(destinationLibDir, { recursive: true });
  const sourceLibraries = collectVendoredLibraryClosure(entryLibraryPaths);
  const copiedLibraries = new Map();

  for (const sourcePath of sourceLibraries) {
    const destinationPath = path.join(destinationLibDir, path.basename(sourcePath));
    cpSync(sourcePath, destinationPath, {
      preserveTimestamps: true,
      dereference: true,
    });
    copiedLibraries.set(path.basename(sourcePath), destinationPath);
  }

  for (const destinationPath of copiedLibraries.values()) {
    const basename = path.basename(destinationPath);
    runCommand("install_name_tool", ["-id", `@rpath/${basename}`, destinationPath]);

    const dependencies = listDynamicLibraryDependencies(destinationPath);
    for (const dependency of dependencies) {
      const dependencyBasename = path.basename(dependency);
      if (!copiedLibraries.has(dependencyBasename)) {
        continue;
      }
      if (dependency === `@rpath/${dependencyBasename}`) {
        continue;
      }
      runCommand("install_name_tool", ["-change", dependency, `@rpath/${dependencyBasename}`, destinationPath]);
    }

    const staleDependencyRpaths = listMachORpaths(destinationPath).filter(
      (rpath) => !rpath.startsWith("@") && !isSystemLibrary(rpath),
    );
    upsertRpath(destinationPath, "@loader_path", staleDependencyRpaths);
  }

  return {
    sourceLibraries,
    copiedLibraries,
  };
}

function tryUseCachedFfmpegLibDir(torchcodecRoot) {
  if (!existsSync(ffmpegCacheRoot)) {
    return null;
  }

  const entries = readdirSync(ffmpegCacheRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(ffmpegCacheRoot, entry.name))
    .sort((left, right) => right.localeCompare(left));

  for (const cacheDir of entries) {
    const candidateLibDir = path.join(cacheDir, "lib");
    if (!existsSync(candidateLibDir)) {
      continue;
    }
    try {
      const selection = chooseTorchcodecFfmpegLibraries(torchcodecRoot, candidateLibDir);
      return {
        libDir: candidateLibDir,
        source: "cache",
        cacheDir,
        versionHint: path.basename(cacheDir),
        matchedTorchcodecCore: path.basename(selection.torchcodecCorePath),
      };
    } catch {
      // Ignore stale/incompatible caches and continue scanning.
    }
  }

  return null;
}

function ensureCachedHomebrewFfmpegLibDir(torchcodecRoot) {
  const info = resolveInstalledHomebrewFfmpegInfo();
  const selection = chooseTorchcodecFfmpegLibraries(torchcodecRoot, info.libDir);
  const cacheDir = path.join(
    ffmpegCacheRoot,
    `${normalizeCacheSegment(info.formula)}-${normalizeCacheSegment(info.version)}`,
  );
  const cacheLibDir = path.join(cacheDir, "lib");
  const manifestPath = path.join(cacheDir, "manifest.json");

  const cacheIsReady =
    existsSync(cacheLibDir) &&
    selection.requiredBasenames.every((basename) => existsSync(path.join(cacheLibDir, basename)));

  if (!cacheIsReady) {
    rmSync(cacheDir, { recursive: true, force: true });
    mkdirSync(cacheLibDir, { recursive: true });
    const vendored = vendorDynamicLibraries(selection.entryLibraryPaths, cacheLibDir);
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          source: "homebrew",
          formula: info.formula,
          version: info.version,
          prefix: info.prefix,
          libDir: info.libDir,
          generatedAt: new Date().toISOString(),
          matchedTorchcodecCore: path.basename(selection.torchcodecCorePath),
          bundledLibraries: [...vendored.copiedLibraries.keys()].sort((left, right) => left.localeCompare(right)),
        },
        null,
        2,
      ),
    );
  }

  return {
    libDir: cacheLibDir,
    source: "homebrew-cache",
    cacheDir,
    formula: info.formula,
    version: info.version,
    matchedTorchcodecCore: path.basename(selection.torchcodecCorePath),
  };
}

function resolveFfmpegLibDir(torchcodecRoot) {
  const explicitLibDir = process.env.VOCA_FFMPEG_LIB_DIR?.trim();
  if (explicitLibDir) {
    ensureExists(explicitLibDir, "VOCA_FFMPEG_LIB_DIR");
    return {
      libDir: realpathSync(explicitLibDir),
      source: "env-lib-dir",
    };
  }

  const explicitPrefix = process.env.VOCA_FFMPEG_PREFIX?.trim();
  if (explicitPrefix) {
    const candidate = path.join(explicitPrefix, "lib");
    ensureExists(candidate, "VOCA_FFMPEG_PREFIX/lib");
    return {
      libDir: realpathSync(candidate),
      source: "env-prefix",
    };
  }

  const cachedLibDir = tryUseCachedFfmpegLibDir(torchcodecRoot);
  if (cachedLibDir) {
    return cachedLibDir;
  }

  try {
    return ensureCachedHomebrewFfmpegLibDir(torchcodecRoot);
  } catch (error) {
    console.warn(`Automatic Homebrew FFmpeg provisioning failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const candidates = [
    resolveBrewPrefix("ffmpeg"),
    resolveBrewPrefix("ffmpeg@8"),
    "/opt/homebrew/opt/ffmpeg",
    "/opt/homebrew/opt/ffmpeg@8",
    "/usr/local/opt/ffmpeg",
    "/usr/local/opt/ffmpeg@8",
  ]
    .filter(Boolean)
    .map((prefix) => path.join(prefix, "lib"));

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return {
        libDir: realpathSync(candidate),
        source: "local-install",
      };
    }
  }

  throw new Error(
    "Unable to locate FFmpeg shared libraries. Set VOCA_FFMPEG_LIB_DIR / VOCA_FFMPEG_PREFIX, or ensure Homebrew is available so the build can auto-install and cache FFmpeg.",
  );
}

function listTorchcodecBinaryPaths(torchcodecRoot) {
  return readdirSync(torchcodecRoot)
    .filter((name) => /\.(dylib|so)$/.test(name))
    .map((name) => path.join(torchcodecRoot, name));
}

function chooseTorchcodecFfmpegLibraries(torchcodecRoot, ffmpegLibDir) {
  const availableLibraries = new Set(readdirSync(ffmpegLibDir));
  const coreLibraries = readdirSync(torchcodecRoot)
    .filter((name) => /^libtorchcodec_core\d+\.dylib$/.test(name))
    .sort((left, right) => {
      const leftVersion = Number.parseInt(left.match(/\d+/)?.[0] ?? "0", 10);
      const rightVersion = Number.parseInt(right.match(/\d+/)?.[0] ?? "0", 10);
      return rightVersion - leftVersion;
    });

  for (const libraryName of coreLibraries) {
    const libraryPath = path.join(torchcodecRoot, libraryName);
    const requiredBasenames = [
      ...new Set(
        listDynamicLibraryDependencies(libraryPath)
          .map((dependency) => path.basename(dependency))
          .filter((basename) => /^(libav|libsw|libpostproc)/.test(basename)),
      ),
    ];
    if (requiredBasenames.length === 0) {
      continue;
    }
    if (requiredBasenames.every((basename) => availableLibraries.has(basename))) {
      return {
        torchcodecCorePath: libraryPath,
        requiredBasenames,
        entryLibraryPaths: requiredBasenames.map((basename) => path.join(ffmpegLibDir, basename)),
      };
    }
  }

  throw new Error(
    `No torchcodec core library in ${torchcodecRoot} matches the FFmpeg dylibs available in ${ffmpegLibDir}.`,
  );
}

function collectVendoredLibraryClosure(entryLibraryPaths) {
  const pending = [...entryLibraryPaths];
  const seen = new Set();
  const resolvedPaths = [];

  while (pending.length > 0) {
    const currentPath = realpathSync(pending.pop());
    if (seen.has(currentPath)) {
      continue;
    }
    seen.add(currentPath);
    resolvedPaths.push(currentPath);

    const loaderDir = path.dirname(currentPath);
    const rpaths = listMachORpaths(currentPath);
    for (const dependency of listDynamicLibraryDependencies(currentPath)) {
      const resolvedDependency = resolveDynamicLibraryReference(dependency, loaderDir, rpaths);
      if (!resolvedDependency || isSystemLibrary(resolvedDependency)) {
        continue;
      }
      pending.push(resolvedDependency);
    }
  }

  return resolvedPaths.sort((left, right) => left.localeCompare(right));
}

function upsertRpath(filePath, rpath, staleRpaths = []) {
  const currentRpaths = listMachORpaths(filePath);
  for (const staleRpath of staleRpaths) {
    if (currentRpaths.includes(staleRpath)) {
      runCommand("install_name_tool", ["-delete_rpath", staleRpath, filePath]);
    }
  }
  const refreshedRpaths = listMachORpaths(filePath);
  if (!refreshedRpaths.includes(rpath)) {
    runCommand("install_name_tool", ["-add_rpath", rpath, filePath]);
  }
}

function bundleTorchcodecFfmpegLibraries() {
  const stageSitePackagesRoot = detectSitePackagesRoot(stageVenvRoot);
  const torchcodecRoot = path.join(stageSitePackagesRoot, "torchcodec");
  ensureExists(torchcodecRoot, "Staged torchcodec package");

  const ffmpegSource = resolveFfmpegLibDir(torchcodecRoot);
  const ffmpegLibDir = ffmpegSource.libDir;
  const torchcodecDylibsDir = path.join(torchcodecRoot, ".dylibs");
  mkdirSync(torchcodecDylibsDir, { recursive: true });

  const selection = chooseTorchcodecFfmpegLibraries(torchcodecRoot, ffmpegLibDir);
  const vendored = vendorDynamicLibraries(selection.entryLibraryPaths, torchcodecDylibsDir);

  for (const binaryPath of listTorchcodecBinaryPaths(torchcodecRoot)) {
    const staleTorchcodecRpaths = listMachORpaths(binaryPath).filter((rpath) => isFfmpegRelatedRpath(rpath));
    upsertRpath(binaryPath, "@loader_path/.dylibs", staleTorchcodecRpaths);
  }

  console.log(
    `Bundled ${vendored.copiedLibraries.size} FFmpeg-related libraries for torchcodec from ${ffmpegLibDir} via ${ffmpegSource.source} (matched ${path.basename(selection.torchcodecCorePath)}).`,
  );

  return {
    ffmpegLibDir,
    ffmpegSource,
    matchedTorchcodecCore: path.basename(selection.torchcodecCorePath),
    bundledLibraries: [...vendored.copiedLibraries.keys()].sort((left, right) => left.localeCompare(right)),
  };
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

async function signEmbeddedMachOBinaries() {
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

  const concurrency = resolveCodesignConcurrency();
  console.log(
    `Signing ${signTargets.length} embedded Python binaries (${concurrency} parallel) with ${identity}...`,
  );
  const tasks = signTargets.map((target) => () => {
    const args = ["--force", "--sign", identity, "--timestamp"];
    if (target.requiresRuntime) {
      args.push("--options", "runtime");
    }
    args.push(target.filePath);
    return runCommandAsync("codesign", args);
  });
  await runWithConcurrency(concurrency, tasks);
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
const bundledFfmpeg = bundleTorchcodecFfmpegLibraries();

const runtimeBinDir = path.join(stageRoot, "python-runtime", "bin");
const pythonBinary = ["python3.11", "python3", "python"]
  .map((name) => path.join(runtimeBinDir, name))
  .find((p) => existsSync(p));
if (pythonBinary) {
  const vocaServicePath = path.join(runtimeBinDir, "VocaService");
  if (existsSync(vocaServicePath)) rmSync(vocaServicePath);
  linkSync(pythonBinary, vocaServicePath);
  console.log(`Created VocaService hard link: ${vocaServicePath} -> ${pythonBinary}`);
}

await signEmbeddedMachOBinaries();

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
      bundledFfmpeg,
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
