import { useCallback, useEffect, useRef, useState } from "react";
import { useClient } from "@/providers/ClientProvider";
import { readRemoteInstances, readSelectedRemote, rememberSelectedRemote, remoteAction, validateRemoteConnection, type RemoteConnection, type RemoteDirectory, type SelectedRemote } from "@/lib/remote-instances";

// Never silently evict a view containing drafts or unfinished attachments.
// Tunnels are shared across browser tabs, so only explicit disconnect closes one.
export const MAX_HOST_VIEWS = 3;
export interface HostFrame {
  connection: RemoteConnection;
  loaded: boolean;
  offline: boolean;
  failures: number;
}
interface PendingSwitch { id: string; name: string }

export function useHostSessions() {
  const { client, getToken } = useClient();
  const [directory, setDirectory] = useState<RemoteDirectory | null>(null);
  const [directoryError, setDirectoryError] = useState(false);
  const [selected, setSelected] = useState<SelectedRemote | null>(readSelectedRemote);
  const selectedRef = useRef(selected);
  const initial = useRef(selected);
  const cache = useRef(new Map<string, HostFrame>());
  const [frames, setFrames] = useState<HostFrame[]>([]);
  const [pending, setPending] = useState<PendingSwitch | null>(null);
  const pendingRef = useRef<PendingSwitch | null>(null);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const epoch = useRef(0);
  const waiter = useRef<{ id: string; finish: (ready: boolean) => void } | null>(null);
  const publish = useCallback(() => { if (mounted.current) setFrames([...cache.current.values()]); }, []);
  const setPendingSwitch = useCallback((value: PendingSwitch | null) => {
    pendingRef.current = value;
    if (mounted.current) setPending(value);
  }, []);
  const cancel = useCallback(() => {
    epoch.current += 1;
    waiter.current?.finish(false);
    waiter.current = null;
    setPendingSwitch(null);
  }, [setPendingSwitch]);
  const select = useCallback((value: SelectedRemote | null) => {
    selectedRef.current = value;
    setSelected(value);
    rememberSelectedRemote(value);
    setError("");
    publish();
  }, [publish]);
  const local = useCallback(() => { cancel(); select(null); }, [cancel, select]);
  const refresh = useCallback(async () => {
    try {
      const next = window.top === window ? await readRemoteInstances(getToken()) : { available: false, profiles: [] };
      if (mounted.current) { setDirectory(next); setDirectoryError(false); }
      return next;
    } catch (reason) {
      if (mounted.current) setDirectoryError(true);
      throw reason;
    }
  }, [getToken]);

  const connect = useCallback(async (id: string, stillWanted: () => boolean = () => true) => {
    cancel();
    const attempt = epoch.current;
    const wanted = () => mounted.current && attempt === epoch.current && stillWanted();
    const warm = cache.current.get(id);
    if (warm?.loaded && !warm.offline) {
      if (wanted()) select(warm.connection);
      return;
    }
    if (!warm && cache.current.size >= MAX_HOST_VIEWS) throw new Error("view_limit");
    const name = directory?.profiles.find((item) => item.id === id)?.name || initial.current?.name || id;
    setPendingSwitch({ id, name });
    setError("");
    let openingFrame = warm?.loaded ? undefined : warm;
    try {
      const connection = validateRemoteConnection(await remoteAction<RemoteConnection>(client, "connect", { id }));
      if (!wanted()) {
        // A cancelled SSH request can finish later. Never switch away from the
        // latest choice or close its tunnel, which another tab may already use.
        return;
      }
      let frame = cache.current.get(id);
      if (!frame || frame.connection.url !== connection.url || frame.connection.gateway_id !== connection.gateway_id) {
        frame = { connection, loaded: false, offline: false, failures: 0 };
        cache.current.set(id, frame);
      } else {
        frame.connection = connection;
        frame.offline = false; frame.failures = 0;
      }
      if (!frame.loaded) openingFrame = frame;
      publish();
      void refresh().catch(() => {});
      if (!frame.loaded) {
        const ready = await new Promise<boolean>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            waiter.current = null;
            reject(new Error("view_load_failed"));
          }, 25_000);
          waiter.current = { id, finish: (ready) => { window.clearTimeout(timer); resolve(ready); } };
        });
        if (!ready) return;
      }
      if (wanted()) select(connection);
    } catch (reason) {
      if (wanted()) throw reason;
    } finally {
      // Cancelled/failed cold pages contain no user work. Don't let them use up
      // the view budget; a newer attempt for this host owns its transport now.
      if (openingFrame && !openingFrame.loaded && cache.current.get(id) === openingFrame
        && (attempt === epoch.current || pendingRef.current?.id !== id)) {
        cache.current.delete(id);
        publish();
      }
      if (attempt === epoch.current) setPendingSwitch(null);
    }
  }, [cancel, client, directory, publish, refresh, select, setPendingSwitch]);
  const connectRef = useRef(connect);
  connectRef.current = connect;
  const loaded = useCallback((id: string) => {
    const frame = cache.current.get(id);
    if (frame) { frame.loaded = true; publish(); }
    if (waiter.current?.id === id) { waiter.current.finish(true); waiter.current = null; }
  }, [publish]);
  const disconnect = useCallback(async (id: string) => {
    if (pendingRef.current?.id === id) cancel();
    await remoteAction(client, "disconnect", { id });
    if (selectedRef.current?.id === id) local();
    cache.current.delete(id);
    publish();
    await refresh();
  }, [cancel, client, local, publish, refresh]);

  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => {});
    return () => { mounted.current = false; cancel(); };
  }, [cancel, refresh]);
  useEffect(() => {
    const saved = initial.current;
    if (!saved || window.top !== window) return;
    let started = false;
    const timer = window.setTimeout(() => {
      started = true;
      if (selectedRef.current?.id === saved.id) setError("ssh_unreachable");
    }, 15_000);
    const unsubscribe = client.onStatus((status) => {
      if (status !== "open" || started) return;
      started = true;
      window.clearTimeout(timer);
      if (selectedRef.current?.id !== saved.id) return;
      void connectRef.current(saved.id).catch((reason: unknown) => {
        if (mounted.current && selectedRef.current?.id === saved.id) setError(reason instanceof Error ? reason.message : "unknown");
      });
    });
    return () => { window.clearTimeout(timer); unsubscribe(); };
  }, [client]);
  useEffect(() => {
    let checking = false;
    let cancelled = false;
    const tick = async () => {
      if (checking || !cache.current.size) return;
      checking = true;
      try {
        const next = await readRemoteInstances(getToken());
        if (cancelled) return;
        setDirectory(next); setDirectoryError(false);
        for (const [id, frame] of cache.current) {
          if (id === pendingRef.current?.id) continue;
          const connected = next.profiles.some((profile) => profile.id === id && profile.connected);
          frame.failures = connected ? 0 : frame.failures + 1;
          if (connected || frame.failures >= 2) frame.offline = !connected;
        }
      } catch {
        if (!cancelled) for (const frame of cache.current.values()) {
          if (++frame.failures >= 2) frame.offline = true;
        }
      } finally {
        checking = false;
        if (!cancelled) publish();
      }
    };
    const timer = window.setInterval(() => { void tick(); }, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [client, getToken, publish]);
  return { directory, directoryError, refresh, selected, frames, pending, error, setError, connect, cancel, local, disconnect, loaded };
}
