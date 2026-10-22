// The folder picker walks the host filesystem through controller.listFolders;
// a controllable fake remote stands in for it, resolving calls out of order.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { FolderListing, Project } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { AddProjectDialog } from "./project-dialogs.tsx";

const HOME = "/Users/v";

function listingAt(path: string, folders: readonly string[]): FolderListing {
  return { path, home: HOME, folders: folders.map((name) => ({ name, path: `${path}/${name}` })) };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake remote: listFolders/addProject promises resolve only when the test says so. */
function fakeRemote() {
  const listCalls: (string | undefined)[] = [];
  const listRequests: ReturnType<typeof deferred<FolderListing>>[] = [];
  let addRequest = deferred<Project>();
  const controller = {
    listFolders: vi.fn((path?: string) => {
      listCalls.push(path);
      const request = deferred<FolderListing>();
      listRequests.push(request);
      return request.promise;
    }),
    addProject: vi.fn((_path: string) => {
      addRequest = deferred<Project>();
      return addRequest.promise;
    }),
  };
  /** Settle the newest request for `path` (`undefined` is the home call). */
  const answer = async (path: string | undefined, result: FolderListing | Error) => {
    const at = listCalls.lastIndexOf(path);
    expect(at, `no listFolders(${path}) call`).toBeGreaterThanOrEqual(0);
    await act(async () => {
      if (result instanceof Error) listRequests[at]!.reject(result);
      else listRequests[at]!.resolve(result);
    });
  };
  return {
    remote: { controller } as unknown as RemoteDurable,
    listCalls,
    answer,
    addProject: controller.addProject,
    nextAdd: () => addRequest,
  };
}

function renderPicker(remote: RemoteDurable) {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  render(<AddProjectDialog remote={remote} connected onAdded={onAdded} onClose={onClose} />);
  const dialog = () => screen.getByRole("dialog");
  return {
    onAdded,
    onClose,
    dialog,
    option: (name: string) => within(dialog()).getByRole("option", { name }),
    strip: () => within(dialog()).getByRole("group", { name: "Folders" }),
    selectedPath: () => within(dialog()).getByTestId("picker-path").getAttribute("data-path"),
  };
}

/** Open the picker with home listed. */
async function openAtHome(folders: readonly string[]) {
  const fake = fakeRemote();
  const picker = renderPicker(fake.remote);
  await fake.answer(undefined, listingAt(HOME, folders));
  return { fake, ...picker };
}

describe("AddProjectDialog", () => {
  it("selects a clicked folder, previews it in the next column, and adds the selection", async () => {
    const user = userEvent.setup();
    const { fake, option, selectedPath, dialog, onAdded } = await openAtHome(["code", "docs"]);
    expect(selectedPath()).toBe(HOME);

    await user.click(option("code"));
    expect(selectedPath()).toBe(`${HOME}/code`);
    expect(option("code")).toHaveAttribute("aria-selected", "true");
    expect(fake.listCalls).toEqual([undefined, `${HOME}/code`]);
    await fake.answer(`${HOME}/code`, listingAt(`${HOME}/code`, ["pinomad"]));
    // Home's column stays beside the preview of code.
    expect(option("docs")).toBeInTheDocument();
    expect(option("pinomad")).toBeInTheDocument();

    // Add takes the selected folder, not the deepest column shown.
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    expect(fake.addProject).toHaveBeenCalledWith(`${HOME}/code`);
    const project: Project = { path: `${HOME}/code`, name: "code", addedAt: 1 };
    fake.nextAdd().resolve(project);
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(project));
  });

  it("ignores a slow answer for a folder the selection already left", async () => {
    const user = userEvent.setup();
    const { fake, option, dialog } = await openAtHome(["code", "docs"]);

    await user.click(option("code"));
    await user.click(option("docs"));
    await fake.answer(`${HOME}/docs`, listingAt(`${HOME}/docs`, ["notes"]));
    await fake.answer(`${HOME}/code`, listingAt(`${HOME}/code`, ["pinomad"]));

    expect(option("notes")).toBeInTheDocument();
    expect(within(dialog()).queryByRole("option", { name: "pinomad" })).toBeNull();
    // Coming back to code uses the cached listing instead of asking again.
    await user.click(option("code"));
    expect(option("pinomad")).toBeInTheDocument();
    expect(fake.listCalls).toEqual([undefined, `${HOME}/code`, `${HOME}/docs`]);
  });

  it("shows a listing error in its column; Try again re-asks for that folder", async () => {
    const user = userEvent.setup();
    const { fake, option, dialog } = await openAtHome(["code"]);

    await user.click(option("code"));
    await fake.answer(`${HOME}/code`, new Error("Permission denied: /Users/v/code"));
    expect(within(dialog()).getByText(/Permission denied/)).toBeInTheDocument();

    await user.click(within(dialog()).getByRole("button", { name: "Try again" }));
    expect(fake.listCalls).toEqual([undefined, `${HOME}/code`, `${HOME}/code`]);
    await fake.answer(`${HOME}/code`, listingAt(`${HOME}/code`, ["sub"]));
    expect(option("sub")).toBeInTheDocument();
    expect(within(dialog()).queryByText(/Permission denied/)).toBeNull();
  });

  it("climbs above home through the path bar", async () => {
    const user = userEvent.setup();
    const { fake, option, selectedPath, dialog } = await openAtHome(["code"]);

    const bar = within(within(dialog()).getByTestId("picker-path"));
    await user.click(bar.getByRole("button", { name: "/" }));
    expect(selectedPath()).toBe("/");
    await fake.answer("/", listingAt("/", ["Users", "opt"]));
    expect(option("opt")).toBeInTheDocument();
  });

  it("moves with the arrow keys and descends once a slow listing lands", async () => {
    const user = userEvent.setup();
    const { fake, strip, selectedPath, dialog } = await openAtHome(["code", "docs"]);
    strip().focus();

    await user.keyboard("{ArrowDown}");
    expect(selectedPath()).toBe(`${HOME}/code`);
    // → before code's listing arrives still lands on its first child.
    await user.keyboard("{ArrowRight}");
    expect(selectedPath()).toBe(`${HOME}/code`);
    await fake.answer(`${HOME}/code`, listingAt(`${HOME}/code`, ["pinomad"]));
    expect(selectedPath()).toBe(`${HOME}/code/pinomad`);

    await user.keyboard("{ArrowLeft}{ArrowDown}");
    expect(selectedPath()).toBe(`${HOME}/docs`);
    // ← from home leaves it for its parent, listed under "/".
    await user.keyboard("{ArrowLeft}{ArrowLeft}");
    expect(selectedPath()).toBe("/Users");
    expect(fake.listCalls).toContain("/");

    await user.keyboard("{Enter}");
    expect(fake.addProject).toHaveBeenCalledWith("/Users");
    expect(within(dialog()).getByRole("button", { name: "Adding…" })).toBeInTheDocument();
  });

  it("jumps to a folder by typing its name", async () => {
    const user = userEvent.setup();
    const { strip, selectedPath } = await openAtHome(["apps", "code", "crates", "docs"]);
    strip().focus();

    await user.keyboard("cr");
    expect(selectedPath()).toBe(`${HOME}/crates`);
  });

  it("shows an addProject error in the footer and clears it on the next selection", async () => {
    const user = userEvent.setup();
    const { fake, option, dialog, onAdded } = await openAtHome(["code"]);

    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    await act(async () => fake.nextAdd().reject(new Error("No such directory: /Users/v")));
    expect(within(dialog()).getByRole("alert")).toHaveTextContent("No such directory");
    expect(onAdded).not.toHaveBeenCalled();
    // Still open, with the folders in place.
    expect(option("code")).toBeInTheDocument();

    await user.click(option("code"));
    expect(within(dialog()).queryByRole("alert")).toBeNull();
  });

  it("locks the selection while an add is pending", async () => {
    const user = userEvent.setup();
    const { fake, option, strip, selectedPath, dialog, onAdded } = await openAtHome(["code"]);

    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    await user.click(option("code"));
    strip().focus();
    await user.keyboard("{ArrowDown}{ArrowLeft}");
    expect(selectedPath()).toBe(HOME);
    expect(fake.listCalls).toEqual([undefined]);

    const project: Project = { path: HOME, name: "v", addedAt: 1 };
    fake.nextAdd().resolve(project);
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(project));
  });

  it("offers Try again when the first load fails", async () => {
    const user = userEvent.setup();
    const fake = fakeRemote();
    const { option, dialog } = renderPicker(fake.remote);
    await fake.answer(undefined, new Error("Not connected to the host"));

    expect(within(dialog()).getByText(/Not connected/)).toBeInTheDocument();
    // Nothing is selected yet, so there is nothing to add.
    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    expect(fake.addProject).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole("button", { name: "Try again" }));
    expect(fake.listCalls).toEqual([undefined, undefined]);

    await fake.answer(undefined, listingAt(HOME, ["code"]));
    expect(option("code")).toBeInTheDocument();
    expect(within(dialog()).queryByText(/Not connected/)).toBeNull();
  });
});
