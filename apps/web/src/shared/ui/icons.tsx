import { HugeiconsIcon, type HugeiconsIconProps, type IconSvgElement } from "@hugeicons/react";
import {
  ActivityIcon,
  AddIcon,
  AiEditingIcon,
  AppleReminderIcon,
  ArchiveArrowDownIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowBigUpDashIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUp02Icon,
  BarChartIcon,
  BotIcon,
  BoxIcon,
  BubbleChatIcon,
  Cancel01Icon,
  ChatAddIcon,
  CheckmarkCircle02Icon,
  ChevronRightIcon,
  CircleIcon,
  CommandIcon,
  CommandLineIcon,
  ComputerIcon,
  Copy01Icon,
  CrosshairIcon,
  Delete02Icon,
  File01Icon,
  FileDiffIcon,
  Files01Icon,
  FileSearchIcon,
  FlashIcon,
  Folder01Icon,
  Folder02Icon,
  FolderAddIcon,
  FolderGitTwoIcon,
  FolderOpenIcon,
  GitBranchIcon,
  GitForkIcon,
  Globe02Icon,
  HammerIcon,
  ImageIcon as HugeImageIcon,
  InformationCircleIcon,
  KeyRoundIcon,
  LaptopPhoneSyncIcon,
  LayoutAlignLeftIcon,
  LinkSquare02Icon,
  Loading03Icon,
  MoreHorizontalIcon,
  PaintBoardIcon,
  PencilEdit01Icon,
  Progress02Icon,
  PuzzleIcon,
  RefreshIcon,
  RobotIcon,
  SearchVisualIcon,
  Settings01Icon,
  Settings02Icon,
  SidebarLeftIcon,
  SparklesIcon,
  StopIcon as HugeStopIcon,
  ThumbsDownIcon,
  ThumbsUpIcon,
  Tick02Icon,
  UserCircleIcon,
} from "@hugeicons/core-free-icons";

type PaceIconProps = Omit<HugeiconsIconProps, "icon" | "altIcon">;

const paceIconStrokeWidth = 1.75;

function iconComponent(icon: IconSvgElement) {
  return function PaceIcon(props: PaceIconProps) {
    return (
      <HugeiconsIcon
        color="currentColor"
        icon={icon}
        strokeWidth={paceIconStrokeWidth}
        {...props}
      />
    );
  };
}

export const Activity = iconComponent(ActivityIcon);
export const AiEditing = iconComponent(AiEditingIcon);
export const AppleReminder = iconComponent(AppleReminderIcon);
export const Archive = iconComponent(ArchiveIcon);
export const ArchiveArrowDown = iconComponent(ArchiveArrowDownIcon);
export const ArchiveRestore = iconComponent(ArchiveRestoreIcon);
export const ArrowBigUpDash = iconComponent(ArrowBigUpDashIcon);
export const ArrowLeft = iconComponent(ArrowLeftIcon);
export const ArrowRight = iconComponent(ArrowRightIcon);
export const ArrowUp = iconComponent(ArrowUp02Icon);
export const BarChart3 = iconComponent(BarChartIcon);
export const Bot = iconComponent(RobotIcon);
export const Box = iconComponent(BoxIcon);
export const Cancel = iconComponent(Cancel01Icon);
export const ChatAdd = iconComponent(ChatAddIcon);
export const ChatBubble = iconComponent(BubbleChatIcon);
export const ChevronRight = iconComponent(ChevronRightIcon);
export const Check = iconComponent(Tick02Icon);
export const CheckCircle = iconComponent(CheckmarkCircle02Icon);
export const Circle = iconComponent(CircleIcon);
export const Command = iconComponent(CommandIcon);
export const CommandLine = iconComponent(CommandLineIcon);
export const Computer = iconComponent(ComputerIcon);
export const Copy = iconComponent(Copy01Icon);
export const Crosshair = iconComponent(CrosshairIcon);
// Not `File`: that name is the host File constructor, and some Vite/HMR
// transforms bind the export to it. IconsGallery then renders the constructor
// and React 19 throws "Cannot read properties of null (reading 'use')".
export const FileIcon = iconComponent(File01Icon);
export const FileDiff = iconComponent(FileDiffIcon);
export const FileSearch = iconComponent(FileSearchIcon);
export const Files = iconComponent(Files01Icon);
export const Flash = iconComponent(FlashIcon);
export const FolderAdd = iconComponent(FolderAddIcon);
export const FolderClosed = iconComponent(Folder01Icon);
export const FolderGitTwo = iconComponent(FolderGitTwoIcon);
export const FolderOpen = iconComponent(FolderOpenIcon);
export const FolderOpenState = iconComponent(Folder02Icon);
export const GitBranch = iconComponent(GitBranchIcon);
export const GitFork = iconComponent(GitForkIcon);
export const Globe = iconComponent(Globe02Icon);
export const Hammer = iconComponent(HammerIcon);
export const ImageIcon = iconComponent(HugeImageIcon);
export const Info = iconComponent(InformationCircleIcon);
export const KeyRound = iconComponent(KeyRoundIcon);
export const Devices = iconComponent(LaptopPhoneSyncIcon);
// A quarter-filled circle: started, not finished (todo items).
export const InProgress = iconComponent(Progress02Icon);
export const LinkExternal = iconComponent(LinkSquare02Icon);
export const LayoutAlignLeft = iconComponent(LayoutAlignLeftIcon);
export const LoaderCircle = iconComponent(Loading03Icon);
export const MoreHorizontal = iconComponent(MoreHorizontalIcon);
export const Palette = iconComponent(PaintBoardIcon);
export const Pencil = iconComponent(PencilEdit01Icon);
export const Plus = iconComponent(AddIcon);
export const Puzzle = iconComponent(PuzzleIcon);
export const RefreshCw = iconComponent(RefreshIcon);
export const SearchVisual = iconComponent(SearchVisualIcon);
export const Settings = iconComponent(Settings01Icon);
export const Settings2 = iconComponent(Settings02Icon);
export const SidebarLeft = iconComponent(SidebarLeftIcon);
export const Sparkles = iconComponent(SparklesIcon);
export const Stop = iconComponent(HugeStopIcon);
export const ThumbsDown = iconComponent(ThumbsDownIcon);
export const ThumbsUp = iconComponent(ThumbsUpIcon);
export const Trash2 = iconComponent(Delete02Icon);
export const UserCircle = iconComponent(UserCircleIcon);

// Keep the plain bot glyph available for places that need a chat-specific robot icon.
export const BotMessage = iconComponent(BotIcon);
