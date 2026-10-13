// The sidebar row's Rename dialog: a manual name is permanent — once written,
// the host never auto-titles the conversation again.
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter, HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useEffect, useRef, useState } from "react";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ConversationSummary } from "@pinomad/protocol/view.ts";
import { displayName } from "@pinomad/client/family.ts";

export function RenameConversationDialog({
  summary,
  remote,
  connected,
  onClose,
}: {
  summary: ConversationSummary;
  remote: RemoteDurable;
  connected: boolean;
  onClose: () => void;
}) {
  const initial = displayName(summary);
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  // Auto-focus lands the caret; select-all lets typing replace the old name.
  useEffect(() => input.current?.select(), []);

  const title = value.trim();
  const save = (): void => {
    if (title === "" || title === initial || saving) return;
    setSaving(true);
    setError(undefined);
    void remote.controller.renameConversation(summary.id, title).then(
      () => onClose(),
      (reason: unknown) => {
        setSaving(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };

  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title="Rename conversation" onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <TextInput
              ref={input}
              label="Title"
              value={value}
              onChange={setValue}
              onEnter={save}
              hasAutoFocus
              isDisabled={saving}
            />
            {error === undefined ? null : (
              <Text type="supporting" role="alert" style={{ color: "var(--danger)" }}>
                {error}
              </Text>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button
                label="Save"
                variant="primary"
                isDisabled={!connected || saving || title === "" || title === initial}
                onClick={save}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
