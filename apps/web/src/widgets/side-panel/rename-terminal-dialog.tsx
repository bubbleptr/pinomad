// The terminal menu's Rename dialog: a name holds until cleared, after which
// the tab follows the shell's window title again.
import { Button } from "../../shared/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/shared/ui/dialog";
import { Field, FieldDescription, FieldLabel, FormError } from "../../shared/ui/field.tsx";
import { Input } from "../../shared/ui/input.tsx";
import { useCallback, useState } from "react";
import type { RemoteTerminals } from "@pinomad/protocol/remote-durable.ts";
import type { TerminalInfo } from "@pinomad/protocol/terminals.ts";

export function RenameTerminalDialog({
  terminal,
  terminals,
  connected,
  onClose,
}: {
  terminal: TerminalInfo;
  terminals: Pick<RemoteTerminals, "rename">;
  connected: boolean;
  onClose: () => void;
}) {
  const initial = terminal.renamed ? terminal.name : "";
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  // Select-all as the input mounts (the dialog portals it in after this
  // component's effects run), so typing replaces the old name.
  const selectAll = useCallback((input: HTMLInputElement | null) => input?.select(), []);

  const name = value.trim();
  const save = (): void => {
    if (name === initial || saving) return;
    setSaving(true);
    setError(undefined);
    terminals.rename(terminal.id, name === "" ? null : name).then(
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
          <DialogTitle>Rename terminal</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <Field disabled={saving}>
            <FieldLabel>Name</FieldLabel>
            <FieldDescription>Leave empty to use the shell's window title.</FieldDescription>
            <Input
              ref={selectAll}
              placeholder={terminal.renamed ? undefined : terminal.name}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoFocus
              data-autofocus
              onKeyDown={(event) => {
                if (event.key === "Enter") save();
              }}
            />
          </Field>
          <FormError>{error}</FormError>
        </DialogBody>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!connected || saving || name === initial} onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
