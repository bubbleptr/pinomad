import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter, HStack } from "@astryxdesign/core/Layout";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useEffect, useRef, useState } from "react";
import type { Project } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";

export function AddProjectDialog({ remote, connected, onClose }: { remote: RemoteDurable; connected: boolean; onClose: () => void }) {
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [pending, setPending] = useState(false);
  // A cancelled dialog must not close a reopened one or paint its error on it.
  // Set in the effect body too: StrictMode's dev remount runs the cleanup once first.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const add = (): void => {
    setPending(true);
    void remote.controller.addProject(path.trim()).then(
      () => {
        if (mounted.current) onClose();
      },
      (reason: unknown) => {
        if (!mounted.current) return;
        setPending(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
  };
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title="Add project"
            subtitle="A local directory on the host that conversations can work in."
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <TextInput
              label="Path"
              value={path}
              onChange={(value) => {
                setPath(value);
                setError(undefined);
              }}
              status={error === undefined ? undefined : { type: "error", message: error }}
            />
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button
                label="Add project"
                variant="primary"
                isDisabled={!connected || pending || path.trim() === ""}
                onClick={add}
              />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}

export function RemoveProjectDialog({
  project,
  remote,
  connected,
  onClose,
}: {
  project: Project;
  remote: RemoteDurable;
  connected: boolean;
  onClose: () => void;
}) {
  const remove = (): void => {
    void remote.controller.removeProject(project.path);
    onClose();
  };
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title={`Remove project ${project.name}?`}
            subtitle="The directory and its conversations are kept; only the registration is removed."
            onOpenChange={() => onClose()}
          />
        }
        content={<LayoutContent />}
        footer={
          <LayoutFooter>
            <HStack gap={2} hAlign="end">
              <Button label="Cancel" variant="secondary" onClick={onClose} />
              <Button label="Remove project" variant="primary" isDisabled={!connected} onClick={remove} />
            </HStack>
          </LayoutFooter>
        }
      />
    </Dialog>
  );
}
