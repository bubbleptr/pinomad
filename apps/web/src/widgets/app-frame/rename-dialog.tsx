// The sidebar row's Rename dialog: a manual name is permanent — once written,
// the host never auto-titles the conversation again.
import { Button } from "../../shared/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../shared/ui/dialog.tsx";
import { Field, FieldLabel } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { useCallback, useState } from "react";
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
  // Select-all as the input mounts (the dialog portals it in after this
  // component's effects run), so typing replaces the old name.
  const selectAll = useCallback((input: HTMLInputElement | null) => input?.select(), []);

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
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())} disablePointerDismissal>
      <DialogContent className="w-[480px]">
        <DialogHeader>
          <DialogTitle>Rename conversation</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Field disabled={saving}>
            <FieldLabel>Title</FieldLabel>
            <Input
              ref={selectAll}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
              data-autofocus
              onKeyDown={(event) => {
                if (event.key === "Enter") save();
              }}
            />
          </Field>
          {error === undefined ? null : (
            <span className="text-xs/5 text-muted-foreground" role="alert" style={{ color: "var(--destructive)" }}>
              {error}
            </span>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!connected || saving || title === "" || title === initial}
            onClick={save}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
