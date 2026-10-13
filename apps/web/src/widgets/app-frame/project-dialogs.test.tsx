// The folder picker walks the host filesystem through controller.listFolders;
// a controllable fake remote stands in for it, resolving calls out of order.
import { render, screen, waitFor, within } from "@testing-library/react";
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
  return {
    remote: { controller } as unknown as RemoteDurable,
    listCalls,
    listRequests,
    addProject: controller.addProject,
    nextAdd: () => addRequest,
  };
}

function renderPicker(remote: RemoteDurable) {
  const onAdded = vi.fn();
  const onClose = vi.fn();
  render(<AddProjectDialog remote={remote} connected onAdded={onAdded} onClose={onClose} />);
  return { onAdded, onClose, dialog: () => screen.getByRole("dialog") };
}

describe("AddProjectDialog", () => {
  it("renders the home listing and navigates into a folder row", async () => {
    const user = userEvent.setup();
    const fake = fakeRemote();
    const { dialog } = renderPicker(fake.remote);
    expect(fake.listCalls).toEqual([undefined]);

    fake.listRequests[0]!.resolve(listingAt(HOME, ["code", "docs"]));
    expect(await within(dialog()).findByText("~")).toBeInTheDocument();
    expect(await within(dialog()).findByText("code")).toBeInTheDocument();
    expect(within(dialog()).getByText("docs")).toBeInTheDocument();

    await user.click(within(dialog()).getByText("code"));
    expect(fake.listCalls).toEqual([undefined, `${HOME}/code`]);
  });

  it("applies only the latest navigation when responses land out of order", async () => {
    const user = userEvent.setup();
    const fake = fakeRemote();
    const { dialog } = renderPicker(fake.remote);
    fake.listRequests[0]!.resolve(listingAt(HOME, ["code"]));
    await within(dialog()).findByText("code");

    // Into code, then — while that load is still out — back to ~ via the crumb.
    await user.click(within(dialog()).getByText("code"));
    fake.listRequests[1]!.resolve(listingAt(`${HOME}/code`, ["sub"]));
    await within(dialog()).findByText("sub");
    await user.click(within(dialog()).getByText("sub"));
    await user.click(within(dialog()).getByText("~"));
    expect(fake.listCalls).toEqual([undefined, `${HOME}/code`, `${HOME}/code/sub`, HOME]);

    // The older "sub" answer arriving last must not win.
    fake.listRequests[3]!.resolve(listingAt(HOME, ["code"]));
    fake.listRequests[2]!.resolve(listingAt(`${HOME}/code/sub`, ["a-folder"]));
    await waitFor(() => expect(within(dialog()).queryByText("a-folder")).toBeNull());
    expect(within(dialog()).getByText("code")).toBeInTheDocument();
  });

  it("shows a listFolders error in place and still navigates back", async () => {
    const user = userEvent.setup();
    const fake = fakeRemote();
    const { dialog } = renderPicker(fake.remote);
    fake.listRequests[0]!.resolve(listingAt(HOME, ["code"]));
    await within(dialog()).findByText("code");

    await user.click(within(dialog()).getByText("code"));
    fake.listRequests[1]!.reject(new Error("Permission denied: /Users/v/code"));
    expect(await within(dialog()).findByText(/Permission denied/)).toBeInTheDocument();
    // The last good listing's crumbs stay so the user can go back.
    expect(within(dialog()).getByText("~")).toBeInTheDocument();

    await user.click(within(dialog()).getByRole("button", { name: "Parent folder" }));
    expect(fake.listCalls.at(-1)).toBe("/Users");
    fake.listRequests.at(-1)!.resolve(listingAt("/Users", ["etc"]));
    expect(await within(dialog()).findByText("etc")).toBeInTheDocument();
    expect(within(dialog()).queryByText(/Permission denied/)).toBeNull();
  });

  it("adds the shown folder and hands the project to onAdded", async () => {
    const user = userEvent.setup();
    const fake = fakeRemote();
    const { dialog, onAdded } = renderPicker(fake.remote);
    fake.listRequests[0]!.resolve(listingAt(HOME, []));
    await within(dialog()).findByText("No subfolders");

    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    expect(fake.addProject).toHaveBeenCalledWith(HOME);
    const project: Project = { path: HOME, name: "v", addedAt: 1 };
    fake.nextAdd().resolve(project);
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(project));
  });

  it("shows an addProject error inline and does not call onAdded", async () => {
    const user = userEvent.setup();
    const fake = fakeRemote();
    const { dialog, onAdded } = renderPicker(fake.remote);
    fake.listRequests[0]!.resolve(listingAt(HOME, ["code"]));
    await within(dialog()).findByText("code");

    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    fake.nextAdd().reject(new Error("No such directory: /Users/v"));
    expect(await within(dialog()).findByText(/No such directory/)).toBeInTheDocument();
    expect(onAdded).not.toHaveBeenCalled();
    // The add failure lands in the footer: the folder rows stay shown.
    expect(within(dialog()).getByText("code")).toBeInTheDocument();
    // Still open: the host's error must not have closed the dialog.
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    // Navigating after the failed add clears the footer error.
    await user.click(within(dialog()).getByRole("button", { name: "Parent folder" }));
    fake.listRequests.at(-1)!.resolve(listingAt("/Users", ["etc"]));
    await within(dialog()).findByText("etc");
    expect(within(dialog()).queryByText(/No such directory/)).toBeNull();
  });

  it("locks navigation while an add is pending", async () => {
    const user = userEvent.setup();
    const fake = fakeRemote();
    const { dialog, onAdded } = renderPicker(fake.remote);
    fake.listRequests[0]!.resolve(listingAt(HOME, ["code"]));
    await within(dialog()).findByText("code");

    await user.click(within(dialog()).getByRole("button", { name: "Add project" }));
    // Rows and Parent folder must not issue another listFolders mid-add.
    await user.click(within(dialog()).getByText("code"));
    await user.click(within(dialog()).getByRole("button", { name: "Parent folder" }));
    expect(fake.listCalls).toEqual([undefined]);
    // Astryx marks disabled buttons with aria-disabled, not the attribute.
    expect(within(dialog()).getByRole("button", { name: "Parent folder" })).toHaveAttribute("aria-disabled", "true");

    const project: Project = { path: HOME, name: "v", addedAt: 1 };
    fake.nextAdd().resolve(project);
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith(project));
  });
});
