/** Coding-agent CLIs Hermes can delegate to with the user's own subscription. */
export const CLI_AGENT_IDS = ["grok", "agy"] as const;
export type CliAgentId = (typeof CLI_AGENT_IDS)[number];

export interface CliAgentStatus {
  id: CliAgentId;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** null when sign-in could not be determined. */
  signedIn: boolean | null;
  /** The matching Hermes skill is installed, so the agent can delegate to it. */
  enabled: boolean;
}

export interface CliAgentStatusResponse {
  /** False when Hermes runs on a remote host, where these CLIs don't apply. */
  supported: boolean;
  agents: CliAgentStatus[];
}
