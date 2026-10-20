import { AppShell } from "@astryxdesign/core/AppShell";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { SideNav } from "@astryxdesign/core/SideNav";
import { ToastViewport, useToast } from "@astryxdesign/core/Toast";
import { Button } from "@astryxdesign/core/Button";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { RemoteDurable } from "@pinomad/protocol/remote-durable.ts";
import type { ConversationSummary, DurableView, Notice } from "@pinomad/protocol/view.ts";
import type { KeyPair } from "@pinomad/protocol/noise.ts";
import { isBusy } from "@pinomad/protocol/transcript.ts";
import { hostWindowChrome } from "../../shared/host-chrome.ts";
import { displayName, rootOf } from "@pinomad/client/family.ts";
import type { ConversationNode, Home } from "@pinomad/protocol/organization.ts";
import { ListBullet } from "../../shared/ui/icons.tsx";
import { AnimatedSidebar, AnimatedSidebarRight } from "../../shared/ui/animated-icons.tsx";
import { ConnectionDot, SidebarContent, SidebarFooter, SidebarHeaderBand } from "./sidebar.tsx";
import { DevicesDialog } from "./devices-dialog.tsx";
import { SettingsDialog } from "./settings-dialog.tsx";
import { ForgetHostDialog, PairHostDialog } from "./host-switcher.tsx";
import { AccountDialog } from "../account/account-dialog.tsx";
import { SidePanel, type PanelTab } from "../side-panel/side-panel.tsx";
import { OverviewCard } from "../overview/overview-card.tsx";

const SIDEBAR_OPEN_KEY = "pinomad.sidebar.open";
const OVERVIEW_OPEN_KEY = "pinomad.overview.open";

const readSidebarOpen = (): boolean =>
  typeof window === "undefined" || window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false";
const readOverviewOpen = (): boolean =>
  typeof window !== "undefined" && window.localStorage.getItem(OVERVIEW_OPEN_KEY) === "true";

const anyAtWork = (nodes: readonly ConversationNode[]): boolean =>
  nodes.some((node) => node.summary.status === "running" || node.summary.status === "needs-answer" || anyAtWork(node.children));

/**
 * The app frame: Astryx AppShell (wash sidebar vs elevated main) + in-flow
 * 40px header + optional side panel, mirroring Pace's widgets/app-frame.
 * Owns frame chrome state (sidebar/panel/nav); Workbench owns content state.
 */
export function AppFrame({
  view,
  remote,
  device,
  narrow,
  drafting,
  draftingChat,
  draftLabel,
  conversation,
  summary,
  parentSummary,
  banner,
  onDraft,
  onOpenChanges,
  panelOpen,
  panelTab,
  onPanelOpen,
  onPanelTab,
  openInPanel,
  openInMain,
  children,
}: {
  view: DurableView;
  remote: RemoteDurable;
  device?: KeyPair;
  narrow: boolean;
  drafting: boolean;
  draftingChat: boolean;
  draftLabel: string;
  conversation: DurableView["conversation"];
  summary: ConversationSummary | undefined;
  parentSummary: ConversationSummary | undefined;
  banner?: ReactNode;
  onDraft: (home: Home) => void;
  onOpenChanges: () => void;
  /** The side panel's open state and tab live in Workbench — chat entries reach them too. */
  panelOpen: boolean;
  panelTab: PanelTab;
  onPanelOpen: (open: boolean) => void;
  onPanelTab: (tab: PanelTab) => void;
  openInPanel: (id: ConversationId, tab: "threads" | "tasks") => void;
  openInMain: (id: ConversationId) => void;
  children: ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  const [overviewOpen, setOverviewOpen] = useState(readOverviewOpen);
  const [navOpen, setNavOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pairHostOpen, setPairHostOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [forgetHostOpen, setForgetHostOpen] = useState(false);
  // Under the desktop shell on macOS, the traffic lights own the top-left
  // corner: whichever band sits there reserves the inset and drags the window.
  const chrome = hostWindowChrome();
  const sidebarOwnsCorner = chrome.reserveMacTrafficLights && !narrow && sidebarOpen;
  const toggleSidebar = (): void => {
    window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(!sidebarOpen));
    setSidebarOpen(!sidebarOpen);
  };
  const changeOverview = (open: boolean): void => {
    window.localStorage.setItem(OVERVIEW_OPEN_KEY, String(open));
    setOverviewOpen(open);
  };
  const openConversation = (id: ConversationId): void => void remote.controller.switchConversation(id);
  // A fork or subagent of the shown family still at work: the closed panel's
  // button carries a dot so the activity is not out of sight entirely.
  const root = conversation === undefined ? undefined : rootOf(view.organized, conversation.conversation.id);
  const liveActivity = root !== undefined && anyAtWork(root.children);
  const openTasks = (id?: ConversationId): void => {
    if (id !== undefined) return openInPanel(id, "tasks");
    void remote.controller.showSide(undefined);
    onPanelTab("tasks");
    onPanelOpen(true);
  };

  const sidebar = (
    <SidebarContent
      view={view}
      remote={remote}
      draftingChat={draftingChat}
      shownId={conversation?.conversation.id}
      onDraft={onDraft}
      onSelect={() => setNavOpen(false)}
    />
  );

  return (
    <>
      <AppShell
        className="pigui-app-layout text-foreground"
        contentPadding={0}
        mobileNav={false}
        variant="elevated"
        sideNav={
          // Offcanvas on purpose: closed means fully removed — no icon rail.
          narrow || !sidebarOpen ? undefined : (
            <SideNav
              resizable={{ defaultWidth: 260, minWidth: 240, maxWidth: 320, autoSaveId: "pinomad-app-shell" }}
              header={
                <SidebarHeaderBand
                  connection={view.connection}
                  onCollapse={toggleSidebar}
                  safeLeft={sidebarOwnsCorner ? chrome.safeLeft : undefined}
                />
              }
              footer={
                <SidebarFooter
                  view={view}
                  onOpenDevices={() => setDevicesOpen(true)}
                  onOpenSettings={() => setSettingsOpen(true)}
                  onPairHost={() => setPairHostOpen(true)}
                  onOpenAccount={() => setAccountOpen(true)}
                  onForgetHost={() => setForgetHostOpen(true)}
                />
              }
            >
              {sidebar}
            </SideNav>
          )
        }
      >
        <div className="flex h-full min-h-0 min-w-0 flex-col">
          <FrameHeader
            narrow={narrow}
            sidebarOpen={sidebarOpen}
            safeLeft={chrome.reserveMacTrafficLights && !sidebarOwnsCorner ? chrome.safeLeft : undefined}
            onToggleSidebar={toggleSidebar}
            onOpenNav={() => setNavOpen(true)}
            title={drafting ? draftLabel : displayName(summary)}
            role={summary?.role}
            parentSummary={parentSummary}
            onBackToParent={openConversation}
            showOverview={conversation !== undefined}
            overviewOpen={overviewOpen}
            onOverviewChange={changeOverview}
            panelOpen={panelOpen}
            onPanelChange={onPanelOpen}
            liveActivity={liveActivity}
          />
          {banner}
          <div className="flex min-h-0 min-w-0 flex-1">
            {/* ChatLayout's scroll area needs a flex column parent so its
                flex-1/min-h-0 clips instead of stretching to content. */}
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              {children}
              {overviewOpen && conversation !== undefined ? (
                <OverviewCard
                  view={view}
                  remote={remote}
                  conversation={conversation}
                  busy={isBusy(conversation)}
                  onOpenChanges={onOpenChanges}
                  onOpenTasks={openTasks}
                  onClose={() => changeOverview(false)}
                />
              ) : null}
            </div>
            {!narrow ? (
              <SidePanel
                view={view}
                remote={remote}
                conversation={conversation}
                narrow={false}
                open={panelOpen}
                onOpenChange={onPanelOpen}
                tab={panelTab}
                onTabChange={onPanelTab}
                openInPanel={openInPanel}
                onOpenInMain={openInMain}
              />
            ) : null}
          </div>
        </div>
      </AppShell>
      {narrow ? (
        // The drawer is a top-layer <dialog>, outside .pigui-app-layout's DOM —
        // give it the scoping class so the sidebar rules reach it too.
        <MobileNav
          className="pigui-app-layout text-foreground"
          isOpen={navOpen}
          onOpenChange={setNavOpen}
          header={
            <span className="flex items-center gap-2">
              <span className="text-sm font-semibold">PiNomad</span>
              <ConnectionDot connection={view.connection} />
            </span>
          }
        >
          {sidebar}
          <SidebarFooter
            view={view}
            onOpenDevices={() => setDevicesOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onPairHost={() => setPairHostOpen(true)}
            onOpenAccount={() => setAccountOpen(true)}
            onForgetHost={() => setForgetHostOpen(true)}
            onSelect={() => setNavOpen(false)}
          />
        </MobileNav>
      ) : null}
      {narrow ? (
        <SidePanel
          view={view}
          remote={remote}
          conversation={conversation}
          narrow
          open={panelOpen}
          onOpenChange={onPanelOpen}
          tab={panelTab}
          onTabChange={onPanelTab}
          openInPanel={openInPanel}
          onOpenInMain={openInMain}
        />
      ) : null}
      {devicesOpen ? (
        <DevicesDialog view={view} remote={remote} self={device} onClose={() => setDevicesOpen(false)} />
      ) : null}
      {settingsOpen ? <SettingsDialog view={view} remote={remote} onClose={() => setSettingsOpen(false)} /> : null}
      {pairHostOpen ? <PairHostDialog onClose={() => setPairHostOpen(false)} /> : null}
      {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
      {forgetHostOpen ? <ForgetHostDialog onClose={() => setForgetHostOpen(false)} /> : null}
      {/* Every notice the workbench learns about also lands as a toast —
          rejected commands only surface as notices otherwise, and the panel
          that lists them starts closed. isTopLayer lifts it above dialogs. */}
      <ToastViewport position="topEnd" inset={{ top: 48 }} isTopLayer>
        <NoticeToasts notices={view.notices} />
      </ToastViewport>
    </>
  );
}

function NoticeToasts({ notices }: { notices: readonly Notice[] }) {
  const toast = useToast();
  // Notices already present at mount are history the dock shows; only toast
  // what arrives after. The last seen id survives re-renders and switches.
  const seenRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const latest = notices[notices.length - 1]?.id;
    if (seenRef.current === undefined) {
      seenRef.current = latest ?? -1;
      return;
    }
    for (const notice of notices) {
      if (notice.id <= seenRef.current) continue;
      toast({
        body: notice.message,
        type: notice.level === "error" ? "error" : "info",
        uniqueID: String(notice.id),
      });
    }
    if (latest !== undefined) seenRef.current = latest;
  }, [notices, toast]);
  return null;
}

function FrameHeader({
  narrow,
  sidebarOpen,
  safeLeft,
  onToggleSidebar,
  onOpenNav,
  title,
  role,
  parentSummary,
  onBackToParent,
  showOverview,
  overviewOpen,
  onOverviewChange,
  panelOpen,
  onPanelChange,
  liveActivity,
}: {
  narrow: boolean;
  sidebarOpen: boolean;
  /** Left inset reserved for the macOS traffic lights; absent off-desktop. */
  safeLeft?: string;
  onToggleSidebar: () => void;
  onOpenNav: () => void;
  title: string;
  /** The named agent the shown conversation was created with (ADR-0023). */
  role?: string;
  parentSummary: ConversationSummary | undefined;
  onBackToParent: (id: ConversationId) => void;
  showOverview: boolean;
  overviewOpen: boolean;
  onOverviewChange: (open: boolean) => void;
  panelOpen: boolean;
  onPanelChange: (open: boolean) => void;
  liveActivity: boolean;
}) {
  return (
    <div
      className="pinomad-drag flex h-10 shrink-0 items-center gap-1 border-b border-border px-3"
      style={safeLeft === undefined ? undefined : { paddingLeft: safeLeft }}
    >
      {narrow ? (
        <IconButton
          icon={<AnimatedSidebar className="size-4" />}
          label="Open navigation"
          size="sm"
          variant="ghost"
          onClick={onOpenNav}
        />
      ) : sidebarOpen ? null : (
        <IconButton
          icon={<AnimatedSidebar className="size-4" />}
          label="Expand sidebar"
          size="sm"
          variant="ghost"
          onClick={onToggleSidebar}
        />
      )}
      <h1 className="min-w-0 flex-1 truncate text-sm font-normal">
        {parentSummary === undefined ? (
          <span className="flex items-center gap-1.5">
            <span className="truncate">{title}</span>
            {role === undefined ? null : <span className="shrink-0 text-muted">@{role}</span>}
          </span>
        ) : (
          <span className="flex items-center gap-1">
            <Button
              label={displayName(parentSummary)}
              aria-label={`Back to ${displayName(parentSummary)}`}
              variant="ghost"
              size="sm"
              onClick={() => onBackToParent(parentSummary.id)}
            />
            <span aria-hidden="true" className="text-muted">
              ›
            </span>
            <span className="truncate">{title}</span>
            {role === undefined ? null : <span className="shrink-0 text-muted">@{role}</span>}
          </span>
        )}
      </h1>
      {showOverview ? (
        <IconButton
          aria-pressed={overviewOpen}
          icon={<ListBullet className="size-4" />}
          label="Overview"
          size="sm"
          tooltip={overviewOpen ? "Hide overview" : "Show overview"}
          variant="ghost"
          onClick={() => onOverviewChange(!overviewOpen)}
        />
      ) : null}
      <span className="relative">
        <IconButton
          aria-pressed={panelOpen}
          icon={<AnimatedSidebarRight className="size-4" />}
          label="Side panel"
          size="sm"
          tooltip={panelOpen ? "Hide side panel" : "Show side panel"}
          variant="ghost"
          onClick={() => onPanelChange(!panelOpen)}
        />
        {!panelOpen && liveActivity ? (
          <span
            aria-label="Live activity"
            className="pointer-events-none absolute right-1 top-1 size-2 rounded-full bg-primary"
            role="img"
          />
        ) : null}
      </span>
    </div>
  );
}
