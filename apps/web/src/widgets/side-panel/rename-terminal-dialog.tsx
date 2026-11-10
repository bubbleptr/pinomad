// The terminal menu's Rename dialog: a name holds until cleared, after which
// the tab follows the shell's window title again.
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useEffect, useRef, useState } from "react";
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
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);

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
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={480}>
      <Layout
        header={<DialogHeader title="Rename terminal" onOpenChange={() => onClose()} />}
        content={
          <LayoutContent>
            <TextInput
              ref={input}
              label="Name"
              description="Leave empty to use the shell's window title."
              placeholder={terminal.renamed ? undefined : terminal.name}
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
              <Button label="Save" variant="primary" isDisabled={!connected || saving || name === initial} onClick={save} />
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
