"""Local connection directory. Owns SSH tunnels, never remote gateway lifetimes."""

from __future__ import annotations

import asyncio
import json
import secrets
import socket
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast
from urllib.parse import quote

import httpx
from pydantic import Field

from nanobot.utils.helpers import _write_text_atomic  # pyright: ignore[reportPrivateUsage]
from nanobot.webui import remote_ssh
from nanobot.webui.remote_ssh import RemoteError, RemoteProfile, Tunnel


class _SavedProfile(RemoteProfile):
    # Retain an origin per server so browser preferences/caches cannot drift
    # between servers on every reconnect. Not an editable API field.
    local_port: int = Field(default=0, ge=0, le=65535)


@dataclass
class Connection:
    tunnel: Tunnel
    secret: str
    hostname: str
    config_path: str
    gateway_id: str
    error: str = ""


class RemoteInstances:
    """List/save/connect/disconnect with credentials confined to live connections."""

    def __init__(self, directory: Path, *, local_gateway_id: str = "") -> None:
        self.path = directory / "remote-instances.json"
        self.local_gateway_id = local_gateway_id
        self.connections: dict[str, Connection] = {}
        self._lock = asyncio.Lock()
        self._unverified: dict[str, tuple[str, str, float]] = {}
        self._unknown_hosts: set[str] = set()
        self._closed = False

    def _known_hosts(self, key: str) -> Path:
        return self.path.parent / "remote-hosts" / key

    def resume(self) -> None:
        """Allow a reused local channel to start again after its stop completed."""
        self._closed = False

    def _read(self) -> dict[str, _SavedProfile]:
        if not self.path.exists():
            return {}
        try:
            raw = json.loads(self.path.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError
            return {str(uuid.UUID(key)): _SavedProfile.model_validate(value)
                    for key, value in cast(dict[str, Any], raw).items()}
        except (ValueError, TypeError, OSError):
            raise RemoteError("profile_store_invalid") from None

    def _write(self, profiles: dict[str, _SavedProfile]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        _write_text_atomic(self.path, json.dumps(
            {key: profile.model_dump() for key, profile in profiles.items()}, ensure_ascii=False,
        ))
        self.path.chmod(0o600)

    def snapshot(self) -> dict[str, Any]:
        return {"available": True, "machine_name": socket.gethostname(), "profiles": [
            {"id": key, **profile.model_dump(exclude={"local_port"}),
             "connected": key in self.connections
             and self.connections[key].tunnel.process.returncode is None
             and not self.connections[key].error}
            for key, profile in self._read().items()
        ]}

    async def health(self) -> dict[str, Any]:
        async def check(connection: Connection) -> None:
            if connection.tunnel.process.returncode is not None:
                connection.error = "ssh_unreachable"
                return
            try:
                async with httpx.AsyncClient(timeout=8, trust_env=False) as client:
                    response = await client.get(
                        f"http://127.0.0.1:{connection.tunnel.port}/webui/terminal",
                        headers={"X-Nanobot-Auth": connection.secret},
                    )
                if response.status_code != 200:
                    connection.error = "remote_unreachable"
                elif response.json().get("gatewayId") != connection.gateway_id:
                    connection.error = "instance_changed"
                else:
                    connection.error = ""
            except (httpx.HTTPError, ValueError, AttributeError):
                connection.error = "remote_unreachable"

        await asyncio.gather(*(check(item) for item in tuple(self.connections.values())))
        return self.snapshot()

    async def action(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        if action == "discover":
            from nanobot.webui.ssh_config import discover_hosts

            config_file = payload.get("ssh_config", "")
            if not isinstance(config_file, str):
                raise RemoteError("invalid_profile")
            discovery = await asyncio.to_thread(discover_hosts, config_file)
            return dict(discovery)
        async with self._lock:
            if self._closed:
                raise RemoteError("local_io_error")
            profiles = self._read()
            key = str(payload.get("id", ""))
            if action == "save":
                profile = RemoteProfile.model_validate(payload.get("profile"))
                if key and key not in profiles:
                    raise RemoteError("profile_not_found")
                if not key and len(profiles) >= 20:
                    raise RemoteError("profile_limit")
                key = key or str(uuid.uuid4())
                if key in self.connections:
                    raise RemoteError("disconnect_before_edit")
                target_changed = key in profiles and any(
                    getattr(profiles[key], field) != getattr(profile, field)
                    for field in ("host", "port", "ssh_config")
                )
                if target_changed:
                    self._known_hosts(key).unlink(missing_ok=True)
                    self._unverified.pop(key, None)
                    self._unknown_hosts.discard(key)
                local_port = profiles[key].local_port if key in profiles and not target_changed else 0
                profiles[key] = _SavedProfile(**profile.model_dump(), local_port=local_port)
                self._write(profiles)
                return {"id": key, **self.snapshot()}
            if key not in profiles:
                raise RemoteError("profile_not_found")
            if action == "connect":
                try:
                    return await self._connect(key, profiles[key])
                except RemoteError as exc:
                    if str(exc) == "host_key_unknown":
                        self._unknown_hosts.add(key)
                    else:
                        self._unknown_hosts.discard(key)
                    raise
            if action == "fingerprint":
                if key not in self._unknown_hosts or self._known_hosts(key).exists():
                    raise RemoteError("host_key_changed")
                known_host, fingerprint = await remote_ssh.scan_host_key(profiles[key])
                challenge = secrets.token_urlsafe(24)
                self._unverified[key] = (challenge, known_host, time.monotonic() + 300)
                return {"fingerprint": fingerprint, "challenge": challenge}
            if action == "trust":
                pending = self._unverified.pop(key, None)
                if (not pending or pending[2] < time.monotonic()
                        or not secrets.compare_digest(pending[0], str(payload.get("challenge", "")))
                        or key not in self._unknown_hosts or self._known_hosts(key).exists()):
                    raise RemoteError("host_key_changed")
                path = self._known_hosts(key)
                path.parent.mkdir(parents=True, exist_ok=True)
                _write_text_atomic(path, pending[1])
                path.chmod(0o600)
                self._unknown_hosts.discard(key)
                return {"trusted": True}
            if action in {"disconnect", "remove"}:
                connection = self.connections.pop(key, None)
                if connection:
                    await connection.tunnel.close()
                if action == "remove":
                    del profiles[key]
                    self._write(profiles)
                    self._known_hosts(key).unlink(missing_ok=True)
                    self._unknown_hosts.discard(key)
                    self._unverified.pop(key, None)
                return self.snapshot()
            raise RemoteError("unknown_action")

    def _launch(self, key: str, profile: RemoteProfile, connection: Connection) -> dict[str, Any]:
        return {"id": key, "name": profile.name, "host": profile.host,
                "hostname": connection.hostname, "config_path": connection.config_path,
                "url": f"http://127.0.0.1:{connection.tunnel.port}/#/?bootstrapSecret={quote(connection.secret, safe='')}",
                "gateway_id": connection.gateway_id}

    async def _connect(self, key: str, profile: _SavedProfile) -> dict[str, Any]:
        existing = self.connections.get(key)
        if existing:
            await self.health()
            if not existing.error:
                return self._launch(key, profile, existing)
            await existing.tunnel.close()
            del self.connections[key]
        if len(self.connections) >= 4:
            raise RemoteError("connection_limit")
        known_hosts = self._known_hosts(key)
        data = await remote_ssh.probe(profile, known_hosts)
        tunnel = await remote_ssh.open_tunnel(profile, data["port"], known_hosts, profile.local_port)
        base = f"http://127.0.0.1:{tunnel.port}"
        try:
            async with httpx.AsyncClient(timeout=8, trust_env=False, follow_redirects=False) as client:
                response = await client.get(
                    f"{base}/webui/terminal", headers={"X-Nanobot-Auth": data["secret"]},
                )
                if response.status_code in {401, 403}:
                    raise RemoteError("remote_auth_failed")
                if response.status_code != 200:
                    raise RemoteError("incompatible_gateway")
                raw_identity = response.json()
                if not isinstance(raw_identity, dict):
                    raise RemoteError("incompatible_gateway")
                identity = cast(dict[str, Any], raw_identity)
                if (identity.get("protocolVersion") != 1
                        or not isinstance(identity.get("gatewayId"), str)):
                    raise RemoteError("incompatible_gateway")
                if identity["gatewayId"] == self.local_gateway_id:
                    raise RemoteError("same_instance")
                # Require the installed WebUI too, not just a port answering HTTP.
                page = await client.get(base + "/")
                if page.status_code != 200 or "text/html" not in page.headers.get("content-type", ""):
                    raise RemoteError("webui_unavailable")
            connection = Connection(
                tunnel, data["secret"], str(data.get("hostname", profile.host)),
                str(data.get("config_path", profile.config_path)), identity["gatewayId"],
            )
            profiles = self._read()
            profiles[key].local_port = tunnel.port
            self._write(profiles)
            self.connections[key] = connection
            return self._launch(key, profile, connection)
        except BaseException as exc:
            await tunnel.close()
            if isinstance(exc, httpx.HTTPError):
                raise RemoteError("remote_unreachable") from None
            if isinstance(exc, ValueError):
                raise RemoteError("incompatible_gateway") from None
            raise

    async def close(self) -> None:
        self._closed = True
        async with self._lock:
            connections, self.connections = self.connections, {}
            await asyncio.gather(*(item.tunnel.close() for item in connections.values()))
