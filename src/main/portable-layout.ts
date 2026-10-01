import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";

/** Marker file. Its directory is the only drive location this app may write. */
export const PORTABLE_MARKER = "PORTABLE";

export interface PortableLayout {
  root: string;
  hermesHome: string;
  userData: string;
  scratch: string;
  crashes: string;
  caches: {
    uv: string;
    pip: string;
    pyc: string;
    electron: string;
    electronBuilder: string;
  };
}

export interface PortableResolveInput {
  cwd: string;
  execPath?: string;
  env: NodeJS.ProcessEnv;
  isElectron: boolean;
  isTest: boolean;
}

export function findPortableRoot(start: string, maxDepth = 8): string | null {
  let current = resolve(start);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (existsSync(join(current, PORTABLE_MARKER))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
  return null;
}

export function layoutForRoot(root: string): PortableLayout {
  const resolved = resolve(root);
  const runtime = join(resolved, "runtime");
  const cache = join(runtime, "cache");
  return {
    root: resolved,
    hermesHome: join(runtime, "hermes"),
    userData: join(runtime, "electron"),
    scratch: join(runtime, "scratch"),
    crashes: join(runtime, "crashes"),
    caches: {
      uv: join(cache, "uv"),
      pip: join(cache, "pip"),
      pyc: join(cache, "pyc"),
      electron: join(cache, "electron"),
      electronBuilder: join(cache, "electron-builder"),
    },
  };
}

function sameOrInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

function preferInside(
  current: string | undefined,
  parent: string,
  fallback: string,
): string {
  const trimmed = current?.trim();
  if (trimmed && sameOrInside(trimmed, parent)) return resolve(trimmed);
  return fallback;
}

function ensureLayoutDirs(layout: PortableLayout): void {
  for (const dir of [
    layout.hermesHome,
    layout.userData,
    layout.scratch,
    layout.crashes,
    layout.caches.uv,
    layout.caches.pip,
    layout.caches.pyc,
    layout.caches.electron,
    layout.caches.electronBuilder,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}

/** Point process env at `layout` so Chromium, Python, and uv never inherit
 *  the system temp directory or an AppData Hermes home. An existing home or
 *  userData path is kept only when it is already inside the portable root. */
export function applyPortableProcessEnv(
  env: NodeJS.ProcessEnv,
  layout: PortableLayout,
): void {
  ensureLayoutDirs(layout);
  env.HERMES_PORTABLE = "1";
  env.HERMES_PORTABLE_ROOT = layout.root;
  env.HERMES_HOME = preferInside(env.HERMES_HOME, layout.root, layout.hermesHome);
  env.HERMES_DESKTOP_USER_DATA_DIR = preferInside(
    env.HERMES_DESKTOP_USER_DATA_DIR,
    layout.root,
    layout.userData,
  );
  env.TEMP = layout.scratch;
  env.TMP = layout.scratch;
  env.TMPDIR = layout.scratch;
  // Stop Python from reading or writing %APPDATA%\Python on the system drive.
  env.PYTHONNOUSERSITE = "1";
  env.UV_CACHE_DIR = layout.caches.uv;
  env.PIP_CACHE_DIR = layout.caches.pip;
  env.PYTHONPYCACHEPREFIX = layout.caches.pyc;
  env.ELECTRON_CACHE = layout.caches.electron;
  env.ELECTRON_BUILDER_CACHE = layout.caches.electronBuilder;
  writeBundledPyvenv(layout);
}

/** Point the bundled venv at this folder's interpreter. Windows rejects a
 *  relative `home` in pyvenv.cfg, so the absolute path is rewritten every
 *  launch and stays valid after the folder is copied. */
export function writeBundledPyvenv(layout: PortableLayout): void {
  const pythonHome = join(layout.root, "runtime", "python");
  const pythonExe = join(pythonHome, "python.exe");
  const cfgPath = join(layout.hermesHome, "hermes-agent", "venv", "pyvenv.cfg");
  if (!existsSync(pythonExe) || !existsSync(join(layout.hermesHome, "hermes-agent", "venv"))) {
    return;
  }
  writeFileSync(
    cfgPath,
    [
      `home = ${pythonHome}`,
      "include-system-site-packages = false",
      `executable = ${pythonExe}`,
      "",
    ].join("\n"),
    "utf-8",
  );
}

export function shouldUsePortableLayout(input: PortableResolveInput): boolean {
  if (input.isTest) return false;
  if (input.env.VITEST === "true" || input.env.NODE_ENV === "test") return false;
  if (input.env.HERMES_PORTABLE === "0") return false;
  if (input.env.HERMES_DESKTOP_SANDBOX === "1") return false;
  if (input.env.HERMES_PORTABLE === "1" || input.env.HERMES_PORTABLE_ROOT?.trim()) {
    return true;
  }
  if (!input.isElectron) return false;
  return (
    findPortableRoot(input.cwd) !== null ||
    (input.execPath ? findPortableRoot(dirname(input.execPath)) !== null : false)
  );
}

// @lat: [[main-process#Portable runtime]]
export function resolvePortableLayout(
  input: PortableResolveInput,
): PortableLayout | null {
  if (!shouldUsePortableLayout(input)) return null;
  const explicit = input.env.HERMES_PORTABLE_ROOT?.trim();
  if (explicit) return layoutForRoot(explicit);
  const marked =
    findPortableRoot(input.cwd) ||
    (input.execPath ? findPortableRoot(dirname(input.execPath)) : null);
  if (!marked) return null;
  return layoutForRoot(marked);
}

/** Activate portable env for Node launchers (Vite, `scripts/run-portable.mjs`).
 *  Electron startup uses [[resolvePortableLayout]] so tests stay isolated. */
export function activatePortableEnv(
  env: NodeJS.ProcessEnv,
  cwd: string,
): PortableLayout | null {
  if (env.VITEST === "true" || env.NODE_ENV === "test") return null;
  if (env.HERMES_PORTABLE === "0" || env.HERMES_DESKTOP_SANDBOX === "1") return null;
  const root = env.HERMES_PORTABLE_ROOT?.trim() || findPortableRoot(cwd);
  if (!root) return null;
  const layout = layoutForRoot(root);
  applyPortableProcessEnv(env, layout);
  return layout;
}
