import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter, HStack, VStack } from "@astryxdesign/core/Layout";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Text } from "@astryxdesign/core/Text";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { FolderListing, Project } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { folderCrumbs, parentFolder } from "@pinomad/client/folder-path.ts";
import { ChevronRight, FolderClosed } from "../../shared/ui/icons.tsx";

const message = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

type Listing =
  | { status: "loading" }
  | { status: "ok"; folders: FolderListing["folders"] }
  | { status: "error"; message: string };

const optionId = (path: string) => `add-project-folder-${path}`;

/**
 * Type-to-jump: printable keys pile up into a prefix that resets after a
 * pause. Returns whether the key was consumed.
 */
function useTypeahead(onPrefix: (prefix: string) => void) {
  const prefix = useRef("");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  return (event: React.KeyboardEvent): boolean => {
    if (event.key.length !== 1 || event.key === " " || event.metaKey || event.ctrlKey || event.altKey) return false;
    prefix.current += event.key.toLowerCase();
    clearTimeout(timer.current);
    timer.current = setTimeout(() => (prefix.current = ""), 600);
    onPrefix(prefix.current);
    return true;
  };
}

/**
 * The project picker's browse dialog: Finder-style columns over the host's
 * filesystem, one `listFolders` call per folder. Clicking a folder selects it
 * and lists its subfolders in the next column; "Add project" registers the
 * selection. It starts with the host user's home selected.
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
  // The first call resolves home; until it lands there is nothing to select.
  const [start, setStart] = useState<{ status: "loading" } | { status: "error"; message: string } | { status: "ok"; home: string }>(
    { status: "loading" },
  );
  // Listings by path, each fetched once: a slow answer lands under its own
  // path instead of racing the selection, and a column shown again is free.
  const [listings, setListings] = useState<Record<string, Listing>>({});
  const [selected, setSelected] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | undefined>(undefined);
  // A cancelled dialog must not close a reopened one or paint its error on it.
  // Set in the effect body, cleared in cleanup, so StrictMode's remount re-arms it.
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // Paths asked for and not failed; a failed path may be asked again.
  const requested = useRef(new Set<string>());
  // The folder → was pressed on before its listing landed: descend once it does.
  const descend = useRef<string | undefined>(undefined);
  const strip = useRef<HTMLDivElement>(null);

  const load = useCallback(
    (path: string): void => {
      if (requested.current.has(path)) return;
      requested.current.add(path);
      setListings((prev) => ({ ...prev, [path]: { status: "loading" } }));
      void remote.controller.listFolders(path).then(
        (listing) => {
          if (mounted.current) setListings((prev) => ({ ...prev, [path]: { status: "ok", folders: listing.folders } }));
        },
        (reason: unknown) => {
          requested.current.delete(path);
          if (mounted.current) setListings((prev) => ({ ...prev, [path]: { status: "error", message: message(reason) } }));
        },
      );
    },
    [remote],
  );

  const begin = useCallback((): void => {
    setStart({ status: "loading" });
    void remote.controller.listFolders().then(
      (listing) => {
        if (!mounted.current) return;
        requested.current.add(listing.path);
        setListings((prev) => ({ ...prev, [listing.path]: { status: "ok", folders: listing.folders } }));
        setStart({ status: "ok", home: listing.home });
        setSelected(listing.path);
      },
      (reason: unknown) => {
        if (mounted.current) setStart({ status: "error", message: message(reason) });
      },
    );
  }, [remote]);
  useEffect(() => begin(), [begin]);


  useEffect(() => {
    const pending = descend.current;
    if (pending === undefined || pending !== selected) return;
    const listing = listings[pending];
    if (listing === undefined || listing.status === "loading") return;
    descend.current = undefined;
    if (listing.status === "ok" && listing.folders.length > 0) setSelected(listing.folders[0]!.path);
  }, [listings, selected]);

  // Keyboard first on desktop; a coarse pointer has no keys to give it.
  useEffect(() => {
    if (start.status !== "ok" || !window.matchMedia("(pointer: fine)").matches) return;
    const frame = requestAnimationFrame(() => strip.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [start.status]);

  // Follow the selection: newest column and selected row in view. Keyed on the
  // selection alone, so a listing landing never yanks a strip scrolled by hand.
  useLayoutEffect(() => {
    const element = strip.current;
    if (element === null || selected === undefined) return;
    element.scrollLeft = element.scrollWidth;
    document.getElementById(optionId(selected))?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [selected]);

  const home = start.status === "ok" ? start.home : undefined;
  // Columns run from the anchor ("~" under home, "/" elsewhere) to the
  // selection; each column lists one folder of that chain.
  const crumbs = selected === undefined || home === undefined ? [] : folderCrumbs(selected, home);
  const chain = crumbs.map((crumb) => crumb.path);
  const anchor = chain[0];
  // Under home the path bar still offers "/" as the way out: "/ › ~ › code".
  const pathBar = anchor === undefined || anchor === "/" ? crumbs : [{ label: "/", path: "/" }, ...crumbs];

  // Every column of the chain is listed; usually all but the newest are cached.
  const chainKey = chain.join("\n");
  useEffect(() => {
    for (const path of chainKey.split("\n")) if (path !== "") load(path);
  }, [chainKey, load]);

  const select = (path: string): void => {
    if (adding) return;
    setAddError(undefined);
    setSelected(path);
  };
  const foldersOf = (path: string | undefined) => {
    const listing = path === undefined ? undefined : listings[path];
    return listing?.status === "ok" ? listing.folders : undefined;
  };
  // The keys move within the selection's column — or within the anchor's
  // listing while the anchor itself is selected and no row is.
  const column = selected === undefined ? undefined : selected === anchor ? anchor : parentFolder(selected);
  const typeahead = useTypeahead((prefix) => {
    const match = foldersOf(column)?.find((folder) => folder.name.toLowerCase().startsWith(prefix));
    if (match !== undefined) select(match.path);
  });

  const add = (): void => {
    if (selected === undefined) return;
    setAdding(true);
    setAddError(undefined);
    void remote.controller.addProject(selected).then(
      (project) => {
        if (mounted.current) onAdded(project);
      },
      (reason: unknown) => {
        if (!mounted.current) return;
        setAdding(false);
        setAddError(message(reason));
      },
    );
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (selected === undefined || adding) return;
    const siblings = foldersOf(column) ?? [];
    const index = siblings.findIndex((folder) => folder.path === selected);
    switch (event.key) {
      case "ArrowDown":
        if (siblings.length > 0) select(siblings[Math.min(index + 1, siblings.length - 1)]!.path);
        break;
      case "ArrowUp":
        if (index > 0) select(siblings[index - 1]!.path);
        break;
      case "Home":
        if (siblings.length > 0) select(siblings[0]!.path);
        break;
      case "End":
        if (siblings.length > 0) select(siblings.at(-1)!.path);
        break;
      case "ArrowRight": {
        const children = foldersOf(selected);
        if (children === undefined) descend.current = selected;
        else if (children.length > 0) select(children[0]!.path);
        break;
      }
      case "ArrowLeft": {
        const parent = parentFolder(selected);
        if (parent !== undefined) select(parent);
        break;
      }
      case "Enter":
        if (connected) add();
        break;
      default:
        if (!typeahead(event)) return;
    }
    event.preventDefault();
  };

  const pick = (path: string): void => {
    select(path);
    strip.current?.focus();
  };

  return (
    <Dialog
      isOpen
      onOpenChange={(open) => (open ? undefined : onClose())}
      purpose="form"
      width="min(780px, calc(100vw - 32px))"
    >
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
            {start.status !== "ok" ? (
              <div className="flex h-[24rem] items-center justify-center">
                {start.status === "loading" ? (
                  <Spinner aria-label="Loading folders" />
                ) : (
                  <VStack gap={2} hAlign="center">
                    <Text type="supporting">{start.message}</Text>
                    <Button label="Try again" variant="secondary" onClick={begin} />
                  </VStack>
                )}
              </div>
            ) : (
              <div className="overflow-hidden rounded-[var(--radius-inner)] border border-[var(--color-border)]">
                <div
                  ref={strip}
                  role="group"
                  aria-label="Folders"
                  tabIndex={0}
                  aria-activedescendant={selected === undefined || selected === anchor ? undefined : optionId(selected)}
                  onKeyDown={onKeyDown}
                  className="group flex h-[22rem] overflow-x-auto overflow-y-hidden outline-none"
                >
                  {chain.map((path, index) => (
                    <FolderColumn
                      key={path}
                      path={path}
                      label={crumbs[index]!.label}
                      listing={listings[path]}
                      next={chain[index + 1]}
                      selected={selected}
                      disabled={adding}
                      onPick={pick}
                      onRetry={() => load(path)}
                    />
                  ))}
                </div>
                <nav
                  aria-label="Selected folder"
                  data-testid="picker-path"
                  data-path={selected}
                  className="flex h-8 min-w-0 items-center gap-0.5 border-t border-[var(--color-border)] bg-[var(--color-background-muted)] px-2 text-[13px] text-[var(--color-text-secondary)]"
                >
                  {pathBar.map((crumb, index) => {
                    const last = index === pathBar.length - 1;
                    return (
                      // The last crumb keeps its width; earlier ones shrink first on a deep path.
                      <span key={crumb.path} className={`flex min-w-0 items-center gap-0.5 ${last ? "shrink-0" : ""}`}>
                        {index === 0 ? null : <ChevronRight aria-hidden="true" className="size-3 shrink-0 opacity-60" />}
                        <button
                          type="button"
                          disabled={adding}
                          aria-current={last ? "location" : undefined}
                          onClick={() => pick(crumb.path)}
                          className={`max-w-[14rem] min-w-0 truncate rounded px-1 py-0.5 hover:bg-[var(--color-overlay-hover)] focus-visible:outline-2 focus-visible:outline-[var(--color-border-emphasized)] ${
                            last ? "text-[var(--color-text-primary)]" : ""
                          }`}
                        >
                          {crumb.label}
                        </button>
                      </span>
                    );
                  })}
                </nav>
              </div>
            )}
          </LayoutContent>
        }
        footer={
          <LayoutFooter>
            <HStack gap={2} vAlign="center" hAlign="between">
              <div className="min-w-0 flex-1">
                {addError !== undefined ? (
                  <Text type="supporting" role="alert" maxLines={1} style={{ color: "var(--danger)" }}>
                    {addError}
                  </Text>
                ) : (
                  // Touch has no arrow keys to advertise.
                  <div className="hidden pointer-fine:block">
                    <Text type="supporting" maxLines={1}>
                      Arrow keys to browse, Enter to add
                    </Text>
                  </div>
                )}
              </div>
              <HStack gap={2} hAlign="end">
                <Button label="Cancel" variant="secondary" onClick={onClose} />
                <Button
                  label={adding ? "Adding…" : "Add project"}
                  variant="primary"
                  isDisabled={!connected || selected === undefined || adding}
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

/** One column: the subfolders of `path`, with `next` (the chain's following folder) marked. */
function FolderColumn({
  path,
  label,
  listing,
  next,
  selected,
  disabled,
  onPick,
  onRetry,
}: {
  path: string;
  label: string;
  listing: Listing | undefined;
  next: string | undefined;
  selected: string | undefined;
  disabled: boolean;
  onPick: (path: string) => void;
  onRetry: () => void;
}) {
  // Only the newest column is ever loading, empty or failed; it then fills the
  // rest of the strip so its message sits in the middle of the empty space.
  const fills = listing?.status !== "ok" || listing.folders.length === 0;
  return (
    <div
      role="listbox"
      aria-label={label}
      // Contain vertically only: a sideways trackpad swipe over a column must
      // reach the strip, which owns horizontal scrolling.
      className={`flex shrink-0 flex-col overflow-y-auto overscroll-y-contain border-r border-[var(--color-border)] p-1 last:border-r-0 ${
        fills ? "min-w-56 flex-1" : "w-56"
      }`}
    >
      {listing === undefined || listing.status === "loading" ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner aria-label={`Loading ${label}`} size="sm" />
        </div>
      ) : listing.status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-2 text-center">
          <Text type="supporting">{listing.message}</Text>
          <Button label="Try again" size="sm" variant="secondary" isDisabled={disabled} onClick={onRetry} />
        </div>
      ) : listing.folders.length === 0 ? (
        <div className="flex flex-1 items-center justify-center">
          <Text type="supporting">No subfolders</Text>
        </div>
      ) : (
        listing.folders.map((folder) => {
          const isSelected = folder.path === selected;
          return (
            <div
              key={folder.path}
              id={optionId(folder.path)}
              role="option"
              aria-selected={isSelected}
              aria-disabled={disabled || undefined}
              title={folder.name}
              // Focus stays on the strip, which owns the keyboard.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => onPick(folder.path)}
              className={`flex h-7 shrink-0 cursor-default items-center gap-2 rounded-[7px] px-2 text-sm ${
                isSelected
                  ? "bg-[var(--color-overlay-pressed)] group-focus:bg-[var(--color-accent)] group-focus:text-[var(--color-on-accent)]"
                  : folder.path === next
                    ? "bg-[var(--color-overlay-pressed)]"
                    : "hover:bg-[var(--color-overlay-hover)]"
              }`}
            >
              <FolderClosed aria-hidden="true" className="size-4 shrink-0 opacity-70" />
              <span className="min-w-0 flex-1 truncate">{folder.name}</span>
              <ChevronRight aria-hidden="true" className="size-3 shrink-0 opacity-50" />
            </div>
          );
        })
      )}
    </div>
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
