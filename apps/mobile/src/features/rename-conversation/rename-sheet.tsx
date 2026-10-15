// The conversation list row's Rename sheet: a manual name is permanent —
// once written, the host never auto-titles the conversation again. Mirrors
// the web's RenameConversationDialog.
import { useEffect, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import {
  BottomSheet,
  Button,
  FieldError,
  Input,
  Label,
  TextField,
  useBottomSheetAwareHandlers,
} from "heroui-native";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { displayName } from "@pinomad/client/family.ts";

/**
 * Title input that keeps the sheet clear of the keyboard (see hero-ui
 * bottom-sheet docs). Focus is on mount — RenameForm mounts on open — a beat
 * past the slide-in, with the old name selected so typing replaces it.
 */
function SheetInput({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange(next: string): void;
  disabled: boolean;
}) {
  const { onFocus, onBlur } = useBottomSheetAwareHandlers();
  const inputRef = useRef<TextInput>(null);
  useEffect(() => {
    const timer = setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelection(0, value.length);
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- select-all once, on mount
  }, []);
  return (
    <Input
      ref={inputRef}
      value={value}
      onChangeText={onChange}
      placeholder="Conversation title"
      isDisabled={disabled}
      onFocus={onFocus}
      onBlur={onBlur}
    />
  );
}

function RenameForm({
  summary,
  remote,
  connected,
  close,
}: {
  summary: ConversationSummary;
  remote: RemoteDurable;
  connected: boolean;
  close(): void;
}) {
  const initial = displayName(summary);
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const title = value.trim();
  const save = (): void => {
    if (!connected || saving || title === "" || title === initial) return;
    setSaving(true);
    setError(undefined);
    void remote.controller.renameConversation(summary.id, title).then(
      () => close(),
      (reason: unknown) => {
        setSaving(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <View style={{ padding: 16, gap: 16 }}>
      <BottomSheet.Title>Rename conversation</BottomSheet.Title>
      <TextField isInvalid={error !== undefined}>
        <Label>Title</Label>
        <SheetInput value={value} onChange={setValue} disabled={saving} />
        <FieldError>{error}</FieldError>
      </TextField>
      <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
        <Button variant="secondary" onPress={close}>
          Cancel
        </Button>
        <Button
          variant="primary"
          isDisabled={!connected || saving || title === "" || title === initial}
          onPress={save}
        >
          Save
        </Button>
      </View>
    </View>
  );
}

export function RenameConversationSheet({
  summary,
  remote,
  connected,
  isOpen,
  onOpenChange,
}: {
  /** The rename target; undefined only before the first open. */
  summary: ConversationSummary | undefined;
  remote: RemoteDurable;
  connected: boolean;
  isOpen: boolean;
  onOpenChange(open: boolean): void;
}) {
  return (
    <BottomSheet isOpen={isOpen} onOpenChange={onOpenChange}>
      <BottomSheet.Portal>
        <BottomSheet.Overlay />
        {/* Tall enough that the top-aligned form clears the keyboard even if
            gorhom's extend behavior doesn't kick in under the portal. */}
        <BottomSheet.Content snapPoints={["75%"]} enableDynamicSizing={false} keyboardBehavior="extend">
          {/* Mount-on-open so the form starts from the live title each time;
              the sheet itself must stay mounted — gorhom only expands on an
              isOpen false→true edge, and a freshly mounted open sheet never
              presents. */}
          {isOpen && summary !== undefined ? (
            <RenameForm
              summary={summary}
              remote={remote}
              connected={connected}
              close={() => onOpenChange(false)}
            />
          ) : null}
        </BottomSheet.Content>
      </BottomSheet.Portal>
    </BottomSheet>
  );
}
