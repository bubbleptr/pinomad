// The sidebar row's Rename dialog: a manual name is permanent — once written,
// the host never auto-titles the conversation again.
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
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
              <span className="text-xs/5 text-muted-foreground" role="alert" style={{ color: "var(--destructive)" }}>
                {error}
              </span>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <div className="flex justify-end gap-2">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button
                label="Save"
                variant="primary"
                isDisabled={!connected || saving || title === "" || title === initial}
                onClick={save}
              />
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
