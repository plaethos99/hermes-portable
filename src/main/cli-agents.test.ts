import { describe, expect, it, vi } from "vitest";

// cli-agents reaches electron through ./installer and ./skills; only the
// pure sign-in parsers are under test here.
vi.mock("./installer", () => ({
  getEnhancedPath: vi.fn(() => ""),
}));
vi.mock("./skills", () => ({
  installSkill: vi.fn(),
  listInstalledSkills: vi.fn(() => []),
  uninstallSkill: vi.fn(),
}));

import {
  agyModelsSignedIn,
  grokAuthSignedIn,
  isCliAgentId,
} from "./cli-agents";

describe("grokAuthSignedIn", () => {
  it("is signed in when auth.json holds an account entry", () => {
    expect(
      grokAuthSignedIn('{"https://auth.x.ai::client":{"access_token":"x"}}'),
    ).toBe(true);
  });

  it("is signed out when auth.json is missing or empty", () => {
    expect(grokAuthSignedIn(null)).toBe(false);
    expect(grokAuthSignedIn("{}")).toBe(false);
  });

  it("is unknown when auth.json cannot be parsed", () => {
    expect(grokAuthSignedIn("{not json")).toBeNull();
  });
});

describe("agyModelsSignedIn", () => {
  it("is signed in when agy lists models", () => {
    expect(
      agyModelsSignedIn(
        "gemini-3.8-flash-high\tGemini 3.8 Flash (High)\ngemini-3.8-flash-low\tGemini 3.8 Flash (Low)\n",
      ),
    ).toBe(true);
  });

  it("is signed out when agy asks for authentication", () => {
    expect(
      agyModelsSignedIn(
        "Authentication required. Please visit the URL to log in:\n  https://accounts.google.com/o/oauth2/auth?x=1\n",
      ),
    ).toBe(false);
  });

  it("is unknown for empty or unexpected output", () => {
    expect(agyModelsSignedIn("")).toBeNull();
    expect(agyModelsSignedIn("something went wrong")).toBeNull();
  });
});

describe("isCliAgentId", () => {
  it("accepts only the supported CLIs", () => {
    expect(isCliAgentId("grok")).toBe(true);
    expect(isCliAgentId("agy")).toBe(true);
    expect(isCliAgentId("codex")).toBe(false);
  });
});
