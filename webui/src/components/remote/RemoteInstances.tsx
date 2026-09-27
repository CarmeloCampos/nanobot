import { createContext, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Loader2, PlugZap } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import type { RemoteDirectory } from "@/lib/remote-instances";
import { useHostSessions } from "./useHostSessions";
import { HostNavigationContext, HostSwitcher, RemoteHostMenu, type HostPicker } from "./HostSwitcher";
import { useSidebarHostBridge } from "./useSidebarHostBridge";

const RemoteContext = createContext<{
  available: boolean;
  localActive: boolean;
  openHostIds: string[];
  directory: RemoteDirectory | null;
  directoryError: boolean;
  refresh: () => Promise<RemoteDirectory>;
  connect: (id: string, stillWanted?: () => boolean) => Promise<void>;
  disconnect: (id: string) => Promise<void>;
} | null>(null);
export function useRemoteConnections() { return useContext(RemoteContext); }

/** Keep host views alive; navigation belongs in each view's sidebar, not a second header. */
export function RemoteInstances({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const hosts = useHostSessions();
  const { selected, pending, frames, directory, error } = hosts;
  const localPanel = useRef<HTMLDivElement>(null);
  const lastLocalFocus = useRef<HTMLElement | null>(null);
  const frameNodes = useRef(new Map<string, HTMLIFrameElement>());
  const activeHostId = useRef(selected?.id);
  activeHostId.current = selected?.id;
  const restoreLocalFocus = () => {
    if (lastLocalFocus.current?.isConnected) lastLocalFocus.current.focus({ preventScroll: true });
  };
  const message = error ? t(`remote.errors.${error}`, { defaultValue: t("remote.errors.unknown") }) : "";
  const bridge = useSidebarHostBridge(frames, selected?.id, frameNodes, restoreLocalFocus, { pendingName: pending?.name, error: message });
  const restoreFocus = () => {
    if (activeHostId.current) bridge.focus(activeHostId.current);
    else restoreLocalFocus();
  };
  const available = directory?.available === true || hosts.directoryError;
  const activeFrame = frames.find((frame) => frame.connection.id === selected?.id);
  const offline = !!selected && (activeFrame?.offline || (!activeFrame && !pending && !!error));
  const switchHost = (id: string) => {
    void hosts.connect(id).catch((reason: unknown) => hosts.setError(reason instanceof Error ? reason.message : "unknown"));
  };
  const picker: HostPicker = {
    kind: "shell", name: selected?.name || t("remote.localShort"), hostname: selected?.hostname || directory?.machine_name || "nanobot",
    localName: directory?.machine_name || "nanobot", currentId: selected?.id || null,
    profiles: (directory?.profiles || []).map(({ id, name, host }) => ({ id, name, host,
      ready: frames.some((frame) => frame.connection.id === id && !frame.offline && frame.loaded) })),
    pending, error: message, offline: !!offline, select: (id) => { if (id) switchHost(id); else hosts.local(); },
    manage: () => { hosts.local(); window.location.hash = "/remote"; },
    cancel: hosts.cancel, clearError: () => hosts.setError(""), restoreFocus,
  };
  useEffect(() => { if (selected) document.title = `${selected.name} · nanobot`; }, [selected]);
  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && localPanel.current?.contains(event.target)
        && !event.target.closest("[data-host-switcher]")) lastLocalFocus.current = event.target;
    };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, []);
  useLayoutEffect(() => {
    if (selected) frameNodes.current.get(selected.id)?.focus({ preventScroll: true });
    else restoreLocalFocus();
  }, [selected]);
  useEffect(() => {
    if (!selected) return;
    const stop = (event: KeyboardEvent) => event.stopPropagation();
    document.addEventListener("keydown", stop);
    document.addEventListener("keyup", stop);
    return () => { document.removeEventListener("keydown", stop); document.removeEventListener("keyup", stop); };
  }, [selected]);

  return <RemoteContext.Provider value={{ available, localActive: !selected, directory,
    openHostIds: frames.map((frame) => frame.connection.id),
    directoryError: hosts.directoryError, refresh: hosts.refresh, connect: hosts.connect, disconnect: hosts.disconnect }}>
    <HostNavigationContext.Provider value={bridge.embedded || (available || selected ? picker : null)}>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <div ref={localPanel} data-host-view="local" aria-hidden={!!selected} {...(selected ? { inert: "" } : {})}
            style={{ visibility: selected ? "hidden" : "visible" }}
            className={`absolute inset-0 transition-opacity duration-150 motion-reduce:transition-none ${selected ? "invisible pointer-events-none opacity-0" : "visible opacity-100"}`}>
            {children}
          </div>
          {frames.map((frame) => {
            const active = selected?.id === frame.connection.id;
            return <div key={`${frame.connection.id}:${frame.connection.gateway_id}`} data-host-view={frame.connection.id} aria-hidden={!active || offline}
              {...(!active || offline ? { inert: "" } : {})} style={{ visibility: active ? "visible" : "hidden" }}
              className={`absolute inset-0 transition-opacity duration-150 motion-reduce:transition-none ${active ? "visible opacity-100" : "invisible pointer-events-none opacity-0"}`}>
              <iframe ref={(node) => { if (node) frameNodes.current.set(frame.connection.id, node); else frameNodes.current.delete(frame.connection.id); }}
                src={frame.connection.url} title={t("remote.frameTitle", { name: frame.connection.name })}
                className="h-full w-full border-0" referrerPolicy="no-referrer"
                sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups allow-popups-to-escape-sandbox"
                onLoad={() => { bridge.initialize(frame.connection.id); hosts.loaded(frame.connection.id); }} />
            </div>;
          })}
          {selected && (offline || !activeFrame?.loaded) && <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background px-6 text-center">
            {offline ? <PlugZap className="h-7 w-7 text-muted-foreground" /> : <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />}
            <p className="font-medium">{t(offline ? "remote.offline" : "remote.opening")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">{message || t("remote.noFallback")}</p>
            <div className="flex items-center gap-2">
              {offline && <Button disabled={!!pending} onClick={() => switchHost(selected.id)}>{t("remote.reconnect")}</Button>}
              <Button variant="ghost" onClick={hosts.local}>{t("remote.returnLocal")}</Button>
            </div>
          </div>}
        </div>
        {/* Older remote bundles cannot host the control. Keep an explicit exit
            in a compact bottom strip, never cover their sidebar controls. */}
        {selected && (!bridge.readyIds.includes(selected.id) || offline) && <div data-testid="legacy-host-footer" className="flex shrink-0 items-center border-t border-border/50 bg-sidebar px-2.5 py-1">
          <div className="flex w-52 min-w-0"><HostSwitcher /></div>
        </div>}
        <RemoteHostMenu picker={picker} anchor={bridge.anchor} onClose={bridge.close} />
      </div>
    </HostNavigationContext.Provider>
  </RemoteContext.Provider>;
}
