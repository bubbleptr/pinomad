import type { Meta, StoryObj } from "@storybook/react-vite";
import { fn } from "storybook/test";
import type { FolderListing, Project } from "@pinomad/protocol/organization.ts";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import { AddProjectDialog, RemoveProjectDialog } from "./project-dialogs.tsx";

const HOME = "/Users/v";

const project: Project = { path: `${HOME}/code/pinomad`, name: "pinomad", addedAt: Date.UTC(2026, 9, 1) };

function listingAt(path: string, folders: readonly string[]): FolderListing {
  return { path, home: HOME, folders: folders.map((name) => ({ name, path: `${path}/${name}` })) };
}

const FOLDERS: Record<string, readonly string[]> = {
  "/": ["Applications", "Users", "opt", "usr"],
  "/Users": ["Shared", "v"],
  [HOME]: ["code", "Desktop", "Documents", "Downloads", "毕业论文与课题组资料-2026春季学期最终提交版本"],
  [`${HOME}/code`]: ["dotfiles", "pinomad", "pinomad-experimental-relay-reconnect-with-backoff", "scratch"],
  [`${HOME}/code/pinomad`]: ["apps", "crates", "docs", "packages"],
};

const remote = {
  controller: {
    listFolders: fn(async (path?: string) => listingAt(path ?? HOME, FOLDERS[path ?? HOME] ?? [])),
    addProject: fn(async (path: string) => ({ ...project, path, name: path.split("/").at(-1)! })),
    removeProject: fn(async () => {}),
  },
} as unknown as RemoteDurable;

const meta = {
  title: "Widgets/AppFrame/ProjectDialogs",
  component: AddProjectDialog,
  args: { remote, connected: true, onAdded: fn(), onClose: fn() },
} satisfies Meta<typeof AddProjectDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AddProject: Story = {};

export const AddProjectLoading: Story = {
  args: {
    remote: { controller: { listFolders: fn(() => new Promise<FolderListing>(() => {})) } } as unknown as RemoteDurable,
  },
};

export const AddProjectListFails: Story = {
  args: {
    remote: {
      controller: { listFolders: fn(async () => Promise.reject(new Error("Permission denied: /Users/v"))) },
    } as unknown as RemoteDurable,
  },
};

export const RemoveProject: Story = {
  render: (args) => <RemoveProjectDialog project={project} remote={args.remote} connected={args.connected} onClose={args.onClose} />,
};
