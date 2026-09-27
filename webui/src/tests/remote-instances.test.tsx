import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteInstances } from "@/components/remote/RemoteInstances";
import { RemoteConnectionsPage } from "@/components/remote/RemoteConnectionsPage";
import { Sidebar } from "@/components/Sidebar";
import { HOST_BRIDGE } from "@/components/remote/host-bridge";
import { readSelectedRemote, rememberSelectedRemote, validateRemoteConnection, type RemoteConnection } from "@/lib/remote-instances";
import i18n from "@/i18n";
import type { Window as HappyWindow } from "happy-dom";

(window as unknown as HappyWindow).happyDOM.settings.disableIframePageLoading = true;

const mocks = vi.hoisted(() => {
  const request = vi.fn();
  const discover = vi.fn();
  const onStatus = vi.fn();
  return { read: vi.fn(), request, discover, onStatus, client: { status: "open", requestMutation: (action: string, payload: unknown, timeout: number) => action === "remote.discover" ? discover(payload) : request(action, payload, timeout), onStatus }, token: () => "local-token" };
});
vi.mock("@/providers/ClientProvider", () => ({ useClient: () => ({ client: mocks.client, getToken: mocks.token }) }));
vi.mock("@/lib/remote-instances", async (original) => ({
  ...await original<typeof import("@/lib/remote-instances")>(), readRemoteInstances: mocks.read,
}));

const profile = { id: "3b968d52-081d-4898-9970-ff0a1fc93817", name: "Team server", host: "ubuntu@example.test", port: 22, config_path: "~/.nanobot/config.json", ssh_config: "", identity_file: "", runtime_user: "", connected: false };
const connection: RemoteConnection = { ...profile, hostname: "team-host", gateway_id: "gateway-1", url: "http://127.0.0.1:23456/#/?bootstrapSecret=private-secret" };
const noop = () => {};
function LocalShell({ collapsed = false, initialRemote = false }) {
  const [remotePage, setRemotePage] = useState(initialRemote);
  return <>
  <Sidebar collapsed={collapsed} sessions={[]} activeKey={null} loading={false} newChatActive={false}
    onNewChat={() => setRemotePage(false)} onSelect={noop} onRequestDelete={noop} onTogglePin={noop}
    onRequestRename={noop} onToggleArchive={noop} onToggleGroup={noop}
    onRequestRenameProject={noop} onNewChatInProject={noop} onOpenSettings={noop}
    onOpenApps={noop} onOpenSkills={noop} onOpenAutomations={noop} onOpenChannels={noop}
    onOpenRemoteConnections={() => setRemotePage(true)} activeUtility={remotePage ? "remote" : null}
    onOpenSearch={noop} onToggleArchived={noop} />
  <main>{remotePage ? <RemoteConnectionsPage onBackToChat={() => setRemotePage(false)} /> : <><p>Local conversations</p><textarea aria-label="Local draft" /></>}</main>
  </>;
}
const view = (collapsed = false, initialRemote = false) => render(<RemoteInstances><LocalShell collapsed={collapsed} initialRemote={initialRemote} /></RemoteInstances>);

beforeEach(async () => {
  await i18n.changeLanguage("en");
  window.sessionStorage.clear(); window.localStorage.clear();
  mocks.onStatus.mockReset().mockImplementation((handler) => { handler("open"); return () => {}; });
  mocks.read.mockReset().mockResolvedValue({ available: true, machine_name: "Xubin-Mac", profiles: [profile] });
  mocks.discover.mockReset().mockResolvedValue({ hosts: [], files: [], incomplete: false });
  mocks.request.mockReset().mockImplementation(async (action: string) => {
    if (action === "remote.connect") return connection;
    if (action === "remote.save") return { id: profile.id };
    return {};
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function readyRemote() {
  const frame = await screen.findByTitle("nanobot on Team server");
  await act(async () => { fireEvent.load(frame); });
  await waitFor(() => expect(readSelectedRemote()?.id).toBe(profile.id));
  return frame;
}
async function chooseHost(name: string) {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Switch host" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("menuitem", { name }));
}
async function openDirectory() {
  fireEvent.click(await screen.findByRole("button", { name: "Remote connections" }));
}

describe("remote instance UX", () => {
  it("places remote connections after Channels with the existing sidebar button style", async () => {
    view();
    const entry = await screen.findByRole("button", { name: "Remote connections" });
    const channels = screen.getByRole("button", { name: "Channels" });
    expect(channels.nextElementSibling).toBe(entry);
    expect(entry).toHaveClass("h-8", "rounded-xl", "text-[13px]");
    expect(entry).not.toHaveAttribute("aria-haspopup");
    expect(entry).not.toHaveAttribute("aria-current");
    expect(screen.queryByText("This machine")).not.toBeInTheDocument();
    fireEvent.click(entry);
    await screen.findByRole("heading", { name: "Remote connections" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("main")).toContainElement(screen.getByText("Team server"));
    expect(entry).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("navigation", { name: "Sidebar navigation" })).toBeVisible();
    expect(screen.getByText("Local nanobot")).toBeInTheDocument();
    expect(screen.getByText("Currently using")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Connect to remote nanobot…" })).toBeInTheDocument();
  });

  it("keeps the connection action accessible when the sidebar is collapsed", async () => {
    view(true);
    const entry = await screen.findByRole("button", { name: "Remote connections" });
    expect(entry).toHaveClass("w-8", "justify-center");
    expect(entry.textContent).toBe("");
    const switcher = screen.getByRole("button", { name: "Switch host" });
    expect(switcher).toHaveClass("w-8", "h-8");
    expect(switcher).toHaveAttribute("title", expect.stringContaining("Xubin-Mac"));
    fireEvent.click(entry);
    await screen.findByRole("heading", { name: "Remote connections" });
  });

  it("moves the remote picker into a verified sidebar and can return local through its parent-owned menu", async () => {
    view();
    await screen.findByText("Local");
    await chooseHost("Team server ubuntu@example.test");
    const frame = await screen.findByTitle("nanobot on Team server");
    const source = { postMessage: vi.fn() };
    Object.defineProperty(frame, "contentWindow", { value: source });
    await act(async () => { fireEvent.load(frame); });
    await waitFor(() => expect(readSelectedRemote()?.id).toBe(profile.id));
    expect(screen.getByTestId("legacy-host-footer")).toBeVisible();
    const nonce = source.postMessage.mock.calls[0][0].nonce;
    const message = (data: Record<string, unknown>) => act(() => {
      window.dispatchEvent(new MessageEvent("message", { source: source as unknown as Window,
        origin: "http://127.0.0.1:23456", data: { channel: HOST_BRIDGE, nonce, ...data } }));
    });
    message({ type: "ready" });
    expect(screen.queryByTestId("legacy-host-footer")).not.toBeInTheDocument();
    message({ type: "open", anchor: { left: 40, top: 500, width: 150, height: 32 } });
    expect(await screen.findByRole("menu")).toHaveAttribute("data-side", "top");
    fireEvent.click(screen.getByRole("menuitem", { name: "Local nanobot Xubin-Mac" }));
    await waitFor(() => expect(screen.getByText("Local conversations")).toBeVisible());
    expect(frame).toBeInTheDocument();
    expect(mocks.request.mock.calls.some(([action]) => action === "remote.disconnect")).toBe(false);
  });

  it("uses clear Chinese navigation and returns from the connection form without saving", async () => {
    await i18n.changeLanguage("zh-CN");
    view();
    fireEvent.click(await screen.findByRole("button", { name: "远程连接" }));
    expect(screen.getByText("本地 nanobot")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "连接远程 nanobot…" }));
    expect(screen.getByRole("heading", { name: "连接远程 nanobot" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "返回" }));
    expect(screen.getByRole("heading", { name: "远程连接" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "SSH 地址" })).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("opens a saved server without asking for keys or configuration again", async () => {
    view(); await openDirectory();
    fireEvent.click(screen.getByRole("button", { name: "Team server ubuntu@example.test" }));
    const frame = await readyRemote();
    expect(frame).toHaveAttribute("src", connection.url);
    expect(frame).toHaveAttribute("sandbox", expect.not.stringContaining("allow-top-navigation"));
    expect(document.querySelector('[data-host-view="local"]')).toHaveAttribute("inert");
    expect(screen.getByRole("button", { name: "Switch host" })).toHaveAttribute("title", expect.stringContaining("Team server · team-host"));
    expect(mocks.request).toHaveBeenCalledWith("remote.connect", { id: profile.id }, 65_000);
    expect(window.sessionStorage.getItem("nanobot.remote-instance")).not.toContain("secret");
    const storedValues = Array.from({ length: window.localStorage.length }, (_, index) =>
      window.localStorage.getItem(window.localStorage.key(index) || ""));
    expect(JSON.stringify(storedValues)).not.toContain("private-secret");
    expect(JSON.stringify(storedValues)).not.toContain(connection.url);
  });

  it("returning local keeps the saved server view and SSH warm", async () => {
    view(); await openDirectory();
    fireEvent.click(screen.getByRole("button", { name: "Team server ubuntu@example.test" }));
    await readyRemote();
    await chooseHost("Local nanobot Xubin-Mac");
    expect(screen.getByRole("heading", { name: "Remote connections" })).toBeVisible();
    expect(mocks.request.mock.calls.some(([action]) => action === "remote.disconnect")).toBe(false);
    expect(readSelectedRemote()).toBeNull();
    expect(mocks.request.mock.calls.some(([action]) => String(action).includes("stop"))).toBe(false);
  });

  it("keeps local drafts, view identity and keyboard focus across warm round trips", async () => {
    view();
    const draft = screen.getByRole("textbox", { name: "Local draft" });
    draft.focus();
    fireEvent.change(draft, { target: { value: "Unsent local draft" } });
    await screen.findByText("Local");
    await chooseHost("Team server ubuntu@example.test");
    const frame = await readyRemote();
    expect(draft).not.toBeVisible();
    const shortcut = vi.fn();
    window.addEventListener("keydown", shortcut);
    fireEvent.keyDown(screen.getByRole("button", { name: "Switch host" }), { key: "b", metaKey: true });
    expect(shortcut).not.toHaveBeenCalled();
    window.removeEventListener("keydown", shortcut);
    await chooseHost("Local nanobot Xubin-Mac");
    await waitFor(() => expect(draft).toHaveFocus());
    expect(screen.getByRole("textbox", { name: "Local draft" })).toBe(draft);
    expect(draft).toHaveValue("Unsent local draft");
    await chooseHost("Team server ubuntu@example.test Ready");
    expect(screen.getByTitle("nanobot on Team server")).toBe(frame);
    expect(mocks.request.mock.calls.filter(([action]) => action === "remote.connect")).toHaveLength(1);
  });

  it("can close an offline cached view, but confirms before discarding its state", async () => {
    view(); await openDirectory();
    fireEvent.click(screen.getByRole("button", { name: "Team server ubuntu@example.test" }));
    await readyRemote();
    await chooseHost("Local nanobot Xubin-Mac");
    fireEvent.pointerDown(screen.getByRole("button", { name: "Manage Team server" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Disconnect" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect from Team server?" });
    expect(mocks.request.mock.calls.some(([action]) => action === "remote.disconnect")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.queryByTitle("nanobot on Team server")).not.toBeInTheDocument());
    expect(mocks.request).toHaveBeenCalledWith("remote.disconnect", { id: profile.id }, 65_000);
  });

  it("refresh restores the selected remote, keeping the local shell hidden", async () => {
    rememberSelectedRemote(connection);
    view();
    expect(screen.queryByText("Local conversations")).not.toBeVisible();
    await readyRemote();
    expect(mocks.request).toHaveBeenCalledWith("remote.connect", { id: profile.id }, 65_000);
  });

  it("failed restore stays remote and offers reconnect and an explicit return", async () => {
    rememberSelectedRemote(connection);
    mocks.request.mockRejectedValue(new Error("ssh_unreachable"));
    view();
    await screen.findByText("Server connection lost");
    expect(screen.queryByText("Local conversations")).not.toBeVisible();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to local nanobot" }));
    await screen.findByText("Local conversations");
  });

  it("waits for the local socket before restoring and restores only once", async () => {
    let status: ((value: string) => void) | undefined;
    const unsubscribe = vi.fn();
    mocks.onStatus.mockImplementation((handler) => { status = handler; handler("connecting"); return unsubscribe; });
    rememberSelectedRemote(connection);
    const rendered = view();
    expect(mocks.request).not.toHaveBeenCalled();
    expect(screen.queryByText("Local conversations")).not.toBeVisible();
    await act(async () => { status?.("open"); });
    await readyRemote();
    await act(async () => { status?.("reconnecting"); status?.("open"); });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    rendered.unmount();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("clears errors from an earlier connection when opening a server from the page", async () => {
    rememberSelectedRemote(connection);
    mocks.request.mockRejectedValue(new Error("ssh_unreachable"));
    view();
    await screen.findByText("Server connection lost");
    fireEvent.click(screen.getByRole("button", { name: "Back to local nanobot" }));
    await screen.findByText("Local conversations");
    mocks.request.mockResolvedValue(connection);
    await openDirectory();
    fireEvent.click(screen.getByRole("button", { name: "Team server ubuntu@example.test" }));
    await readyRemote();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("saves once and preserves entered fields when SSH authentication fails", async () => {
    mocks.request.mockImplementation(async (action: string) => {
      if (action === "remote.save") return { id: profile.id };
      throw new Error("ssh_auth_failed");
    });
    view(); await openDirectory(); fireEvent.click(screen.getByRole("button", { name: "Connect to remote nanobot…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "SSH address" }), { target: { value: "ubuntu@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("textbox", { name: "SSH address" })).toHaveValue("ubuntu@example.test");
    expect(screen.getByRole("button", { name: "Save & connect" })).toBeEnabled();
    expect(mocks.request.mock.calls.filter(([action]) => action === "remote.save")).toHaveLength(1);
  });

  it("doesn't create privileged controls on an unsupported remote gateway", async () => {
    mocks.read.mockResolvedValue({ available: false, profiles: [] });
    view(); await waitFor(() => expect(mocks.read).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Remote connections" })).not.toBeInTheDocument();
  });

  it("does not discover SSH hosts or expose nested connections inside a remote frame", async () => {
    vi.stubGlobal("top", {});
    view(false, true);
    await screen.findByText(i18n.t("remote.unavailable"));
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Remote connections" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect to remote nanobot…" })).not.toBeInTheDocument();
  });

  it("offers existing SSH hosts or manual inline setup for the first server", async () => {
    mocks.read.mockResolvedValue({ available: true, profiles: [] });
    view(); await openDirectory();
    await screen.findByText("No named hosts found. You can enter an SSH address below.");
    fireEvent.click(screen.getByRole("button", { name: "Connect to remote nanobot…" }));
    const host = screen.getByRole("textbox", { name: "SSH address" });
    expect(host.closest(".settings-row")).not.toBeNull();
    expect(screen.getByRole("main")).toContainElement(host);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Connect to remote nanobot…" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save & connect" })).toBeDisabled();
  });

  it("does not navigate to a remote instance after leaving a pending connection", async () => {
    let finish: ((result: RemoteConnection) => void) | undefined;
    mocks.request.mockImplementation(() => new Promise<RemoteConnection>((resolve) => { finish = resolve; }));
    view(); await openDirectory();
    fireEvent.click(screen.getByRole("button", { name: "Team server ubuntu@example.test" }));
    fireEvent.click(screen.getByRole("button", { name: "New topic" }));
    await act(async () => { finish?.(connection); });
    expect(screen.getByText("Local conversations")).toBeVisible();
    expect(screen.queryByTitle("nanobot on Team server")).not.toBeInTheDocument();
    expect(readSelectedRemote()).toBeNull();
  });

  it("does not start SSH if the user leaves while a profile is saving", async () => {
    let finish: ((result: { id: string }) => void) | undefined;
    mocks.read.mockResolvedValue({ available: true, profiles: [] });
    mocks.request.mockImplementation(() => new Promise<{ id: string }>((resolve) => { finish = resolve; }));
    view(); await openDirectory();
    fireEvent.click(screen.getByRole("button", { name: "Connect to remote nanobot…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "SSH address" }), { target: { value: "ubuntu@example.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));
    fireEvent.click(screen.getByRole("button", { name: "New topic" }));
    await act(async () => { finish?.({ id: profile.id }); });
    expect(mocks.request).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Local conversations")).toBeVisible();
  });

  it("keeps cached servers visible during refresh and lets users retry failed reads", async () => {
    view();
    await screen.findByRole("button", { name: "Remote connections" });
    mocks.read.mockRejectedValue(new Error("directory_unavailable"));
    await openDirectory();
    await screen.findByRole("alert");
    expect(screen.getByText("Team server")).toBeVisible();
    mocks.read.mockResolvedValue({ available: true, profiles: [profile] });
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(screen.getByText("Team server")).toBeVisible();
  });

  it("explains unavailable direct routes without displaying SSH controls", async () => {
    mocks.read.mockResolvedValue({ available: false, profiles: [] });
    view(false, true);
    await screen.findByText("Open this page from a locally running nanobot to connect to servers over SSH.");
    expect(screen.queryByRole("textbox", { name: "SSH address" })).not.toBeInTheDocument();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("identifies the host in the existing sidebar footer without a top bar", async () => {
    view();
    const identity = await screen.findByRole("button", { name: "Switch host" });
    expect(identity).toHaveTextContent("Local");
    expect(identity).toHaveAttribute("title", expect.stringContaining("Xubin-Mac"));
    expect(screen.getByRole("navigation", { name: "Sidebar navigation" })).toContainElement(identity);
    expect(document.querySelector("header")).toBeNull();
    fireEvent.pointerDown(identity, { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: "Local nanobot Xubin-Mac" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Manage connections…" })).toBeVisible();
  });

  it("discovers and filters SSH aliases without connecting, then inherits the selected config", async () => {
    mocks.discover.mockResolvedValue({ hosts: [
      { host: "team-sg", source: "/home/test/.ssh/config", ssh_config: "" },
      { host: "staging", source: "/home/test/.ssh/hosts", ssh_config: "" },
    ], files: ["/home/test/.ssh/config"], incomplete: false });
    view(); await openDirectory();
    await screen.findByRole("button", { name: "Use team-sg" });
    expect(mocks.request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "Search SSH hosts" }), { target: { value: "team" } });
    expect(screen.queryByRole("button", { name: "Use staging" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Use team-sg" }));
    expect(screen.getByRole("textbox", { name: "SSH address" })).toHaveValue("team-sg");
    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));
    await readyRemote();
    expect(mocks.request).toHaveBeenCalledWith("remote.save", expect.objectContaining({ profile: expect.objectContaining({ host: "team-sg", ssh_config: "", port: null }) }), 65_000);
  });

  it("reads a custom SSH config and carries that path to the selected profile", async () => {
    view(); await openDirectory();
    fireEvent.click(screen.getByRole("button", { name: "Use another SSH config file" }));
    fireEvent.change(screen.getByRole("textbox", { name: "SSH config file to read" }), { target: { value: "/team/ssh_config" } });
    mocks.discover.mockResolvedValue({ hosts: [{ host: "team", source: "/team/ssh_config", ssh_config: "/team/ssh_config" }], files: ["/team/ssh_config"], incomplete: false });
    fireEvent.click(screen.getByRole("button", { name: "Read hosts" }));
    fireEvent.click(await screen.findByRole("button", { name: "Use team" }));
    fireEvent.click(screen.getByRole("button", { name: "Advanced options" }));
    expect(screen.getByRole("textbox", { name: "SSH config file (optional)" })).toHaveValue("/team/ssh_config");
    expect(screen.getByRole("spinbutton", { name: "SSH port" })).toHaveValue(null);
    expect(mocks.discover).toHaveBeenCalledWith({ ssh_config: "/team/ssh_config" });
    const reads = mocks.discover.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByRole("button", { name: "Use team" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "SSH config file to read" })).toHaveValue("/team/ssh_config");
    expect(mocks.discover).toHaveBeenCalledTimes(reads);
  });

  it("keeps manual entry available for an invalid discovery response", async () => {
    mocks.discover.mockResolvedValue({ hosts: [{}], files: [], incomplete: false });
    view(); await openDirectory();
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Connect to remote nanobot…" }));
    expect(screen.getByRole("textbox", { name: "SSH address" })).toBeVisible();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("keeps manual setup available when discovery fails and does not clear cached hosts", async () => {
    mocks.discover.mockResolvedValue({ hosts: [{ host: "team", source: "/config", ssh_config: "/config" }], files: ["/config"], incomplete: false });
    view(); await openDirectory();
    await screen.findByRole("button", { name: "Use team" });
    mocks.discover.mockRejectedValue(new Error("ssh_config_unreadable"));
    fireEvent.click(screen.getByRole("button", { name: "Refresh SSH hosts" }));
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: "Use team" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Connect to remote nanobot…" }));
    expect(screen.getByRole("textbox", { name: "SSH address" })).toBeVisible();
  });

  it("requires an explicit fingerprint confirmation and never trusts a changed host", async () => {
    mocks.request.mockImplementation(async (action: string) => {
      if (action === "remote.connect") throw new Error("host_key_unknown");
      if (action === "remote.fingerprint") return { fingerprint: "SHA256:example", challenge: "one-use" };
      return {};
    });
    view(); await openDirectory();
    fireEvent.click(screen.getByRole("button", { name: "Team server ubuntu@example.test" }));
    await screen.findByText("SHA256:example");
    expect(mocks.request.mock.calls.some(([action]) => action === "remote.trust")).toBe(false);
    mocks.request.mockImplementation(async (action: string) => action === "remote.connect" ? connection : {});
    fireEvent.click(screen.getByRole("button", { name: "Fingerprint matches · Connect" }));
    await readyRemote();
    expect(mocks.request).toHaveBeenCalledWith("remote.trust", { id: profile.id, challenge: "one-use" }, 65_000);
  });

  it("tolerates transient health failures and covers, rather than reloads, the remote frame", async () => {
    let tick: (() => void) | undefined;
    vi.spyOn(window, "setInterval").mockImplementation((callback, delay) => { if (delay === 5_000) tick = callback as () => void; return 1; });
    view(); await openDirectory();
    fireEvent.click(screen.getByRole("button", { name: "Team server ubuntu@example.test" }));
    const frame = await readyRemote();
    fireEvent.load(frame);
    await act(async () => { tick?.(); });
    expect(screen.queryByText("Server connection lost")).not.toBeInTheDocument();
    await act(async () => { tick?.(); });
    await screen.findByText("Server connection lost");
    expect(screen.getByTitle("nanobot on Team server")).toBeInTheDocument();
    expect(frame.parentElement).toHaveAttribute("inert");
    expect(document.querySelector('[data-host-view="local"]')).toHaveAttribute("inert");
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(screen.queryByText("Server connection lost")).not.toBeInTheDocument());
    expect(screen.queryByText("Opening your server…")).not.toBeInTheDocument();
    expect(screen.getByTitle("nanobot on Team server")).toBe(frame);
    expect(frame.parentElement).not.toHaveAttribute("inert");
  });
});

it.each(["https://evil.example/", "http://user@127.0.0.1:23456/", "javascript:alert(1)", "http://127.0.0.1:23456/wrong"])("rejects unsafe navigation %s", (url) => {
  expect(() => validateRemoteConnection({ ...connection, url })).toThrow();
});
