"use client";

import type { AiProviderConfiguration, AiProviderName } from "@fantasy/contracts";
import {
  AlertCircle,
  ArrowUpRight,
  Check,
  Eye,
  EyeOff,
  LoaderCircle,
  Save,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { apiBaseUrl, parseAiProviderConfiguration, parseAiProviderList } from "../lib/api-client";
import { aiModelOptions, customModelOption, isKnownAiModel } from "../lib/ai-model-options";
import styles from "./ai-provider-settings.module.css";

/**
 * Extracted from the former Film Room provider form (see git history on
 * film-room-workbench.tsx) so BYOK management has a single home: Settings.
 * Owns its own load/save state against the existing /v1/ai/providers endpoints —
 * no new API. Film Room and the AI Coach panel now only link here.
 */
const PROVIDERS: Readonly<
  Record<
    AiProviderName,
    {
      readonly name: string;
      readonly shortName: string;
      readonly description: string;
      readonly keyUrl: string;
    }
  >
> = {
  openai: {
    name: "OpenAI",
    shortName: "OA",
    description: "Native Responses API",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  anthropic: {
    name: "Anthropic",
    shortName: "AN",
    description: "Native Claude Messages API",
    keyUrl: "https://console.anthropic.com/settings/keys",
  },
  gemini: {
    name: "Google Gemini",
    shortName: "G",
    description: "Native Interactions API",
    keyUrl: "https://aistudio.google.com/app/apikey",
  },
  openrouter: {
    name: "OpenRouter",
    shortName: "OR",
    description: "One key, broad model catalog",
    keyUrl: "https://openrouter.ai/settings/keys",
  },
};

type LoadState =
  | { readonly state: "loading" }
  | { readonly state: "signed-out" }
  | { readonly state: "error"; readonly message: string }
  | { readonly state: "ready"; readonly providers: readonly AiProviderConfiguration[] };

type ActionState =
  | { readonly state: "idle" }
  | { readonly state: "saving" | "testing" | "deleting" }
  | { readonly state: "success"; readonly message: string }
  | { readonly state: "error"; readonly message: string };

async function responseMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { readonly detail?: unknown; readonly title?: unknown };
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.title === "string") return body.title;
  } catch {
    // The status-aware fallback remains safe for an empty response.
  }
  return `${fallback} (${response.status})`;
}

function statusLabel(provider: AiProviderConfiguration): string {
  if (provider.accessMode === "managed") return "Included";
  if (!provider.configured) return "Add a key";
  if (provider.status === "invalid") return "Key rejected";
  if (provider.lastValidatedAt) return "Verified";
  return "Saved · untested";
}

function readableTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function AiProviderSettings() {
  const [load, setLoad] = useState<LoadState>({ state: "loading" });
  const [selectedProvider, setSelectedProvider] = useState<AiProviderName>("gemini");
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState("");
  const [dailyRequestLimit, setDailyRequestLimit] = useState("25");
  const [maxOutputTokens, setMaxOutputTokens] = useState("2000");
  const [settingsAction, setSettingsAction] = useState<ActionState>({ state: "idle" });
  const [deleteArmed, setDeleteArmed] = useState(false);

  const loadProviders = useCallback(async () => {
    setLoad({ state: "loading" });
    try {
      const response = await fetch(`${apiBaseUrl}/v1/ai/providers`, {
        credentials: "include",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (response.status === 401) {
        setLoad({ state: "signed-out" });
        return;
      }
      if (!response.ok) {
        throw new Error(await responseMessage(response, "Could not load AI providers"));
      }
      const parsed = parseAiProviderList(await response.json());
      if (!parsed) throw new Error("The AI provider response was not recognized");
      setLoad({ state: "ready", providers: parsed.providers });
      const firstAvailable = parsed.providers.find((provider) => provider.available);
      setSelectedProvider((current) => {
        const currentProvider = parsed.providers.find((provider) => provider.provider === current);
        return currentProvider?.available ? current : (firstAvailable?.provider ?? "gemini");
      });
    } catch (error) {
      setLoad({
        state: "error",
        message: error instanceof Error ? error.message : "Could not load AI provider settings",
      });
    }
  }, []);

  useEffect(() => void loadProviders(), [loadProviders]);

  const currentProvider = useMemo(
    () =>
      load.state === "ready"
        ? load.providers.find((provider) => provider.provider === selectedProvider)
        : undefined,
    [load, selectedProvider],
  );

  const providerName = currentProvider?.provider;
  const providerAccessMode = currentProvider?.accessMode;
  const providerConfigured = currentProvider?.configured;
  const providerModel = currentProvider?.model;
  const providerDailyRequestLimit = currentProvider?.dailyRequestLimit;
  const providerMaxOutputTokens = currentProvider?.maxOutputTokens;

  useEffect(() => {
    if (
      !providerName ||
      !providerAccessMode ||
      providerConfigured === undefined ||
      !providerModel ||
      providerDailyRequestLimit === undefined ||
      providerMaxOutputTokens === undefined
    ) {
      return;
    }
    setModel(providerModel);
    setDailyRequestLimit(String(providerDailyRequestLimit));
    setMaxOutputTokens(String(providerMaxOutputTokens));
    setApiKey("");
    setShowKey(false);
    setDeleteArmed(false);
  }, [
    providerAccessMode,
    providerConfigured,
    providerDailyRequestLimit,
    providerMaxOutputTokens,
    providerModel,
    providerName,
  ]);

  const settingsDirty = useMemo(() => {
    if (!currentProvider) return false;
    return (
      apiKey.trim().length > 0 ||
      model.trim() !== currentProvider.model ||
      dailyRequestLimit !== String(currentProvider.dailyRequestLimit) ||
      maxOutputTokens !== String(currentProvider.maxOutputTokens)
    );
  }, [apiKey, currentProvider, dailyRequestLimit, maxOutputTokens, model]);

  useEffect(() => {
    if (!settingsDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [settingsDirty]);

  const selectProvider = (provider: AiProviderName) => {
    if (provider === selectedProvider) return;
    if (
      settingsDirty &&
      !window.confirm("Discard your unsaved provider changes and switch providers?")
    ) {
      return;
    }
    setSettingsAction({ state: "idle" });
    setDeleteArmed(false);
    setSelectedProvider(provider);
  };

  const resetSettings = () => {
    if (!currentProvider) return;
    setApiKey("");
    setShowKey(false);
    setModel(currentProvider.model);
    setDailyRequestLimit(String(currentProvider.dailyRequestLimit));
    setMaxOutputTokens(String(currentProvider.maxOutputTokens));
    setDeleteArmed(false);
    setSettingsAction({ state: "idle" });
  };

  const replaceProvider = (configuration: AiProviderConfiguration) => {
    setLoad((current) =>
      current.state === "ready"
        ? {
            ...current,
            providers: current.providers.map((provider) =>
              provider.provider === configuration.provider ? configuration : provider,
            ),
          }
        : current,
    );
  };

  const saveSettings = async (event: FormEvent) => {
    event.preventDefault();
    setSettingsAction({ state: "saving" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/ai/providers/${encodeURIComponent(selectedProvider)}`,
        {
          method: "PUT",
          credentials: "include",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
            model: model.trim(),
            dailyRequestLimit: Number(dailyRequestLimit),
            maxOutputTokens: Number(maxOutputTokens),
          }),
        },
      );
      if (!response.ok) throw new Error(await responseMessage(response, "Could not save provider"));
      const parsed = parseAiProviderConfiguration(await response.json());
      if (!parsed) throw new Error("The saved provider response was not recognized");
      replaceProvider(parsed);
      setApiKey("");
      setModel(parsed.model);
      setDailyRequestLimit(String(parsed.dailyRequestLimit));
      setMaxOutputTokens(String(parsed.maxOutputTokens));
      setSettingsAction({
        state: "success",
        message: apiKey.trim()
          ? "Key encrypted and settings saved. Run the connection test next."
          : "Provider settings saved.",
      });
    } catch (error) {
      setSettingsAction({
        state: "error",
        message: error instanceof Error ? error.message : "Could not save provider",
      });
    }
  };

  const testConnection = async () => {
    setSettingsAction({ state: "testing" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/ai/providers/${encodeURIComponent(selectedProvider)}/test`,
        { method: "POST", credentials: "include", headers: { Accept: "application/json" } },
      );
      if (!response.ok) {
        throw new Error(await responseMessage(response, "Connection test failed"));
      }
      await loadProviders();
      setSelectedProvider(selectedProvider);
      setSettingsAction({ state: "success", message: "Connection verified with a live request." });
    } catch (error) {
      setSettingsAction({
        state: "error",
        message: error instanceof Error ? error.message : "Connection test failed",
      });
    }
  };

  const removeProvider = async () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      setSettingsAction({ state: "idle" });
      return;
    }
    setSettingsAction({ state: "deleting" });
    try {
      const response = await fetch(
        `${apiBaseUrl}/v1/ai/providers/${encodeURIComponent(selectedProvider)}`,
        { method: "DELETE", credentials: "include", headers: { Accept: "application/json" } },
      );
      if (!response.ok) throw new Error(await responseMessage(response, "Could not remove key"));
      await loadProviders();
      setSelectedProvider(selectedProvider);
      setDeleteArmed(false);
      setSettingsAction({ state: "success", message: "The encrypted key was removed." });
    } catch (error) {
      setSettingsAction({
        state: "error",
        message: error instanceof Error ? error.message : "Could not remove key",
      });
    }
  };

  if (load.state === "loading") {
    return (
      <div className={styles.stateBlock} role="status">
        <LoaderCircle className={styles.spin} size={20} aria-hidden="true" />
        <div>
          <strong>Loading provider settings</strong>
          <span>Reading your saved AI provider configuration.</span>
        </div>
      </div>
    );
  }

  if (load.state === "signed-out") {
    return (
      <div className={styles.stateBlock} role="alert">
        <ShieldAlert size={20} aria-hidden="true" />
        <div>
          <strong>Sign in to manage AI provider settings</strong>
          <span>Provider settings are only available to a signed-in member.</span>
        </div>
      </div>
    );
  }

  if (load.state === "error") {
    return (
      <div className={`${styles.stateBlock} ${styles.errorState}`} role="alert">
        <AlertCircle size={20} aria-hidden="true" />
        <div>
          <strong>AI provider settings unavailable</strong>
          <span>{load.message}</span>
        </div>
        <button
          className={styles.secondaryButton}
          type="button"
          onClick={() => void loadProviders()}
        >
          Try again
        </button>
      </div>
    );
  }

  const providerMeta = PROVIDERS[selectedProvider];
  const byokControlsEnabled = Boolean(currentProvider?.configured || apiKey.trim());
  const providerModelOptions = aiModelOptions[selectedProvider];
  const selectedModelOption = isKnownAiModel(selectedProvider, model) ? model : customModelOption;
  const settingsBusy =
    settingsAction.state === "saving" ||
    settingsAction.state === "testing" ||
    settingsAction.state === "deleting";

  return (
    <div className={styles.wrapper}>
      <div className={styles.providerTabs} role="tablist" aria-label="AI providers">
        {load.providers.map((provider) => {
          const meta = PROVIDERS[provider.provider];
          const selected = provider.provider === selectedProvider;
          return (
            <button
              key={provider.provider}
              className={`${styles.providerTab} ${styles[provider.provider]}${selected ? ` ${styles.selected}` : ""}`}
              type="button"
              role="tab"
              aria-selected={selected}
              aria-controls="provider-settings-panel"
              id={`provider-tab-${provider.provider}`}
              onClick={() => selectProvider(provider.provider)}
            >
              <span className={styles.providerMark}>{meta.shortName}</span>
              <span className={styles.providerCopy}>
                <strong>{meta.name}</strong>
                <small>{statusLabel(provider)}</small>
              </span>
              <span
                className={`${styles.statusDot}${provider.available ? ` ${styles.statusReady}` : ""}${provider.status === "invalid" ? ` ${styles.statusInvalid}` : ""}`}
                aria-hidden="true"
              />
            </button>
          );
        })}
      </div>

      <div
        className={styles.panelBody}
        id="provider-settings-panel"
        role="tabpanel"
        aria-labelledby={`provider-tab-${selectedProvider}`}
      >
        <div className={styles.panelHeader}>
          <div>
            <p className={styles.eyebrow}>
              {currentProvider?.configured ? "Your provider setup" : "Optional BYOK setup"}
            </p>
            <h3 id="provider-settings-heading">{providerMeta.name}</h3>
            <span>{providerMeta.description}</span>
          </div>
          <a href={providerMeta.keyUrl} target="_blank" rel="noreferrer">
            {currentProvider?.accessMode === "managed" ? "Get personal key" : "Get API key"}
            <ArrowUpRight size={14} />
          </a>
        </div>

        <form className={styles.settingsForm} onSubmit={(event) => void saveSettings(event)}>
          {currentProvider?.accessMode === "managed" ? (
            <div className={`${styles.notice} ${styles.noticeSuccess}`} role="status">
              <Check size={16} />
              <span>
                Included Gemini is ready now. Adding your own key is optional and will replace the
                included model for your account until you remove it. Included calls use the
                host&apos;s Google AI Studio free-tier project and Google&apos;s free-tier data
                terms.
              </span>
            </div>
          ) : null}
          <label className={styles.field}>
            <span>{currentProvider?.configured ? "Replace API key" : "API key"}</span>
            <div className={styles.secretField}>
              <input
                aria-describedby="provider-key-help"
                aria-invalid={currentProvider?.status === "invalid" || undefined}
                name={`${selectedProvider}-api-key`}
                type={showKey ? "text" : "password"}
                value={apiKey}
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setDeleteArmed(false);
                  setSettingsAction({ state: "idle" });
                }}
                autoComplete="new-password"
                spellCheck={false}
                placeholder={
                  currentProvider?.configured ? "Leave blank to keep the saved key" : "Paste key"
                }
                required={!currentProvider?.configured && currentProvider?.accessMode !== "managed"}
              />
              <button
                type="button"
                aria-label={showKey ? "Hide API key" : "Show API key"}
                onClick={() => setShowKey((current) => !current)}
              >
                {showKey ? <EyeOff size={17} /> : <Eye size={17} />}
              </button>
            </div>
            <small id="provider-key-help">
              Optional. Personal keys are encrypted and never shown again. Provider API usage is
              billed to that key&apos;s account.
            </small>
          </label>

          <label className={styles.field}>
            <span>Model</span>
            <select
              value={selectedModelOption}
              onChange={(event) => {
                setModel(event.target.value === customModelOption ? "" : event.target.value);
                setSettingsAction({ state: "idle" });
              }}
              disabled={!byokControlsEnabled}
            >
              {providerModelOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
              <option value={customModelOption}>Custom model ID…</option>
            </select>
            <small>
              {byokControlsEnabled
                ? "Your key unlocks provider-specific model selection."
                : "The included model is fixed. Add your own key to choose another model."}
            </small>
          </label>

          {selectedModelOption === customModelOption && byokControlsEnabled ? (
            <label className={styles.field}>
              <span>Custom model ID</span>
              <input
                value={model}
                onChange={(event) => {
                  setModel(event.target.value);
                  setSettingsAction({ state: "idle" });
                }}
                minLength={1}
                maxLength={160}
                required
                spellCheck={false}
                placeholder="Enter the exact provider model ID"
              />
              <small>Use this for a model that is not yet listed above.</small>
            </label>
          ) : null}

          <div className={styles.fieldRow}>
            <label className={styles.field}>
              <span>Requests per day</span>
              <input
                type="number"
                min="1"
                max="500"
                value={dailyRequestLimit}
                onChange={(event) => {
                  setDailyRequestLimit(event.target.value);
                  setSettingsAction({ state: "idle" });
                }}
                required
                disabled={!byokControlsEnabled}
              />
            </label>
            <label className={styles.field}>
              <span>Max answer tokens</span>
              <input
                type="number"
                min="64"
                max="8192"
                value={maxOutputTokens}
                onChange={(event) => {
                  setMaxOutputTokens(event.target.value);
                  setSettingsAction({ state: "idle" });
                }}
                required
                disabled={!byokControlsEnabled}
              />
            </label>
          </div>

          {currentProvider ? (
            <div className={styles.usageLine}>
              <span>
                <strong>{currentProvider.requestsRemaining}</strong> requests left today
              </span>
              <span>
                {currentProvider.requestsToday} of {currentProvider.dailyRequestLimit} used
              </span>
            </div>
          ) : null}

          {settingsAction.state === "success" || settingsAction.state === "error" ? (
            <div
              className={`${styles.notice} ${settingsAction.state === "error" ? styles.noticeError : styles.noticeSuccess}`}
              role={settingsAction.state === "error" ? "alert" : "status"}
            >
              {settingsAction.state === "error" ? <AlertCircle size={16} /> : <Check size={16} />}
              <span>{settingsAction.message}</span>
            </div>
          ) : null}

          <div className={styles.formActions}>
            <button
              className={styles.primaryButton}
              type="submit"
              disabled={settingsBusy || !settingsDirty}
            >
              {settingsAction.state === "saving" ? (
                <LoaderCircle className={styles.spin} size={16} />
              ) : (
                <Save size={16} />
              )}
              {settingsAction.state === "saving"
                ? "Saving securely"
                : settingsDirty
                  ? "Save securely"
                  : "Settings saved"}
            </button>
            {settingsDirty ? (
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={resetSettings}
                disabled={settingsBusy}
              >
                Undo changes
              </button>
            ) : (
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => void testConnection()}
                disabled={!currentProvider?.configured || settingsBusy}
              >
                {settingsAction.state === "testing" ? (
                  <LoaderCircle className={styles.spin} size={16} />
                ) : (
                  <Check size={16} />
                )}
                {settingsAction.state === "testing" ? "Verifying key" : "Verify key"}
              </button>
            )}
          </div>

          {currentProvider?.configured ? (
            <div className={styles.removeRow}>
              <span>
                {currentProvider.lastValidatedAt
                  ? `Last verified ${readableTime(currentProvider.lastValidatedAt)}`
                  : "Saved key has not been tested yet."}
              </span>
              <span className={styles.removeActions}>
                {deleteArmed ? (
                  <button
                    className={styles.cancelRemoval}
                    type="button"
                    onClick={() => setDeleteArmed(false)}
                    disabled={settingsBusy}
                  >
                    Cancel
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void removeProvider()}
                  disabled={settingsBusy || settingsDirty}
                  title={
                    settingsDirty ? "Undo or save your changes before removing this key" : undefined
                  }
                >
                  {settingsAction.state === "deleting" ? (
                    <LoaderCircle className={styles.spin} size={14} />
                  ) : (
                    <Trash2 size={14} />
                  )}
                  {settingsAction.state === "deleting"
                    ? "Removing key"
                    : deleteArmed
                      ? "Yes, remove key"
                      : "Remove key"}
                </button>
              </span>
            </div>
          ) : null}
        </form>
      </div>
    </div>
  );
}
