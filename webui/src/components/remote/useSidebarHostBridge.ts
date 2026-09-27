import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { HOST_BRIDGE, bridgeMessage, isLocalShellOrigin, readEmbeddedHost, readHostAnchor, type EmbeddedHost, type HostAnchor } from "./host-bridge";
import type { HostFrame } from "./useHostSessions";

interface Peer { source: Window; origin: string; nonce: string }
export function useSidebarHostBridge(frames: HostFrame[], selectedId: string | undefined,
  nodes: RefObject<Map<string, HTMLIFrameElement>>, restoreLocalFocus: () => void,
  activity: { pendingName?: string; error?: string }) {
  const [embedded, setEmbedded] = useState<EmbeddedHost | null>(null);
  const [readyIds, setReadyIds] = useState<string[]>([]);
  const [anchor, setAnchor] = useState<HostAnchor | null>(null);
  const parent = useRef<Peer | null>(null);
  const peers = useRef(new Map<string, Peer>());
  const latest = useRef({ frames, selectedId, restoreLocalFocus, activity });
  latest.current = { frames, selectedId, restoreLocalFocus, activity };
  const initialize = useCallback((id: string) => {
    const frame = latest.current.frames.find((item) => item.connection.id === id);
    const source = nodes.current?.get(id)?.contentWindow;
    if (!frame || !source) return;
    const origin = new URL(frame.connection.url).origin;
    let peer = peers.current.get(id);
    if (!peer || peer.source !== source || peer.origin !== origin) {
      peer = { source, origin, nonce: crypto.randomUUID() };
      peers.current.set(id, peer);
      setReadyIds((ids) => ids.filter((value) => value !== id));
    }
    // Deliberately only public display identity, never SSH metadata or secrets.
    source.postMessage({ channel: HOST_BRIDGE, type: "init", nonce: peer.nonce,
      name: frame.connection.name, hostname: frame.connection.hostname,
      ...(latest.current.selectedId === id ? latest.current.activity : {}) }, origin);
  }, [nodes]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      const message = bridgeMessage(event.data);
      if (!message) return;
      if (window.parent !== window) {
        if (event.source !== window.parent || !isLocalShellOrigin(event.origin)) return;
        const current = parent.current;
        if (current && (current.origin !== event.origin || current.nonce !== message.nonce)) return;
        if (message.type === "init") {
          const host = readEmbeddedHost(message);
          if (!host || typeof message.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(message.nonce)) return;
          parent.current = { source: window.parent, origin: event.origin, nonce: message.nonce };
          setEmbedded(host);
          window.parent.postMessage({ channel: HOST_BRIDGE, type: "ready", nonce: message.nonce }, event.origin);
        } else if (message.type === "focus" && current) latest.current.restoreLocalFocus();
        return;
      }
      // Both source and origin must match a frame this shell actually owns.
      const frame = latest.current.frames.find((item) => nodes.current?.get(item.connection.id)?.contentWindow === event.source
        && new URL(item.connection.url).origin === event.origin);
      if (!frame) return;
      const id = frame.connection.id;
      if (message.type === "hello") { initialize(id); return; }
      const peer = peers.current.get(id);
      if (!peer || message.nonce !== peer.nonce) return;
      if (message.type === "ready") {
        setReadyIds((ids) => ids.includes(id) ? ids : [...ids, id]);
      } else if (message.type === "open" && latest.current.selectedId === id && !frame.offline) {
        const rect = readHostAnchor(message.anchor);
        const outer = nodes.current?.get(id)?.getBoundingClientRect();
        if (rect && outer) setAnchor({ ...rect, left: outer.left + rect.left, top: outer.top + rect.top });
      }
      // No select/connect/disconnect action is accepted from an embedded page.
    };
    window.addEventListener("message", receive);
    // A public capability probe carries no identity, settings or credentials.
    if (window.parent !== window) window.parent.postMessage({ channel: HOST_BRIDGE, type: "hello" }, "*");
    return () => window.removeEventListener("message", receive);
  }, [initialize, nodes]);
  useEffect(() => { setAnchor(null); }, [selectedId]);
  useEffect(() => {
    if (selectedId && peers.current.has(selectedId)) initialize(selectedId);
  }, [initialize, selectedId, activity.pendingName, activity.error]);
  useEffect(() => {
    for (const id of peers.current.keys()) if (!frames.some((frame) => frame.connection.id === id)) peers.current.delete(id);
  }, [frames]);
  const focus = (id: string) => {
    const peer = peers.current.get(id);
    if (peer && readyIds.includes(id)) peer.source.postMessage({ channel: HOST_BRIDGE, type: "focus", nonce: peer.nonce }, peer.origin);
    else nodes.current?.get(id)?.focus({ preventScroll: true });
  };
  return { anchor, close: () => setAnchor(null), readyIds, initialize, focus,
    embedded: embedded ? { ...embedded, kind: "embedded" as const, open: (position: HostAnchor) => {
      const peer = parent.current;
      peer?.source.postMessage({ channel: HOST_BRIDGE, type: "open", nonce: peer.nonce, anchor: position }, peer.origin);
    } } : null };
}
