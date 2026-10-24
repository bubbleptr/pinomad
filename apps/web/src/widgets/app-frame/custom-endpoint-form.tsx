import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useRef, useState, type FormEvent } from "react";
import { CUSTOM_PROVIDER_APIS, type CustomProviderApi, type ProviderInfo } from "@pinomad/protocol/auth.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { InlineError } from "./provider-login.tsx";

const API_LABELS: Record<CustomProviderApi, string> = {
  "openai-completions": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic Messages",
  "google-generative-ai": "Google Gemini",
};

const messageOf = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/** A new endpoint's id: its name in lowercase letters, digits and `-`. */
const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

const baseUrlProblem = (url: string): string | undefined => {
  if (url.trim() === "") return "Enter the base URL";
  try {
    const parsed = new URL(url.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Use an http:// or https:// URL";
  } catch {
    return "Enter a full URL, like http://localhost:11434/v1";
  }
  return undefined;
};

const modelsOf = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/**
 * Add or edit a custom endpoint (ADR-0031). The key field is write-only: the
 * host never sends a stored key back, so editing leaves it empty and an
 * empty field keeps what is stored.
 */
export function CustomEndpointForm({
  existing,
  providers,
  remote,
  connected,
  onDone,
  onCancel,
}: {
  /** The endpoint being edited; absent when adding one. */
  existing?: ProviderInfo;
  /** Every provider the host lists, to catch an id clash before saving. */
  providers: readonly ProviderInfo[];
  remote: RemoteDurable;
  connected: boolean;
  onDone: () => void;
  onCancel: () => void;
}) {
  const custom = existing?.custom;
  const [name, setName] = useState(existing?.name ?? "");
  const [api, setApi] = useState<CustomProviderApi>(custom?.api ?? "openai-completions");
  const [baseUrl, setBaseUrl] = useState(custom?.baseUrl ?? "");
  const [urlTouched, setUrlTouched] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState((custom?.models ?? []).join("\n"));
  const [fetching, setFetching] = useState(false);
  const [fetchProblem, setFetchProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);

  const id = existing?.id ?? slugOf(name);
  const urlProblem = baseUrlProblem(baseUrl);
  const modelList = modelsOf(models);
  const nameProblem =
    name.trim() === ""
      ? submitted
        ? "Name it so it's recognizable in the model picker"
        : undefined
      : existing !== undefined
        ? undefined
        : id === ""
          ? "Use at least one letter or digit (a–z, 0–9) in the name"
          : providers.some((provider) => provider.id === id)
            ? `“${id}” is already a provider on this host; choose another name`
            : undefined;

  // An answer is for the endpoint as it was asked about: dropped if the
  // format, URL or key changed meanwhile, if a newer fetch went out, or if
  // the models were edited by hand while it was on its way.
  const current = useRef({ api, baseUrl, apiKey, models });
  current.current = { api, baseUrl, apiKey, models };
  const fetches = useRef(0);

  const fetchModels = async (): Promise<void> => {
    setUrlTouched(true);
    if (urlProblem !== undefined) return;
    const mine = ++fetches.current;
    const asked = current.current;
    const stillAsked = (): boolean => {
      const now = current.current;
      return mine === fetches.current && now.api === asked.api && now.baseUrl === asked.baseUrl && now.apiKey === asked.apiKey;
    };
    setFetching(true);
    setFetchProblem(undefined);
    try {
      const listed = await remote.controller.listEndpointModels({
        api,
        baseUrl: baseUrl.trim(),
        ...(apiKey === "" ? {} : { apiKey }),
        ...(existing === undefined ? {} : { providerId: existing.id }),
      });
      if (!stillAsked()) return;
      if (listed.length === 0) setFetchProblem("The endpoint listed no models. Enter model IDs by hand.");
      else if (current.current.models === asked.models) setModels(listed.join("\n"));
    } catch (reason) {
      if (stillAsked()) setFetchProblem(`${messageOf(reason)} Enter model IDs by hand.`);
    } finally {
      if (mine === fetches.current) setFetching(false);
    }
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitted(true);
    setUrlTouched(true);
    if (name.trim() === "" || nameProblem !== undefined || urlProblem !== undefined || modelList.length === 0) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await remote.controller.saveCustomProvider(
        { id, name: name.trim(), api, baseUrl: baseUrl.trim(), models: modelList },
        apiKey === "" ? undefined : apiKey,
      );
      onDone();
    } catch (reason) {
      setSaveError(messageOf(reason));
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} autoComplete="off">
      <VStack gap={3}>
        <TextInput
          label="Name"
          value={name}
          onChange={setName}
          placeholder="Ollama on studio"
          hasAutoFocus={existing === undefined}
          isDisabled={!connected}
          width="100%"
          status={nameProblem === undefined ? undefined : { type: "error", message: nameProblem }}
        />
        <Selector
          label="API format"
          options={CUSTOM_PROVIDER_APIS.map((value) => ({ value, label: API_LABELS[value] }))}
          value={api}
          onChange={(value) => setApi(value as CustomProviderApi)}
          description="Ollama, LM Studio, vLLM and most gateways speak OpenAI Chat Completions."
          isDisabled={!connected}
          width="100%"
        />
        {/* Validated on blur: a half-typed URL isn't an error yet. */}
        <div onBlur={() => setUrlTouched(true)}>
          <TextInput
            label="Base URL"
            value={baseUrl}
            onChange={setBaseUrl}
            placeholder="http://localhost:11434/v1"
            isDisabled={!connected}
            width="100%"
            status={urlTouched && urlProblem !== undefined ? { type: "error", message: urlProblem } : undefined}
          />
        </div>
        <TextInput
          label="API key"
          type="password"
          isOptional
          value={apiKey}
          onChange={setApiKey}
          placeholder={existing?.stored === undefined ? "Not needed for local servers" : "Leave empty to keep the stored key"}
          isDisabled={!connected}
          width="100%"
        />
        <VStack gap={2}>
          <TextArea
            label="Models"
            description="One model ID per line, as the endpoint names it."
            value={models}
            onChange={setModels}
            rows={Math.min(8, Math.max(3, modelList.length))}
            hasSpellCheck={false}
            isDisabled={!connected}
            width="100%"
            status={
              fetchProblem !== undefined
                ? { type: "warning", message: fetchProblem }
                : submitted && modelList.length === 0
                  ? { type: "error", message: "Add at least one model" }
                  : undefined
            }
          />
          <HStack gap={2} vAlign="center">
            <Button
              label={fetching ? "Fetching…" : "Fetch from /models"}
              size="sm"
              isLoading={fetching}
              isDisabled={!connected}
              onClick={() => void fetchModels()}
            />
            {modelList.length > 0 ? (
              <Text type="supporting" style={{ fontVariantNumeric: "tabular-nums" }}>
                {`${modelList.length} model${modelList.length === 1 ? "" : "s"}`}
              </Text>
            ) : null}
          </HStack>
        </VStack>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Button
            label={existing === undefined ? "Add endpoint" : "Save changes"}
            variant="primary"
            type="submit"
            isLoading={saving}
            isDisabled={!connected}
          />
          <Button label="Cancel" variant="ghost" onClick={onCancel} />
          {saveError === undefined ? null : <InlineError message={saveError} />}
        </HStack>
      </VStack>
    </form>
  );
}

/** "Remove endpoint…" with an inline confirm step. */
export function RemoveEndpoint({
  providerId,
  remote,
  connected,
  onRemoved,
}: {
  providerId: string;
  remote: RemoteDurable;
  connected: boolean;
  onRemoved: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string>();
  if (!confirming) {
    return (
      <div>
        <Button label="Remove endpoint…" variant="ghost" size="sm" isDisabled={!connected} onClick={() => setConfirming(true)} />
      </div>
    );
  }
  return (
    <VStack gap={2}>
      <Text as="p" type="supporting">
        Its models disappear from the model picker, and conversations using them stop.
      </Text>
      <HStack gap={2} vAlign="center" wrap="wrap">
        <Button
          label="Remove endpoint"
          variant="destructive"
          size="sm"
          isDisabled={!connected}
          clickAction={() =>
            remote.controller.removeCustomProvider(providerId).then(onRemoved, (reason: unknown) => setError(messageOf(reason)))
          }
        />
        <Button label="Cancel" variant="ghost" size="sm" onClick={() => setConfirming(false)} />
        {error === undefined ? null : <InlineError message={error} />}
      </HStack>
    </VStack>
  );
}
