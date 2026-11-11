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
import { AnimatedSidebar } from "../../shared/ui/animated-icons.tsx";
import {
  SidebarContent,
  SidebarFooter,
  SidebarHeaderBand,
  type SidebarLocate,
  type SidebarMachine,
} from "./sidebar.tsx";
import { useSettingsScreen, type SettingsRequest } from "./settings-page.tsx";
import { useAccountModel } from "../../entities/account/account-context.tsx";
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
  // Open Settings, on a given section or the default one.
  const [settingsAt, setSettingsAt] = useState<SettingsRequest>();
  // Where focus was when Settings opened, to put it back on close.
  const settingsOpener = useRef<Element | null>(null);
  const openSettings = useCallback((request: SettingsRequest): void => {
    settingsOpener.current = document.activeElement;
    setSettingsAt(request);
  }, []);
  const closeSettings = useCallback((): void => setSettingsAt(undefined), []);
  const [accountOpen, setAccountOpen] = useState(false);
  const account = useAccountModel();
  // Signed in, the account lives in Settings; otherwise the sign-in dialog.
  const openAccount = (): void => {
    if (account.state.status === "signed-in") openSettings({ section: "account" });
    else setAccountOpen(true);
  };
  const [locate, setLocate] = useState<SidebarLocate>();
  const focused = machines.find((machine) => machine.key === focusKey);
  // Under the desktop shell on macOS, the traffic lights own the top-left
  // corner: whichever band sits there reserves the inset and drags the window.
  const chrome = hostWindowChrome();
  const settingsOpen = settingsAt !== undefined;
  const sidebarOwnsCorner = chrome.reserveMacTrafficLights && !narrow && (sidebarOpen || settingsOpen);
  const settings = useSettingsScreen({
    machines,
    request: settingsAt,
    focusKey,
    narrow,
    ...(chrome.reserveMacTrafficLights && (narrow || sidebarOwnsCorner) ? { safeLeft: chrome.safeLeft } : {}),
    onClose: closeSettings,
  });
  useEffect(() => {
    if (settingsOpen) return;
    const opener = settingsOpener.current;
    settingsOpener.current = null;
    if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
  }, [settingsOpen]);
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
        {/* In Settings the whole shell is the Settings page: its nav in the
            sidebar's place, its section in the main pane. The sidebar and the
            workbench stay mounted underneath, hidden. */}
        <AppShell
          className={`pigui-app-layout text-foreground${narrow ? "" : " pigui-inset"}${
            narrow || sidebarOpen || settingsOpen ? "" : " pigui-inset--bare"
          }`}
          contentPadding={0}
          mobileNav={false}
          variant="elevated"
          sideNav={
            // Offcanvas on purpose: closed means fully removed — no icon rail.
            narrow || !(sidebarOpen || settingsOpen) ? undefined : (
              <>
                {sidebarOpen ? (
                  <div className="contents" hidden={settingsOpen}>
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
                          onOpenSettings={() => openSettings({})}
                          onOpenAccount={openAccount}
                          onLocateHost={locateHost}
                        />
                      }
                    >
                      {sidebar}
                    </SideNav>
                  </div>
                ) : null}
                {settings?.nav}
              </>
            )
          }
        >
          <div className="pigui-stage" hidden={settingsOpen}>
            {children}
          </div>
          {settings === undefined ? null : (
            <div className="pigui-stage">
              <section aria-label="Settings" className="pigui-pane">
                {settings.content}
              </section>
            </div>
          )}
        </AppShell>
        {!settingsOpen && (narrow || !sidebarOpen) && (focused?.view === undefined || focused.view.unauthorized === true) ? (
          // The workbench header (and its navigation button) exists only when
          // it paints the column. A phone, or a desktop with the sidebar
          // collapsed, still needs a way back to it while the focused host is
          // connecting, failed, or revoked.
          <div
            className="pinomad-drag fixed inset-x-0 top-0 z-30 flex h-10 items-center gap-1 px-3"
            style={chrome.reserveMacTrafficLights ? { paddingLeft: chrome.safeLeft } : undefined}
          >
            <IconButton
              icon={<AnimatedSidebar className="size-4" />}
              label={narrow ? "Open navigation" : "Expand sidebar"}
              size="sm"
              variant="ghost"
              onClick={narrow ? openNav : toggleSidebar}
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
              onOpenSettings={() => openSettings({})}
              onOpenAccount={openAccount}
              onLocateHost={locateHost}
              onSelect={() => setNavOpen(false)}
            />
          </MobileNav>
        ) : null}
        {accountOpen ? <AccountDialog onClose={() => setAccountOpen(false)} /> : null}
        {/* Every notice a machine reports also lands as a toast — rejected
            commands only surface as notices otherwise, and the panel that
            lists them starts closed. */}
        {machines.map((machine) =>
          machine.view === undefined ? null : (
            <NoticeToasts
              key={machine.key}
              machineKey={machine.key}
              source={machines.length > 1 ? machine.label : undefined}
              notices={machine.view.notices}
              restarting={machine.view.connection === "reconnecting" && machine.view.upgrade?.phase === "installing"}
            />
          ),
        )}
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
  panelControls,
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
  /** The side panel's surface icons (ADR-0040), last in the row next to the panel. */
  panelControls: ReactNode;
}) {
  const { sidebarOpen, toggleSidebar, openNav } = useFrameChrome();
  const chrome = hostWindowChrome();
  const sidebarOwnsCorner = chrome.reserveMacTrafficLights && !narrow && sidebarOpen;
  const safeLeft =
    chrome.reserveMacTrafficLights && !sidebarOwnsCorner ? chrome.safeLeft : undefined;
  return (
    <div
      className="pinomad-drag flex h-10 shrink-0 items-center gap-1 px-3"
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
            {agent === undefined ? null : <span className="shrink-0 text-muted-foreground">@{agent}</span>}
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
            <span aria-hidden="true" className="text-muted-foreground">
              ›
            </span>
            <span className="truncate">{title}</span>
            {agent === undefined ? null : <span className="shrink-0 text-muted-foreground">@{agent}</span>}
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
      {panelControls}
    </div>
  );
}

/**
 * One machine's notices as toasts. The frame mounts one per machine with a
 * snapshot, so a warning from an action on a machine that is not focused —
 * archiving from its sidebar group, say — still surfaces.
 */
function NoticeToasts({
  machineKey,
  source,
  notices,
  restarting,
}: {
  machineKey: string;
  /** Named in the toast when several machines could have sent it. */
  source: string | undefined;
  notices: readonly Notice[];
  /**
   * The host exited to finish an upgrade (ADR-0043): the client's "could not
   * connect" notice is the expected restart, which the connection banner
   * already explains, so it stays out of the toasts.
   */
  restarting: boolean;
}) {
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
      if (restarting && notice.level === "error") continue;
      toast({
        body: source === undefined ? notice.message : `${source}: ${notice.message}`,
        type: notice.level === "error" ? "error" : "info",
        // Notice ids are per host; two machines can both send notice 3.
        uniqueID: `${machineKey}:${notice.id}`,
      });
    }
    if (latest !== undefined) seenRef.current = latest;
  }, [machineKey, notices, source, toast, restarting]);
  return null;
}
