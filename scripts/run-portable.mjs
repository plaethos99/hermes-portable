// Launch a repo command with Hermes, Electron, and scratch paths forced under
// runtime/. This has to happen before electron-vite starts: Chromium reads
// TEMP at process creation, before any main-process JavaScript runs.
// Directory names match src/main/portable-layout.ts.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = join(root, "runtime");
const cache = join(runtime, "cache");
const layout = {
  root,
  hermesHome: join(runtime, "hermes"),
  userData: join(runtime, "electron"),
  scratch: join(runtime, "scratch"),
  crashes: join(runtime, "crashes"),
  uv: join(cache, "uv"),
  pip: join(cache, "pip"),
  pyc: join(cache, "pyc"),
  electron: join(cache, "electron"),
  electronBuilder: join(cache, "electron-builder"),
};

function sameOrInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function preferInside(current, parent, fallback) {
  const trimmed = current?.trim();
  if (trimmed && sameOrInside(trimmed, parent)) return resolve(trimmed);
  return fallback;
}

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: node scripts/run-portable.mjs <bin> [args...]");
  process.exit(1);
}

if (process.env.HERMES_PORTABLE === "0" || process.env.HERMES_DESKTOP_SANDBOX === "1") {
  console.error("Portable launch was opted out. Unset HERMES_PORTABLE=0 / HERMES_DESKTOP_SANDBOX, or run electron-vite directly.");
  process.exit(1);
}

if (!existsSync(join(root, "PORTABLE"))) {
  console.error(`Missing ${join(root, "PORTABLE")}. Refusing to launch without the portable marker.`);
  process.exit(1);
}

for (const dir of Object.values(layout)) {
  if (dir !== root) mkdirSync(dir, { recursive: true });
}

process.env.HERMES_PORTABLE = "1";
process.env.HERMES_PORTABLE_ROOT = layout.root;
process.env.HERMES_HOME = preferInside(
  process.env.HERMES_HOME,
  layout.root,
  layout.hermesHome,
);
process.env.HERMES_DESKTOP_USER_DATA_DIR = preferInside(
  process.env.HERMES_DESKTOP_USER_DATA_DIR,
  layout.root,
  layout.userData,
);
process.env.TEMP = layout.scratch;
process.env.TMP = layout.scratch;
process.env.TMPDIR = layout.scratch;
process.env.PYTHONNOUSERSITE = "1";
process.env.UV_CACHE_DIR = layout.uv;
process.env.PIP_CACHE_DIR = layout.pip;
process.env.PYTHONPYCACHEPREFIX = layout.pyc;
process.env.ELECTRON_CACHE = layout.electron;
process.env.ELECTRON_BUILDER_CACHE = layout.electronBuilder;

const [command, ...rest] = args;
const binName = process.platform === "win32" ? `${command}.cmd` : command;
const bin = join(root, "node_modules", ".bin", binName);
if (!existsSync(bin)) {
  console.error(`Missing ${bin}. Run npm install in ${root} first.`);
  process.exit(1);
}

const child = spawn(bin, rest, {
  cwd: root,
  env: process.env,
  stdio: "inherit",
  shell: process.platform === "win32",
  windowsHide: false,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
