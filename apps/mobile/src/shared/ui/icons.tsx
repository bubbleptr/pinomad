// Thin Hugeicons wrapper mirroring apps/web/src/shared/ui/icons.tsx: fixed
// stroke width, currentColor default so the `color` prop drives everything.
import { HugeiconsIcon, type HugeiconsProps, type IconSvgElement } from "@hugeicons/react-native";
import {
  Add01Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  ChatAddIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ComputerIcon,
  FlashIcon,
  Folder01Icon,
  FolderLibraryIcon,
  GitBranchIcon,
  MoreHorizontalIcon,
  Queue02Icon,
  StopIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

type PinomadIconProps = Omit<HugeiconsProps, "icon" | "altIcon">;

const iconStrokeWidth = 1.5;

function iconComponent(icon: IconSvgElement, defaults?: Partial<HugeiconsProps>) {
  return function PinomadIcon(props: PinomadIconProps) {
    return (
      <HugeiconsIcon color="currentColor" icon={icon} strokeWidth={iconStrokeWidth} {...defaults} {...props} />
    );
  };
}

export const Plus = iconComponent(Add01Icon);
export const ArrowUp = iconComponent(ArrowUp02Icon);
// Steer lands in the running turn immediately; the bolt reads "now".
export const Steer = iconComponent(FlashIcon);
// Follow-up waits behind the running turn; stacked lines read "queued".
export const FollowUp = iconComponent(Queue02Icon);
// A solid rounded square like the iOS stop glyph, not the stroked outline.
export const Stop = iconComponent(StopIcon, { fill: "currentColor" });
export const ChevronDown = iconComponent(ChevronDownIcon);
export const ChevronRight = iconComponent(ChevronRightIcon);
export const Check = iconComponent(Tick02Icon);
export const ChatAdd = iconComponent(ChatAddIcon);
export const Computer = iconComponent(ComputerIcon);
// Web maps its FolderClosed export to Folder01Icon — same glyph here.
export const FolderClosed = iconComponent(Folder01Icon);
export const FolderLibrary = iconComponent(FolderLibraryIcon);
export const GitBranch = iconComponent(GitBranchIcon);
// The row-actions affordance the web sidebar uses (⋯).
export const MoreHorizontal = iconComponent(MoreHorizontalIcon);
// Same glyph the web uses for cancel/close affordances.
export const Cancel = iconComponent(Cancel01Icon);
