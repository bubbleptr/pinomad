import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { IconButton } from "@astryxdesign/core/IconButton";
import { MobileNav } from "@astryxdesign/core/MobileNav";
import { SideNav } from "@astryxdesign/core/SideNav";
import { ToastViewport, useToast } from "@astryxdesign/core/Toast";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { ConversationSummary, Notice } from "@pinomad/protocol/view.ts";
import type { KeyPair } from "@pinomad/protocol/noise.ts";
import type { Home } from "@pinomad/protocol/organization.ts";
import { displayName } from "@pinomad/client/family.ts";
import { hostWindowChrome } from "../../shared/host-chrome.ts";
import { AppleReminder } from "../../shared/ui/icons.tsx";
import { AnimatedSidebar, AnimatedSidebarRight } from "../../shared/ui/animated-icons.tsx";
import {
  SidebarContent,
  SidebarFooter,
  SidebarHeaderBand,
  type SidebarLocate,
  type SidebarMachine,
} from "./sidebar.tsx";
import { SettingsDialog } from "./settings-dialog.tsx";
import { AccountDialog } from "../account/account-dialog.tsx";

const SIDEBAR_OPEN_KEY = "pinomad.sidebar.open";

const readSidebarOpen = (): boolean =>
  typeof window === "undefined" || window.localStorage.getItem(SIDEBAR_OPEN_KEY) !== "false";

/** Frame actions the main column needs: it renders the header but not the shell. */
interface FrameChrome {
  readonly sidebarOpen: boolean;
  readonly toggleSidebar: () => void;
  readonly openNav: () => void;
}

const defaultFrameChrome: FrameChrome = {
  sidebarOpen: true,
  toggleSidebar: () => {},
  openNav: () => {},
};

const FrameChromeContext = createContext<FrameChrome>(defaultFrameChrome);

export const useFrameChrome = (): FrameChrome => useContext(FrameChromeContext);

/** A sidebar machine plus what Settings needs to manage it. */
export interface FrameMachine extends SidebarMachine {
  /** The stored pairing; absent for a token client. */
  readonly hostKey?: string;
  /** This client's device key on that host, for marking "This device". */
  readonly device?: KeyPair;
  /** Remount the connection after a terminal close (for example Direct only). */
  readonly retry?: () => void;
}

/**
 * The app frame: Astryx AppShell, sidebar, mobile drawer, and the dialogs that
 * belong to this client rather than one host. It outlives every host runtime,
 * so a host connecting, failing or losing focus cannot remove the sidebar.
 */
export function AppFrame({
  machines,
  focusKey,
  draftingChat,
  shownId,
  onDraft,
  onOpen,
  onNewChat,
  onShowMachine,
  narrow,
  children,
}: {
  /** Every paired machine in stored order (ADR-0035 §1). */
  machines: readonly FrameMachine[];
  /** The machine the main column shows. */
  focusKey: string | undefined;
  /** The focused machine is showing its plain-chat draft. */
  draftingChat: boolean;
  shownId: ConversationId | undefined;
  onDraft: (key: string, home: Home) => void;
  onOpen: (key: string, id: ConversationId) => void;
  /** The global New chat picks a machine by itself instead of following focus. */
  onNewChat?: () => void;
  onShowMachine?: (key: string) => void;
  narrow: boolean;
  children: ReactNode;
}) {
  const [sidebarOpen, setSidebarOpen] = useState(readSidebarOpen);
  const [navOpen, setNavOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [locate, setLocate] = useState<SidebarLocate>();
  const focused = machines.find((machine) => machine.key === focusKey);
  // Under the desktop shell on macOS, the traffic lights own the top-left
  // corner: whichever band sits there reserves the inset and drags the window.
  const chrome = hostWindowChrome();
  const sidebarOwnsCorner = chrome.reserveMacTrafficLights && !narrow && sidebarOpen;
  const toggleSidebar = useCallback((): void => {
    setSidebarOpen((open) => {
      window.localStorage.setItem(SIDEBAR_OPEN_KEY, String(!open));
      return !open;
    });
  }, []);
  const openNav = useCallback((): void => setNavOpen(true), []);
  const locateHost = (hostKey: string): void => {
    const machine = machines.find((entry) => entry.hostKey === hostKey);
    if (machine !== undefined) setLocate((prev) => ({ key: machine.key, seq: (prev?.seq ?? 0) + 1 }));
  };
  const sidebar = (
    <SidebarContent
      machines={machines}
      focusKey={focusKey}
      draftingChat={draftingChat}
      shownId={shownId}
      {...(locate === undefined ? {} : { locate })}
      onDraft={onDraft}
      {...(onNewChat === undefined ? {} : { onNewChat })}
      onOpen={onOpen}
      {...(onShowMachine === undefined ? {} : { onShowMachine })}
      onSelect={() => setNavOpen(false)}
    />
  );

  return (
    // The viewport wraps the workbench so every descendant's useToast reaches
    // the same top-layer stack, not Astryx's detached fallback.
    <ToastViewport position="topEnd" inset={{ top: 48 }} isTopLayer>
      <FrameChromeContext.Provider value={{ sidebarOpen, toggleSidebar, openNav }}>
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
                    onCollapse={toggleSidebar}
                    safeLeft={sidebarOwnsCorner ? chrome.safeLeft : undefined}
                  />
                }
                footer={
                  <SidebarFooter
                    onOpenSettings={() => setSettingsOpen(true)}
                    onOpenAccount={() => setAccountOpen(true)}
                    onLocateHost={locateHost}
                  />
                }
              >
                {sidebar}
              </SideNav>
            )
          }
        >
          {children}
        </AppShell>
        {narrow && (focused?.view === undefined || focused.view.unauthorized === true) ? (
          // The workbench header (and its navigation button) exists only when
          // it paints the column. A phone still needs a way into the drawer
          // while the focused host is connecting, failed, or revoked.
          <div
            className="pinomad-drag fixed inset-x-0 top-0 z-30 flex h-10 items-center gap-1 px-3"
            style={chrome.reserveMacTrafficLights ? { paddingLeft: chrome.safeLeft } : undefined}
          >
            <IconButton
              icon={<AnimatedSidebar className="size-4" />}
              label="Open navigation"
              size="sm"
              variant="ghost"
              onClick={openNav}
            />
            <span className="text-sm font-semibold">PiNomad</span>
          </div>
        ) : null}
        {narrow ? (
          // The drawer is a top-layer <dialog>, outside .pigui-app-layout's DOM —
          // give it the scoping class so the sidebar rules reach it too.
          <MobileNav
            className="pigui-app-layout text-foreground"
            isOpen={navOpen}
            onOpenChange={setNavOpen}
            header={<span className="text-sm font-semibold">PiNomad</span>}
          >
            {sidebar}
            <SidebarFooter
              onOpenSettings={() => setSettingsOpen(true)}
              onOpenAccount={() => setAccountOpen(true)}
              onLocateHost={locateHost}
              onSelect={() => setNavOpen(false)}
            />
          </MobileNav>
        ) : null}
        {settingsOpen ? (
          <SettingsDialog
            machines={machines}
            {...(focusKey === undefined ? {} : { initialKey: focusKey })}
            onClose={() => setSettingsOpen(false)}
          />
        ) : null}
        {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
      </FrameChromeContext.Provider>
    </ToastViewport>
  );
}

/**
 * The in-flow 40px header above the main column. It lives in the Workbench
 * because its title and buttons follow the shown conversation; the frame
 * supplies the sidebar actions through context.
 */
export function FrameHeader({
  narrow,
  title,
  agent,
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
  title: string;
  /** The agent the shown conversation runs as; for a subagent, its call-given role. */
  agent?: string;
  parentSummary: ConversationSummary | undefined;
  onBackToParent: (id: ConversationId) => void;
  showOverview: boolean;
  overviewOpen: boolean;
  onOverviewChange: (open: boolean) => void;
  panelOpen: boolean;
  onPanelChange: (open: boolean) => void;
  liveActivity: boolean;
}) {
  const { sidebarOpen, toggleSidebar, openNav } = useFrameChrome();
  const chrome = hostWindowChrome();
  const sidebarOwnsCorner = chrome.reserveMacTrafficLights && !narrow && sidebarOpen;
  const safeLeft =
    chrome.reserveMacTrafficLights && !sidebarOwnsCorner ? chrome.safeLeft : undefined;
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
          onClick={openNav}
        />
      ) : sidebarOpen ? null : (
        <IconButton
          icon={<AnimatedSidebar className="size-4" />}
          label="Expand sidebar"
          size="sm"
          variant="ghost"
          onClick={toggleSidebar}
        />
      )}
      <h1 className="min-w-0 flex-1 truncate text-sm font-normal">
        {parentSummary === undefined ? (
          <span className="flex items-center gap-1.5">
            <span className="truncate">{title}</span>
            {agent === undefined ? null : <span className="shrink-0 text-muted">@{agent}</span>}
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
            {agent === undefined ? null : <span className="shrink-0 text-muted">@{agent}</span>}
          </span>
        )}
      </h1>
      {showOverview ? (
        <IconButton
          aria-pressed={overviewOpen}
          // The shaded button says the card is open, beside aria-pressed.
          className={overviewOpen ? "bg-[var(--color-overlay-pressed)]" : undefined}
          icon={<AppleReminder className="size-4" />}
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

export function NoticeToasts({ notices }: { notices: readonly Notice[] }) {
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
