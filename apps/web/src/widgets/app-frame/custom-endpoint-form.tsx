import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "../../shared/ui/button.tsx";
import { IconButton } from "../../shared/ui/icon-button.tsx";
import { MultiSelector } from "@astryxdesign/core/MultiSelector";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/select.tsx";
import { Field, FieldDescription, FieldError, FieldLabel } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { CUSTOM_PROVIDER_APIS, type CustomProviderApi, type ProviderInfo } from "@pinomad/protocol/auth.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { Plus, RefreshCw } from "../../shared/ui/icons.tsx";
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

/** `list` followed by whatever of `more` it lacks. */
const withNew = (list: readonly string[], more: readonly string[]): string[] => [
  ...list,
  ...more.filter((model, index) => !list.includes(model) && more.indexOf(model) === index),
];

/**
 * Add or edit a custom endpoint (ADR-0031). The key field is write-only: the
 * host never sends a stored key back, so editing leaves it empty and an
 * empty field keeps what is stored. The models dropdown offers what the
 * endpoint lists plus any IDs added by hand; only the checked ones are saved.
 */
export function CustomEndpointForm({
  existing,
  providers,
  remote,
  connected,
  onDone,
  onCancel,
  onRemoved,
}: {
  /** The endpoint being edited; absent when adding one. */
  existing?: ProviderInfo;
  /** Every provider the host lists, to catch an id clash before saving. */
  providers: readonly ProviderInfo[];
  remote: RemoteDurable;
  connected: boolean;
  onDone: () => void;
  onCancel: () => void;
  /** After the edited endpoint is removed. */
  onRemoved: () => void;
}) {
  const custom = existing?.custom;
  const [name, setName] = useState(existing?.name ?? "");
  const [api, setApi] = useState<CustomProviderApi>(custom?.api ?? "openai-completions");
  const [baseUrl, setBaseUrl] = useState(custom?.baseUrl ?? "");
  const [urlTouched, setUrlTouched] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [options, setOptions] = useState<string[]>([...(custom?.models ?? [])]);
  const [checked, setChecked] = useState<string[]>([...(custom?.models ?? [])]);
  const [draft, setDraft] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchProblem, setFetchProblem] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [submitted, setSubmitted] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string>();

  const id = existing?.id ?? slugOf(name);
  const urlProblem = baseUrlProblem(baseUrl);
  const modelsStatus: { type: "warning" | "error"; message: string } | undefined =
    fetchProblem !== undefined
      ? { type: "warning", message: fetchProblem }
      : submitted && checked.length === 0
        ? { type: "error", message: "Add at least one model" }
        : undefined;
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
  // format, URL or key changed meanwhile, or if a newer fetch went out. It
  // only adds options; it checks them all only if nothing is checked yet.
  // Only a fetch the user started reports a failure or an empty list: the
  // one on opening an endpoint without /models stays quiet.
  const current = useRef({ api, baseUrl, apiKey, checked });
  current.current = { api, baseUrl, apiKey, checked };
  const fetches = useRef(0);

  const fetchModels = async (startedByUser: boolean): Promise<void> => {
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
      if (listed.length === 0) {
        if (startedByUser) setFetchProblem("The endpoint listed no models. Add model IDs by hand.");
        return;
      }
      setOptions((was) => withNew(was, listed));
      if (current.current.checked.length === 0) setChecked(withNew([], listed));
    } catch (reason) {
      if (startedByUser && stillAsked()) setFetchProblem(`${messageOf(reason)} Add model IDs by hand.`);
    } finally {
      if (mine === fetches.current) setFetching(false);
    }
  };

  // Editing lists the endpoint's models once, with the stored key.
  const listedOnOpen = useRef(false);
  useEffect(() => {
    if (existing === undefined || !connected || listedOnOpen.current) return;
    listedOnOpen.current = true;
    void fetchModels(false);
  }, [connected]);

  const addDraft = (): void => {
    const model = draft.trim();
    if (model === "") return;
    setOptions((was) => withNew(was, [model]));
    setChecked((was) => withNew(was, [model]));
    setDraft("");
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSubmitted(true);
    setUrlTouched(true);
    if (name.trim() === "" || nameProblem !== undefined || urlProblem !== undefined || checked.length === 0) return;
    setSaving(true);
    setSaveError(undefined);
    try {
      await remote.controller.saveCustomProvider(
        { id, name: name.trim(), api, baseUrl: baseUrl.trim(), models: options.filter((model) => checked.includes(model)) },
        apiKey === "" ? undefined : apiKey,
      );
      onDone();
    } catch (reason) {
      setSaveError(messageOf(reason));
      setSaving(false);
    }
  };

  const remove = async (providerId: string): Promise<void> => {
    setRemoving(true);
    setRemoveError(undefined);
    try {
      await remote.controller.removeCustomProvider(providerId);
      onRemoved();
    } catch (reason) {
      setRemoveError(messageOf(reason));
      setConfirmingRemove(false);
      setRemoving(false);
    }
  };

  return (
    <form onSubmit={(event) => void submit(event)} autoComplete="off">
      <div className="flex flex-col gap-3">
        <Field disabled={!connected} invalid={nameProblem !== undefined}>
          <FieldLabel>Name</FieldLabel>
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Ollama on studio"
            autoFocus={existing === undefined}
            data-autofocus={existing === undefined || undefined}
          />
          <FieldError>{nameProblem}</FieldError>
        </Field>
        <Field disabled={!connected}>
          <FieldLabel>API format</FieldLabel>
          <FieldDescription>Ollama, LM Studio, vLLM and most gateways speak OpenAI Chat Completions.</FieldDescription>
          <Select
            items={API_LABELS}
            value={api}
            onValueChange={(value: string | null) => {
              if (value !== null) setApi(value as CustomProviderApi);
            }}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CUSTOM_PROVIDER_APIS.map((value) => (
                <SelectItem key={value} value={value}>{API_LABELS[value]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {/* Validated on blur: a half-typed URL isn't an error yet. */}
        <div onBlur={() => setUrlTouched(true)}>
          <Field disabled={!connected} invalid={urlTouched && urlProblem !== undefined}>
            <FieldLabel>Base URL</FieldLabel>
            <Input
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://localhost:11434/v1"
            />
            <FieldError>{urlTouched ? urlProblem : undefined}</FieldError>
          </Field>
        </div>
        <Field disabled={!connected}>
          <FieldLabel>
            API key
            <span className="-ms-2 text-xs font-normal text-muted-foreground">
              <span aria-hidden="true">{" ∙ "}</span>Optional
            </span>
          </FieldLabel>
          <Input
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={existing?.stored === undefined ? "Not needed for local servers" : "Leave empty to keep the stored key"}
          />
        </Field>
        {/* The status message sits outside the dropdown so the buttons line up with the controls. */}
        <div className="endpoint-models">
          <MultiSelector
            label="Models"
            description="Checked models appear in the model picker."
            options={options}
            value={checked}
            onChange={setChecked}
            placeholder={fetching ? "Fetching models…" : "No models yet"}
            hasSearch
            hasSelectAll
            isLoading={fetching}
            isDisabled={!connected}
            width="100%"
            status={modelsStatus === undefined ? undefined : { type: modelsStatus.type }}
          />
          <IconButton
            variant="secondary"
            label="Fetch models"
            tooltip="Fetch models from the endpoint"
            icon={<RefreshCw />}
            loading={fetching}
            disabled={!connected}
            onClick={() => void fetchModels(true)}
          />
          {modelsStatus === undefined ? null : (
            <div className="endpoint-models__status">
              {modelsStatus.type === "error" ? (
                <p role="alert" className="text-xs/5 text-destructive">{modelsStatus.message}</p>
              ) : (
                <p role="status" className="text-xs/5 text-warning">{modelsStatus.message}</p>
              )}
            </div>
          )}
          {/* Enter adds the ID instead of submitting the form. */}
          <div
            className="endpoint-models__add"
            onKeyDown={(event: KeyboardEvent) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addDraft();
            }}
          >
            <Field disabled={!connected}>
              <FieldLabel className="sr-only">Add model ID</FieldLabel>
              <Input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Add a model ID the endpoint doesn't list"
              />
            </Field>
          </div>
          <IconButton variant="secondary" label="Add model" icon={<Plus />} disabled={!connected || draft.trim() === ""} onClick={addDraft} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {existing === undefined ? null : (
            <Button variant="secondary" disabled={!connected} onClick={() => setConfirmingRemove(true)}>Remove endpoint</Button>
          )}
          {removeError === undefined ? null : <InlineError message={removeError} />}
          <div style={{ marginInlineStart: "auto" }}>
            <div className="flex flex-wrap items-center gap-2">
              {saveError === undefined ? null : <InlineError message={saveError} />}
              <Button variant="secondary" onClick={onCancel}>Cancel</Button>
              <Button
                variant="primary"
                type="submit"
                loading={saving}
                disabled={!connected}
              >
                {existing === undefined ? "Add endpoint" : "Save changes"}
              </Button>
            </div>
          </div>
        </div>
      </div>
      {existing === undefined ? null : (
        <AlertDialog
          isOpen={confirmingRemove}
          onOpenChange={setConfirmingRemove}
          title={`Remove ${existing.name}?`}
          description="Its models disappear from the model picker, and conversations using them stop."
          actionLabel="Remove endpoint"
          isActionLoading={removing}
          onAction={() => void remove(existing.id)}
        />
      )}
    </form>
  );
}
