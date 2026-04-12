import { cpSync, existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const stageRoot = path.join(desktopRoot, ".bundle-resources");
const pythonServiceRoot = path.join(desktopRoot, "python-service");
const voxcpmSrcRoot = path.join(repoRoot, "VoxCPM", "src");
const venvPythonPath = path.join(pythonServiceRoot, ".venv", "bin", "python");
const runtimePythonPath = realpathSync(venvPythonPath);
const runtimeRoot = path.resolve(path.dirname(runtimePythonPath), "..");

function ensureExists(targetPath, label) {
  if (!existsSync(targetPath)) {
    throw new Error(`${label} does not exist: ${targetPath}`);
  }
}

function copyDirectory(sourcePath, destinationPath) {
  ensureExists(sourcePath, "Source path");
  cpSync(sourcePath, destinationPath, {
    recursive: true,
    preserveTimestamps: true,
  });
}

ensureExists(path.join(pythonServiceRoot, "app"), "Python service app directory");
ensureExists(path.join(pythonServiceRoot, ".venv"), "Python service virtual environment");
ensureExists(voxcpmSrcRoot, "VoxCPM src directory");
ensureExists(runtimeRoot, "Resolved Python runtime root");

rmSync(stageRoot, { recursive: true, force: true });
mkdirSync(stageRoot, { recursive: true });

copyDirectory(path.join(pythonServiceRoot, "app"), path.join(stageRoot, "python-service", "app"));
copyDirectory(path.join(pythonServiceRoot, ".venv"), path.join(stageRoot, "python-service", ".venv"));
copyDirectory(voxcpmSrcRoot, path.join(stageRoot, "VoxCPM", "src"));
copyDirectory(runtimeRoot, path.join(stageRoot, "python-runtime"));

writeFileSync(
  path.join(stageRoot, "manifest.json"),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      runtimePythonPath,
      runtimeRoot,
      pythonServiceRoot,
      voxcpmSrcRoot,
    },
    null,
    2,
  ),
);

console.log("Prepared DMG bundle resources:");
console.log(`- staged root: ${stageRoot}`);
console.log(`- python runtime: ${runtimeRoot}`);
console.log(`- python service: ${pythonServiceRoot}`);
console.log(`- VoxCPM src: ${voxcpmSrcRoot}`);
