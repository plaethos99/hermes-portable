import { app } from "electron";
import { join } from "path";
import {
  applyPortableProcessEnv,
  resolvePortableLayout,
  type PortableLayout,
} from "./portable-layout";

function isTestProcess(): boolean {
  return (
    process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.npm_lifecycle_event === "test"
  );
}

function applyElectronPaths(layout: PortableLayout): void {
  const userData = process.env.HERMES_DESKTOP_USER_DATA_DIR?.trim() || layout.userData;
  const scratch = process.env.TEMP?.trim() || layout.scratch;
  try {
    app.setPath("userData", userData);
    app.setPath("sessionData", userData);
    app.setPath("temp", scratch);
    app.setPath("logs", join(userData, "logs"));
    app.setPath("crashDumps", layout.crashes);
    app.commandLine.appendSwitch("disk-cache-dir", join(userData, "Cache"));
  } catch {
    // Electron rejects setPath after ready, and unit tests mock `app`.
  }
}

/** Redirect Electron and Hermes onto the portable root before any module
 *  reads `userData` or captures `HERMES_HOME`. Must be imported first. */
export function installPortablePaths(): void {
  if (isTestProcess()) return;
  const layout = resolvePortableLayout({
    cwd: process.cwd(),
    execPath: process.execPath,
    env: process.env,
    isElectron: Boolean(process.versions.electron),
    isTest: false,
  });
  if (!layout) return;
  applyPortableProcessEnv(process.env, layout);
  applyElectronPaths(layout);
}

installPortablePaths();
