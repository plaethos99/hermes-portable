import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activatePortableEnv,
  findPortableRoot,
  resolvePortableLayout,
  writeBundledPyvenv,
} from "../src/main/portable-layout";

describe("portable layout", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function markedTree(): { root: string; nested: string } {
    const root = mkdtempSync(join(tmpdir(), "hermes-portable-"));
    roots.push(root);
    writeFileSync(join(root, "PORTABLE"), "portable\n");
    const nested = join(root, "apps", "desktop");
    return { root, nested };
  }

  it("finds the marker by walking parents", () => {
    const { root, nested } = markedTree();
    expect(findPortableRoot(nested)).toBe(root);
  });

  it("redirects an AppData home into runtime and keeps an in-root home", () => {
    const { root } = markedTree();
    const env: NodeJS.ProcessEnv = {
      HERMES_HOME: "C:\\Users\\Admin\\AppData\\Local\\hermes",
      HERMES_DESKTOP_USER_DATA_DIR: "C:\\Users\\Admin\\AppData\\Roaming\\HermesOne",
    };

    const layout = activatePortableEnv(env, root);

    expect(layout?.hermesHome).toBe(join(root, "runtime", "hermes"));
    expect(env.HERMES_HOME).toBe(join(root, "runtime", "hermes"));
    expect(env.HERMES_DESKTOP_USER_DATA_DIR).toBe(join(root, "runtime", "electron"));
    expect(env.TEMP).toBe(join(root, "runtime", "scratch"));
    expect(env.TMP).toBe(env.TEMP);
    expect(env.PYTHONNOUSERSITE).toBe("1");
    expect(env.ELECTRON_CACHE).toBe(join(root, "runtime", "cache", "electron"));

    const custom = join(root, "runtime", "custom-home");
    const kept: NodeJS.ProcessEnv = { HERMES_HOME: custom };
    activatePortableEnv(kept, root);
    expect(kept.HERMES_HOME).toBe(custom);
  });

  it("stays off for tests, sandbox launches, and an explicit opt-out", () => {
    const { root, nested } = markedTree();

    expect(
      activatePortableEnv({ VITEST: "true", NODE_ENV: "test" }, root),
    ).toBeNull();
    expect(
      activatePortableEnv({ HERMES_DESKTOP_SANDBOX: "1" }, root),
    ).toBeNull();
    expect(activatePortableEnv({ HERMES_PORTABLE: "0" }, root)).toBeNull();
    expect(
      resolvePortableLayout({
        cwd: nested,
        env: {},
        isElectron: true,
        isTest: true,
      }),
    ).toBeNull();
    expect(
      resolvePortableLayout({
        cwd: nested,
        env: {},
        isElectron: false,
        isTest: false,
      }),
    ).toBeNull();
    expect(
      resolvePortableLayout({
        cwd: nested,
        env: {},
        isElectron: true,
        isTest: false,
      })?.root,
    ).toBe(root);
  });

  it("rewrites the bundled venv so it follows the folder", () => {
    const { root } = markedTree();
    const pythonHome = join(root, "runtime", "python");
    mkdirSync(pythonHome, { recursive: true });
    writeFileSync(join(pythonHome, "python.exe"), "");
    mkdirSync(join(root, "runtime", "hermes", "hermes-agent", "venv"), {
      recursive: true,
    });

    writeBundledPyvenv({
      root,
      hermesHome: join(root, "runtime", "hermes"),
      userData: join(root, "runtime", "electron"),
      scratch: join(root, "runtime", "scratch"),
      crashes: join(root, "runtime", "crashes"),
      caches: {
        uv: join(root, "runtime", "cache", "uv"),
        pip: join(root, "runtime", "cache", "pip"),
        pyc: join(root, "runtime", "cache", "pyc"),
        electron: join(root, "runtime", "cache", "electron"),
        electronBuilder: join(root, "runtime", "cache", "electron-builder"),
      },
    });

    const cfg = readFileSync(
      join(root, "runtime", "hermes", "hermes-agent", "venv", "pyvenv.cfg"),
      "utf-8",
    );
    expect(cfg).toContain(`home = ${pythonHome}`);
    expect(cfg).toContain(`executable = ${join(pythonHome, "python.exe")}`);
  });
});
