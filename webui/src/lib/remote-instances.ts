import type { WebUIMutationTransport } from "./api";
import { fetchWithTimeout } from "./http";

export interface RemoteProfile {
  id: string;
  name: string;
  host: string;
  port: number | null;
  ssh_config: string;
  identity_file: string;
  config_path: string;
  runtime_user: string;
  connected: boolean;
}

export interface RemoteDirectory {
  available: boolean;
  machine_name?: string;
  profiles: RemoteProfile[];
}

export interface SSHDiscovery {
  hosts: { host: string; source: string; ssh_config: string }[];
  files: string[];
  incomplete: boolean;
}

export interface RemoteConnection {
  id: string;
  name: string;
  host: string;
  hostname: string;
  config_path: string;
  gateway_id: string;
  url: string;
}

export async function readRemoteInstances(token: string): Promise<RemoteDirectory> {
  const response = await fetchWithTimeout("/api/remote-instances", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 403 || response.status === 404) return { available: false, profiles: [] };
  if (!response.ok) throw new Error("directory_unavailable");
  return response.json() as Promise<RemoteDirectory>;
}

export function remoteAction<T>(
  client: WebUIMutationTransport, action: string, payload: Record<string, unknown>,
): Promise<T> {
  return client.requestMutation<T>(`remote.${action}`, payload, 65_000);
}

/** Never let a server response navigate the shell to an arbitrary origin. */
export function validateRemoteConnection(connection: RemoteConnection): RemoteConnection {
  const url = new URL(connection.url);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.username || url.password || url.pathname !== "/") {
    throw new Error("invalid_remote_url");
  }
  return connection;
}

export type SelectedRemote = Pick<RemoteConnection, "id" | "name" | "hostname">;
const SELECTED_REMOTE = "nanobot.remote-instance";

export function readSelectedRemote(): SelectedRemote | null {
  try {
    // A remote WebUI embedded by another nanobot must not inherit a local host's selector.
    if (window.top !== window) return null;
    const value = JSON.parse(window.sessionStorage.getItem(SELECTED_REMOTE) || "null") as SelectedRemote | null;
    return value && /^[a-f0-9-]{36}$/.test(value.id) && typeof value.name === "string"
      && typeof value.hostname === "string" ? value : null;
  } catch { return null; }
}

export function rememberSelectedRemote(value: SelectedRemote | null): void {
  try {
    if (value) window.sessionStorage.setItem(SELECTED_REMOTE, JSON.stringify({ id: value.id, name: value.name, hostname: value.hostname }));
    else window.sessionStorage.removeItem(SELECTED_REMOTE);
  } catch { /* Storage can be disabled; the live connection still works. */ }
}
