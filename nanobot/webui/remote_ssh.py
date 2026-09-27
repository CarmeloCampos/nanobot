"""SSH-only access to an existing nanobot. Never installs or starts a remote process.

The system SSH client owns key/agent authentication and host verification. Probe
output is private: only the WebUI credential is read, never provider credentials.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import shlex
import shutil
import socket
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RemoteError(Exception):
    """A stable, non-secret error code for the connection UI."""


class RemoteProfile(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    name: str = Field(min_length=1, max_length=64)
    host: str = Field(min_length=1, max_length=253, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9._:@-]*$")
    port: int | None = Field(default=None, ge=1, le=65535)
    ssh_config: str = Field(default="", max_length=2048)
    identity_file: str = Field(default="", max_length=2048)
    config_path: str = Field(default="~/.nanobot/config.json", min_length=1, max_length=2048)
    runtime_user: str = Field(default="", max_length=64, pattern=r"^([a-zA-Z_][a-zA-Z0-9_-]*)?$")

    @field_validator("ssh_config", "identity_file", "config_path")
    @classmethod
    def safe_path(cls, value: str) -> str:
        if any(ord(char) < 32 for char in value):
            raise ValueError("control characters are not allowed")
        return value


# Fixed program, quoted as one shell argument. No user-supplied shell commands.
_PROBE = r'''
import json, os, pathlib, socket, sys
try:
    path = pathlib.Path(sys.argv[1]).expanduser()
    data = json.loads(path.read_text())
    ws = data.get("channels", {}).get("websocket", {})
    secret = ws.get("tokenIssueSecret") or ws.get("token_issue_secret") or ws.get("token")
    if not ws.get("enabled"):
        raise ValueError("webui_disabled")
    if not isinstance(secret, str) or not secret.strip() or "${" in secret:
        raise ValueError("webui_auth_required")
    if ws.get("publicWsUrl") or ws.get("public_ws_url"):
        raise ValueError("public_ws_unsupported")
    print(json.dumps({"port": ws.get("port", 8765), "secret": secret,
                      "hostname": socket.gethostname(), "config_path": str(path)}))
except FileNotFoundError:
    print(json.dumps({"error": "config_not_found"}))
except PermissionError:
    print(json.dumps({"error": "config_permission"}))
except ValueError as e:
    code = str(e)
    print(json.dumps({"error": code if code in {"webui_disabled", "webui_auth_required", "public_ws_unsupported"} else "config_invalid"}))
'''


def ssh_arguments(profile: RemoteProfile, known_hosts: Path | None = None) -> list[str]:
    executable = shutil.which("ssh")
    if not executable:
        raise RemoteError("ssh_unavailable")
    args = [executable]
    for flag, value in [("-F", profile.ssh_config), ("-i", profile.identity_file)]:
        if value:
            path = Path(value).expanduser()
            if not path.is_file():
                raise RemoteError("local_file_not_found")
            args.extend([flag, str(path)])
    # CLI options override config. Never forward the agent or reuse an unrelated
    # multiplexed session (whose identity/forwarding policy could be different).
    args.extend([
        "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes",
        "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "PermitLocalCommand=no",
        "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=10",
        "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
        "-o", "ExitOnForwardFailure=yes", "-o", "RequestTTY=no",
    ])
    if profile.port is not None:
        args.extend(["-p", str(profile.port)])
    if known_hosts and known_hosts.is_file():
        args.extend(["-o", f"UserKnownHostsFile={known_hosts}", "-o", "GlobalKnownHostsFile=none",
                     "-o", "HostKeyAlias=nanobot-remote", "-o", "HostKeyAlgorithms=ssh-ed25519",
                     "-o", "UpdateHostKeys=no"])
    return args


def ssh_error(stderr: bytes) -> str:
    text = stderr.decode("utf-8", errors="replace").lower()
    if "host identification has changed" in text:
        return "host_key_changed"
    if "host key verification failed" in text or "no ed25519 host key is known" in text:
        return "host_key_unknown"
    if "permission denied" in text:
        return "ssh_auth_failed"
    if "sudo:" in text:
        return "runtime_user_denied"
    if "python3" in text and "not found" in text:
        return "python_unavailable"
    return "ssh_unreachable"


async def stop_process(process: asyncio.subprocess.Process) -> None:
    if process.returncode is None:
        try:
            process.terminate()
        except ProcessLookupError:
            pass
        try:
            await asyncio.wait_for(process.wait(), 3)
        except TimeoutError:
            try:
                process.kill()
            except ProcessLookupError:
                pass
            await process.wait()


async def probe(profile: RemoteProfile, known_hosts: Path | None = None) -> dict[str, Any]:
    remote = ["python3", "-c", _PROBE, profile.config_path]
    if profile.runtime_user:
        remote = ["sudo", "-n", "-H", "-u", profile.runtime_user, "--", *remote]
    process = await asyncio.create_subprocess_exec(
        *ssh_arguments(profile, known_hosts), profile.host, shlex.join(remote),
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), 20)
        if process.returncode:
            raise RemoteError(ssh_error(stderr))
        try:
            raw = json.loads(stdout)
            if not isinstance(raw, dict):
                raise ValueError
            data = cast(dict[str, Any], raw)
            if data.get("error"):
                raise RemoteError(str(data["error"]))
            if not isinstance(data.get("secret"), str) or not data["secret"]:
                raise ValueError
            if type(data.get("port")) is not int or not 1 <= data["port"] <= 65535:
                raise ValueError
            return data
        except (ValueError, TypeError):
            raise RemoteError("config_invalid") from None
    except TimeoutError:
        raise RemoteError("ssh_unreachable") from None
    finally:
        await stop_process(process)


@dataclass
class Tunnel:
    process: asyncio.subprocess.Process
    port: int

    async def close(self) -> None:
        await stop_process(self.process)


async def open_tunnel(
    profile: RemoteProfile, remote_port: int, known_hosts: Path | None = None,
    local_port: int = 0,
) -> Tunnel:
    # Reserve a loopback candidate. SSH remains responsible for binding and
    # ExitOnForwardFailure ensures a collision cannot connect us to another app.
    with socket.socket() as candidate:
        try:
            # Match OpenSSH's listener policy: a just-closed tunnel can leave
            # TIME_WAIT connections without another program owning the port.
            candidate.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            candidate.bind(("127.0.0.1", local_port))
            candidate.listen(1)
        except OSError:
            raise RemoteError("local_port_in_use") from None
        port = int(candidate.getsockname()[1])
    process = await asyncio.create_subprocess_exec(
        *ssh_arguments(profile, known_hosts), "-N", "-L", f"127.0.0.1:{port}:127.0.0.1:{remote_port}",
        profile.host, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    tunnel = Tunnel(process, port)
    try:
        for _ in range(100):
            if process.returncode is not None:
                stderr = await process.stderr.read() if process.stderr else b""
                raise RemoteError(ssh_error(stderr))
            try:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_connection("127.0.0.1", port), 0.2,
                )
                del reader
                writer.close()
                await writer.wait_closed()
                return tunnel
            except (OSError, TimeoutError):
                await asyncio.sleep(0.1)
        raise RemoteError("ssh_unreachable")
    except BaseException:
        await tunnel.close()
        raise


async def scan_host_key(profile: RemoteProfile) -> tuple[str, str]:
    """Return an UNVERIFIED key and fingerprint, never silently trust it.

    Resolve SSH aliases with the user's own config. Scanning is deliberately
    direct; jump-host-only setups should verify via their existing SSH config.
    """
    keyscan = shutil.which("ssh-keyscan")
    if not keyscan:
        raise RemoteError("ssh_unavailable")
    process = await asyncio.create_subprocess_exec(
        *ssh_arguments(profile), "-G", profile.host,
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        output, _ = await asyncio.wait_for(process.communicate(), 10)
        if process.returncode:
            raise RemoteError("ssh_unreachable")
    finally:
        await stop_process(process)
    settings = dict(line.split(" ", 1) for line in output.decode().splitlines() if " " in line)
    hostname, port = settings.get("hostname", ""), settings.get("port", "22")
    if not hostname or hostname.startswith("-") or not port.isdigit():
        raise RemoteError("invalid_profile")
    scan = await asyncio.create_subprocess_exec(
        keyscan, "-T", "5", "-p", port, "-t", "ed25519", hostname,
        stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    try:
        output, _ = await asyncio.wait_for(scan.communicate(), 8)
        for line in output.decode().splitlines():
            fields = line.split()
            if len(fields) != 3 or fields[1] != "ssh-ed25519":
                continue
            try:
                binary = base64.b64decode(fields[2], validate=True)
            except ValueError:
                continue
            fingerprint = "SHA256:" + base64.b64encode(hashlib.sha256(binary).digest()).decode().rstrip("=")
            return f"nanobot-remote ssh-ed25519 {fields[2]}\n", fingerprint
        raise RemoteError("host_key_scan_failed")
    except TimeoutError:
        raise RemoteError("host_key_scan_failed") from None
    finally:
        await stop_process(scan)
