import { useCallback, useEffect, useRef, useState } from "react";
import { LogIn, RefreshCw } from "lucide-react";
import BrandLogo from "./common/BrandLogo";
import { Toggle } from "./common/Toggle";
import { useI18n } from "./useI18n";
import {
  CLI_AGENT_IDS,
  type CliAgentId,
  type CliAgentStatusResponse,
} from "../../../shared/cli-agents";

const IS_WINDOWS = navigator.userAgent.includes("Windows");

const CARDS: Record<
  CliAgentId,
  {
    name: string;
    desc: string;
    logo: string;
    signInCommand: string;
    install: string;
  }
> = {
  grok: {
    name: "providers.cliAgents.grokName",
    desc: "providers.cliAgents.grokDesc",
    logo: "grok",
    signInCommand: "grok login",
    install: "npm install -g @xai-official/grok",
  },
  agy: {
    name: "providers.cliAgents.agyName",
    desc: "providers.cliAgents.agyDesc",
    logo: "gemini",
    signInCommand: "agy",
    install: IS_WINDOWS
      ? "irm https://antigravity.google/cli/install.ps1 | iex"
      : "curl -fsSL https://antigravity.google/cli/install.sh | bash",
  },
};

/**
 * Providers-screen cards for coding-agent CLI subscriptions. A card's switch
 * installs or removes the Hermes skill that lets the agent delegate to that
 * CLI, and stays disabled until the CLI reports a signed-in account.
 */
export default function CliAgentsSection({
  profile,
}: {
  profile?: string;
}): React.JSX.Element {
  const { t } = useI18n();
  const [status, setStatus] = useState<CliAgentStatusResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<CliAgentId | null>(null);
  const [notes, setNotes] = useState<Partial<Record<CliAgentId, string>>>({});
  // A sign-in happens in another window; re-check when the user comes back.
  const awaitingSignIn = useRef(false);

  const load = useCallback(
    async (refresh: boolean): Promise<void> => {
      setLoading(true);
      try {
        setStatus(await window.hermesAPI.getCliAgentStatuses(profile, refresh));
      } catch {
        setStatus({ supported: true, agents: [] });
      } finally {
        setLoading(false);
      }
    },
    [profile],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  useEffect(() => {
    const onFocus = (): void => {
      if (!awaitingSignIn.current) return;
      awaitingSignIn.current = false;
      void load(true);
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [load]);

  async function signIn(id: CliAgentId): Promise<void> {
    const opened = await window.hermesAPI.openCliAgentSignIn(id);
    awaitingSignIn.current = opened;
    setNotes((prev) => ({
      ...prev,
      [id]: opened
        ? t("providers.cliAgents.signInHint")
        : t("providers.cliAgents.signInFailed", {
            command: CARDS[id].signInCommand,
          }),
    }));
  }

  async function setEnabled(id: CliAgentId, enabled: boolean): Promise<void> {
    setBusy(id);
    setNotes((prev) => ({ ...prev, [id]: undefined }));
    try {
      const result = await window.hermesAPI.setCliAgentEnabled(
        id,
        enabled,
        profile,
      );
      if (result.success) {
        setStatus((prev) =>
          prev
            ? {
                ...prev,
                agents: prev.agents.map((a) =>
                  a.id === id ? { ...a, enabled } : a,
                ),
              }
            : prev,
        );
      } else {
        setNotes((prev) => ({
          ...prev,
          [id]: result.error || t("providers.cliAgents.toggleFailed"),
        }));
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="settings-section">
      <div className="settings-section-title cli-agents-title">
        {t("providers.cliAgents.sectionTitle")}
        {status?.supported !== false && (
          <button
            type="button"
            className="btn-ghost btn-sm cli-agents-refresh"
            onClick={() => void load(true)}
            disabled={loading}
          >
            <RefreshCw size={13} className={loading ? "spin" : undefined} />
            {loading
              ? t("providers.cliAgents.checking")
              : t("providers.cliAgents.refresh")}
          </button>
        )}
      </div>
      <div className="settings-field-hint" style={{ marginBottom: 10 }}>
        {status?.supported === false
          ? t("providers.cliAgents.remoteHint")
          : t("providers.cliAgents.sectionHint")}
      </div>
      {status?.supported !== false && (
        <div className="provider-keys-grid">
          {CLI_AGENT_IDS.map((id) => {
            const card = CARDS[id];
            const agent = status?.agents.find((a) => a.id === id);
            const signedOut = agent?.signedIn === false;
            let state: string;
            if (!agent) state = t("providers.cliAgents.checking");
            else if (!agent.installed)
              state = t("providers.cliAgents.notInstalled");
            else if (agent.signedIn === true)
              state = t("providers.cliAgents.ready", {
                version: agent.version || "",
              });
            else if (signedOut) state = t("providers.cliAgents.notSignedIn");
            else state = t("providers.cliAgents.signInUnknown");

            return (
              <div key={id} className="provider-key-card">
                <div className="provider-key-card-head">
                  <BrandLogo provider={card.logo} size={22} />
                  <span className="provider-key-card-title">
                    {t(card.name)}
                  </span>
                </div>
                <div className="settings-field-hint">{t(card.desc)}</div>
                <div
                  className={`cli-agent-state${agent?.installed && agent.signedIn === true ? " ready" : ""}`}
                >
                  {state}
                </div>
                {agent && !agent.installed && (
                  <code className="cli-agent-install">{card.install}</code>
                )}
                {agent?.installed && (
                  <div
                    className="cli-agent-toggle-row"
                    title={
                      signedOut
                        ? t("providers.cliAgents.enableFirst")
                        : undefined
                    }
                  >
                    <span>{t("providers.cliAgents.useLabel")}</span>
                    <Toggle
                      checked={agent.enabled}
                      label={`${t("providers.cliAgents.useLabel")} — ${t(card.name)}`}
                      disabled={signedOut || busy === id}
                      onCheckedChange={(next) => setEnabled(id, next)}
                    />
                  </div>
                )}
                {agent?.installed && agent.signedIn !== true && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm oauth-signin-btn"
                    onClick={() => void signIn(id)}
                  >
                    <LogIn size={14} />
                    {t("providers.cliAgents.signIn")}
                  </button>
                )}
                {notes[id] && (
                  <div className="settings-field-hint">{notes[id]}</div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
