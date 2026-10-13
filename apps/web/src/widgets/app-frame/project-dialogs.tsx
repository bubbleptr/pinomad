import { Breadcrumbs, BreadcrumbItem } from "@astryxdesign/core/Breadcrumbs";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, LayoutFooter, HStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FolderListing, Project } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { folderCrumbs, parentFolder } from "@pinomad/client/folder-path.ts";
import { ArrowUp, ChevronRight, FolderClosed } from "../../shared/ui/icons.tsx";

const message = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

/**
 * The project picker's browse dialog: walks the host's filesystem one folder
 * at a time through `listFolders`, starting at the host user's home.
 */
export function AddProjectDialog({
  remote,
  connected,
  onAdded,
  onClose,
}: {
  remote: RemoteDurable;
  connected: boolean;
  onAdded: (project: Project) => void;
  onClose: () => void;
}) {
  const [listing, setListing] = useState<FolderListing | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  // A cancelled dialog must not close a reopened one or paint its error on it.
  // Set in the effect body, cleared in cleanup, so StrictMode's remount re-arms it.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Only the newest navigation's response may land; a slower earlier answer is dropped.
  const generation = useRef(0);
  const go = useCallback(
    (path?: string): void => {
      const gen = ++generation.current;
      setLoading(true);
      setError(undefined);
      void remote.controller.listFolders(path).then(
        (next) => {
          if (!mounted.current || gen !== generation.current) return;
          setListing(next);
          setLoading(false);
        },
        (reason: unknown) => {
          if (!mounted.current || gen !== generation.current) return;
          setError(message(reason));
          setLoading(false);
        },
      );
    },
    [remote],
  );
  // On mount: the picker's starting point is the host user's home.
  useEffect(() => go(), [go]);

  const add = (): void => {
    if (listing === undefined) return;
    setAdding(true);
    setError(undefined);
    void remote.controller.addProject(listing.path).then(
      (project) => {
        if (mounted.current) onAdded(project);
      },
      (reason: unknown) => {
        if (!mounted.current) return;
        setAdding(false);
        setError(message(reason));
      },
    );
  };

  const crumbs = listing === undefined ? [] : folderCrumbs(listing.path, listing.home);
  const up = listing === undefined ? undefined : parentFolder(listing.path);
  return (
    <Dialog isOpen onOpenChange={(open) => (open ? undefined : onClose())} purpose="form" width={480}>
      <Layout
        header={
          <DialogHeader
            title="Add project"
            subtitle="Choose a folder on the host."
            onOpenChange={() => onClose()}
          />
        }
        content={
          <LayoutContent>
            <HStack gap={1} vAlign="center">
              <IconButton
                icon={<ArrowUp aria-hidden="true" />}
                label="Parent folder"
                tooltip="Parent folder"
                size="sm"
                variant="ghost"
                isDisabled={up === undefined}
                onClick={() => go(up)}
              />
              {crumbs.length === 0 ? null : (
                // A chevron separator: the default "/" doubles up with the root crumb ("/ / private").
                <Breadcrumbs
                  variant="supporting"
                  label="Folders"
                  separator={<ChevronRight aria-hidden="true" className="size-3" />}
                >
                  {crumbs.map((crumb, index) => (
                    <BreadcrumbItem
                      key={crumb.path}
                      isCurrent={index === crumbs.length - 1}
                      onClick={index === crumbs.length - 1 ? undefined : () => go(crumb.path)}
                    >
                      {crumb.label}
                    </BreadcrumbItem>
                  ))}
                </Breadcrumbs>
              )}
            </HStack>
            <div className="flex h-80 flex-col overflow-y-auto">
              {loading ? (
                <div className="flex flex-1 items-center justify-center">
                  <Spinner aria-label="Loading folders" />
                </div>
              ) : error !== undefined ? (
                <Text type="supporting">{error}</Text>
              ) : listing === undefined ? null : listing.folders.length === 0 ? (
                <Text type="supporting">No subfolders</Text>
              ) : (
                <List density="compact">
                  {listing.folders.map((folder) => (
                    <ListItem
                      key={folder.path}
                      label={folder.name}
                      startContent={<FolderClosed aria-hidden="true" />}
                      endContent={<ChevronRight aria-hidden="true" />}
                      onClick={() => go(folder.path)}
                    />
                  ))}
                </List>
              )}
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} vAlign="center" hAlign="between">
              <Text type="supporting" maxLines={1} wordBreak="break-all" data-testid="picker-path">
                {listing?.path}
              </Text>
              <HStack gap={2} hAlign="end">
                <Button label="Cancel" variant="secondary" onClick={onClose} />
                <Button
                  label="Add project"
                  variant="primary"
                  isDisabled={!connected || listing === undefined || loading || adding}
                  onClick={add}
                />
              </HStack>
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
