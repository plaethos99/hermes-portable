import { execFile, spawn } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, delimiter, join } from "path";
import { getEnhancedPath } from "./installer";
import { HIDDEN_SUBPROCESS_OPTIONS } from "./process-options";
import {
  installSkill,
  listInstalledSkills,
  uninstallSkill,
  type SkillCliResult,
} from "./skills";
import {
  CLI_AGENT_IDS,
  type CliAgentId,
  type CliAgentStatus,
} from "../shared/cli-agents";

/*
 * Coding-agent CLIs the user already pays for (Grok Build, Antigravity).
 * Hermes does not use them as its own model; it delegates coding tasks to
 * them through the terminal tool. "Enabled" means the matching Hermes skill
 * is installed, which is what teaches the agent how to drive the CLI.
 */

interface CliAgentDef {
  command: string;
  skillName: string;
  skillIdentifier: string;
  versionArgs: string[];
  /** Arguments that start the CLI's own browser sign-in. */
  signInArgs: string[];
  /** Install locations the official installers use, searched before PATH. */
  installDirs: () => string[];
}

const CLI_AGENTS: Record<CliAgentId, CliAgentDef> = {
  grok: {
    command: "grok",
    skillName: "grok",
    skillIdentifier: "official/autonomous-ai-agents/grok",
    versionArgs: ["--no-auto-update", "--version"],
    signInArgs: ["login"],
    installDirs: () => [join(homedir(), ".grok", "bin")],
  },
  agy: {
    command: "agy",
    skillName: "antigravity-cli",
    skillIdentifier: "official/autonomous-ai-agents/antigravity-cli",
    versionArgs: ["--version"],
    // agy has no login subcommand; the interactive session signs in first.
    signInArgs: [],
    installDirs: () =>
      process.platform === "win32"
        ? [join(process.env.LOCALAPPDATA || "", "agy", "bin")]
        : [join(homedir(), ".local", "bin")],
  },
};

export function isCliAgentId(value: string): value is CliAgentId {
  return (CLI_AGENT_IDS as readonly string[]).includes(value);
}

/** Grok Build keeps its OAuth tokens in ~/.grok/auth.json, one entry per account. */
export function grokAuthSignedIn(raw: string | null): boolean | null {
  if (raw === null) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return false;
    return Object.keys(parsed).length > 0;
  } catch {
    return null;
  }
}

const AGY_AUTH_PROMPT = /Authentication required|authentication failed/i;

/**
 * agy keeps its tokens in the OS keyring, so sign-in is read from
 * `agy models`: a signed-out CLI prints its auth prompt instead of the
 * tab-separated model list.
 */
export function agyModelsSignedIn(output: string): boolean | null {
  if (AGY_AUTH_PROMPT.test(output)) return false;
  if (/^\S+\t\S/m.test(output)) return true;
  return null;
}

function findExecutable(def: CliAgentDef): string | null {
  const names =
    process.platform === "win32"
      ? [`${def.command}.exe`, `${def.command}.cmd`]
      : [def.command];
  const dirs = [
    ...def.installDirs(),
    ...getEnhancedPath().split(delimiter),
  ].filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function cliEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PATH: getEnhancedPath() };
}

function readVersion(exe: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      exe,
      args,
      { timeout: 10000, env: cliEnv(), ...HIDDEN_SUBPROCESS_OPTIONS },
      (_err, stdout) => {
        const line = String(stdout || "")
          .split(/\r?\n/)
          .find((l) => l.trim());
        resolve(line ? line.trim() : null);
      },
    );
  });
}

function probeAgySignIn(exe: string): Promise<boolean | null> {
  return new Promise((resolve) => {
    let output = "";
    let settled = false;
    const child = spawn(exe, ["models"], {
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      ...HIDDEN_SUBPROCESS_OPTIONS,
    });
    const finish = (value: boolean | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolve(value);
    };
    // A signed-out agy waits for a pasted auth code; stop as soon as it asks.
    const onData = (chunk: Buffer): void => {
      output += chunk.toString();
      if (AGY_AUTH_PROMPT.test(output)) finish(false);
    };
    const timer = setTimeout(() => finish(agyModelsSignedIn(output)), 20000);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", () => finish(null));
    child.once("close", () => finish(agyModelsSignedIn(output)));
  });
}

function readSignIn(id: CliAgentId, exe: string): Promise<boolean | null> {
  if (id === "agy") return probeAgySignIn(exe);
  const authFile = join(homedir(), ".grok", "auth.json");
  const raw = existsSync(authFile) ? readFileSync(authFile, "utf-8") : null;
  return Promise.resolve(grokAuthSignedIn(raw));
}

function skillEnabled(def: CliAgentDef, profile?: string): boolean {
  return listInstalledSkills(profile).some(
    (skill) => basename(skill.path) === def.skillName,
  );
}

async function readStatus(
  id: CliAgentId,
  profile?: string,
): Promise<CliAgentStatus> {
  const def = CLI_AGENTS[id];
  const exe = findExecutable(def);
  const enabled = skillEnabled(def, profile);
  if (!exe) {
    return {
      id,
      installed: false,
      path: null,
      version: null,
      signedIn: null,
      enabled,
    };
  }
  const [version, signedIn] = await Promise.all([
    readVersion(exe, def.versionArgs),
    readSignIn(id, exe),
  ]);
  return { id, installed: true, path: exe, version, signedIn, enabled };
}

// The agy probe starts the CLI, so statuses are cached briefly; the
// Providers screen passes refresh=true after a sign-in or a toggle.
const STATUS_TTL_MS = 60000;
const statusCache = new Map<
  string,
  { at: number; value: Promise<CliAgentStatus[]> }
>();

export function getCliAgentStatuses(
  profile?: string,
  refresh = false,
): Promise<CliAgentStatus[]> {
  const key = profile || "default";
  const cached = statusCache.get(key);
  if (!refresh && cached && Date.now() - cached.at < STATUS_TTL_MS) {
    return cached.value;
  }
  const value = Promise.all(CLI_AGENT_IDS.map((id) => readStatus(id, profile)));
  statusCache.set(key, { at: Date.now(), value });
  value.catch(() => statusCache.delete(key));
  return value;
}

export function setCliAgentEnabled(
  id: CliAgentId,
  enabled: boolean,
  profile?: string,
): SkillCliResult {
  const def = CLI_AGENTS[id];
  statusCache.delete(profile || "default");
  return enabled
    ? installSkill(def.skillIdentifier, profile)
    : uninstallSkill(def.skillName, profile);
}

/**
 * Open a visible terminal running the CLI's own sign-in. The CLI handles the
 * browser OAuth and stores its tokens itself; Hermes never sees them.
 */
export function openCliAgentSignIn(id: CliAgentId): Promise<boolean> {
  const def = CLI_AGENTS[id];
  const exe = findExecutable(def);
  if (!exe) return Promise.resolve(false);

  let command = exe;
  let args = def.signInArgs;
  if (process.platform === "darwin") {
    const line = [exe, ...def.signInArgs]
      .map((part) => `'${part.replace(/'/g, "'\\''")}'`)
      .join(" ");
    command = "/usr/bin/osascript";
    args = [
      "-e",
      `tell application "Terminal" to do script ${JSON.stringify(line)}`,
      "-e",
      'tell application "Terminal" to activate',
    ];
  } else if (process.platform !== "win32") {
    command = "x-terminal-emulator";
    args = ["-e", exe, ...def.signInArgs];
  }

  statusCache.clear();
  return new Promise((resolve) => {
    try {
      // On Windows a detached console program gets its own visible console,
      // which is the terminal the user signs in from.
      const child = spawn(command, args, {
        env: cliEnv(),
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
