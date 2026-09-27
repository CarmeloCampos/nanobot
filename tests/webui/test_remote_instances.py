"""Connection boundaries: no deployment, copied model keys or remote shutdown."""

import asyncio
import json
import socket
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from pydantic import ValidationError
from websockets.datastructures import Headers
from websockets.http11 import Request

from nanobot.channels.websocket.runtime import WebSocketConfig
from nanobot.webui import remote_ssh
from nanobot.webui.gateway_services import build_gateway_services
from nanobot.webui.remote_instances import RemoteInstances
from nanobot.webui.remote_ssh import RemoteError, RemoteProfile, ssh_arguments, ssh_error


@pytest.fixture
def manager(tmp_path):
    return RemoteInstances(tmp_path)


async def save(manager, **values):
    result = await manager.action("save", {"profile": {"name": "Team", "host": "ubuntu@example.test", **values}})
    return result["id"]


@pytest.fixture
def ssh(monkeypatch):
    process = SimpleNamespace(returncode=None)
    tunnel = SimpleNamespace(process=process, port=23456, close=AsyncMock())
    probe = AsyncMock(return_value={"port": 8765, "secret": "private-webui-secret", "hostname": "team-host"})
    monkeypatch.setattr(remote_ssh, "probe", probe)
    monkeypatch.setattr(remote_ssh, "open_tunnel", AsyncMock(return_value=tunnel))
    state = {"status": 200, "identity": {"protocolVersion": 1, "gatewayId": "remote-one"}}

    def respond(request):
        if request.url.path == "/webui/terminal":
            assert request.headers["X-Nanobot-Auth"] == "private-webui-secret"
            return httpx.Response(state["status"], json=state["identity"])
        return httpx.Response(200, text="<!doctype html><title>nanobot</title>", headers={"content-type": "text/html"})

    real_client = httpx.AsyncClient
    monkeypatch.setattr(httpx, "AsyncClient", lambda **kwargs: real_client(transport=httpx.MockTransport(respond), **kwargs))
    return SimpleNamespace(tunnel=tunnel, probe=probe, state=state)


async def test_save_survives_restart_without_credentials(manager):
    key = await save(manager)
    assert RemoteInstances(manager.path.parent).snapshot()["profiles"][0]["id"] == key
    assert "secret" not in manager.path.read_text()
    with pytest.raises(ValidationError):
        await save(manager, private_key="must-never-save")


@pytest.mark.parametrize("host", ["-oProxyCommand=evil", "user@host;whoami", "a\nb", "$(id)", "host name"])
def test_hosts_cannot_be_shell_or_ssh_options(host):
    with pytest.raises(ValidationError):
        RemoteProfile(name="Team", host=host)


def test_strict_ssh_without_agent_forwarding(monkeypatch):
    monkeypatch.setattr(remote_ssh.shutil, "which", lambda _: "/usr/bin/ssh")
    args = ssh_arguments(RemoteProfile(name="Team", host="my-alias"))
    for option in ["StrictHostKeyChecking=yes", "BatchMode=yes", "ForwardAgent=no", "ControlPath=none", "PermitLocalCommand=no", "ExitOnForwardFailure=yes"]:
        assert option in args
    assert "StrictHostKeyChecking=no" not in args


async def test_connect_checks_protocol_and_only_disconnects_tunnel(manager, ssh):
    key = await save(manager)
    connection = await manager.action("connect", {"id": key})
    assert connection["hostname"] == "team-host"
    assert connection["gateway_id"] == "remote-one"
    assert connection["url"].startswith("http://127.0.0.1:23456/#/?bootstrapSecret=")
    assert "private-webui-secret" not in json.dumps(manager.snapshot())
    assert "private-webui-secret" not in manager.path.read_text()
    await manager.action("disconnect", {"id": key})
    ssh.tunnel.close.assert_awaited_once()
    assert not manager.snapshot()["profiles"][0]["connected"]
    assert len(manager.snapshot()["profiles"]) == 1


@pytest.mark.parametrize(("status", "identity", "error"), [
    (401, {}, "remote_auth_failed"), (404, {}, "incompatible_gateway"),
    (200, {"protocolVersion": 2, "gatewayId": "other"}, "incompatible_gateway"),
    (200, {"protocolVersion": 1}, "incompatible_gateway"),
])
async def test_bad_target_closes_tunnel_and_never_returns_launch_url(manager, ssh, status, identity, error):
    key = await save(manager)
    ssh.state.update(status=status, identity=identity)
    with pytest.raises(RemoteError, match=error):
        await manager.action("connect", {"id": key})
    ssh.tunnel.close.assert_awaited_once()
    assert not manager.connections


async def test_server_restart_requires_reconnect_not_local_fallback(manager, ssh):
    key = await save(manager)
    await manager.action("connect", {"id": key})
    ssh.state["identity"]["gatewayId"] = "restarted"
    assert not (await manager.health())["profiles"][0]["connected"]
    assert key in manager.connections
    ssh.tunnel.close.assert_not_awaited()


async def test_connect_to_own_gateway_is_rejected_without_nesting(manager, ssh):
    manager.local_gateway_id = "remote-one"
    key = await save(manager)
    with pytest.raises(RemoteError, match="same_instance"):
        await manager.action("connect", {"id": key})
    ssh.tunnel.close.assert_awaited_once()
    assert not manager.connections


async def test_forget_only_removes_saved_profile(manager, ssh):
    key = await save(manager)
    await manager.action("connect", {"id": key})
    await manager.action("remove", {"id": key})
    assert manager.snapshot()["profiles"] == []
    ssh.tunnel.close.assert_awaited_once()


async def test_closing_local_manager_reaps_ssh(manager, ssh):
    key = await save(manager)
    await manager.action("connect", {"id": key})
    await manager.close()
    ssh.tunnel.close.assert_awaited_once()
    assert len(manager.snapshot()["profiles"]) == 1


async def test_refresh_reuses_a_healthy_tunnel(manager, ssh):
    key = await save(manager)
    first = await manager.action("connect", {"id": key})
    second = await manager.action("connect", {"id": key})
    assert first["url"] == second["url"]
    ssh.probe.assert_awaited_once()
    ssh.tunnel.close.assert_not_awaited()


async def test_reconnect_keeps_origin_and_changing_target_does_not(manager, ssh):
    key = await save(manager)
    await manager.action("connect", {"id": key})
    assert json.loads(manager.path.read_text())[key]["local_port"] == 23456
    await manager.action("disconnect", {"id": key})
    await manager.action("save", {"id": key, "profile": {"name": "Renamed", "host": "ubuntu@example.test"}})
    assert json.loads(manager.path.read_text())[key]["local_port"] == 23456
    await manager.action("save", {"id": key, "profile": {"name": "Other", "host": "other.example.test"}})
    assert json.loads(manager.path.read_text())[key]["local_port"] == 0


async def test_corrupt_store_not_overwritten(manager):
    manager.path.write_text("corrupt")
    with pytest.raises(RemoteError, match="profile_store_invalid"):
        await save(manager)
    assert manager.path.read_text() == "corrupt"


async def test_new_host_trust_is_explicit_scoped_and_one_use(manager, ssh, monkeypatch):
    key = await save(manager)
    ssh.probe.side_effect = RemoteError("host_key_unknown")
    with pytest.raises(RemoteError):
        await manager.action("connect", {"id": key})
    monkeypatch.setattr(remote_ssh, "scan_host_key", AsyncMock(return_value=("nanobot-remote ssh-ed25519 test-key\n", "SHA256:test")))
    result = await manager.action("fingerprint", {"id": key})
    assert result["fingerprint"] == "SHA256:test"
    assert not list(manager.path.parent.glob("remote-hosts/*"))
    await manager.action("trust", {"id": key, "challenge": result["challenge"]})
    assert (manager.path.parent / "remote-hosts" / key).read_text() == "nanobot-remote ssh-ed25519 test-key\n"
    with pytest.raises(RemoteError, match="host_key_changed"):
        await manager.action("trust", {"id": key, "challenge": result["challenge"]})
    with pytest.raises(RemoteError, match="host_key_changed"):
        await manager.action("fingerprint", {"id": key})


async def test_changed_known_host_cannot_be_overridden_in_ui(manager, ssh):
    key = await save(manager)
    ssh.probe.side_effect = RemoteError("host_key_changed")
    with pytest.raises(RemoteError, match="host_key_changed"):
        await manager.action("connect", {"id": key})
    with pytest.raises(RemoteError, match="host_key_changed"):
        await manager.action("fingerprint", {"id": key})


async def test_shutdown_prevents_new_tunnels(manager, ssh):
    key = await save(manager)
    await manager.close()
    with pytest.raises(RemoteError, match="local_io_error"):
        await manager.action("connect", {"id": key})
    ssh.probe.assert_not_awaited()


@pytest.mark.parametrize(("stderr", "code"), [
    (b"WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED", "host_key_changed"),
    (b"Host key verification failed", "host_key_unknown"),
    (b"Permission denied (publickey). secret-information", "ssh_auth_failed"),
    (b"timed out with private address", "ssh_unreachable"),
])
def test_errors_never_echo_raw_ssh_output(stderr, code):
    assert ssh_error(stderr) == code


@pytest.fixture
def gateway(tmp_path):
    return build_gateway_services(
        config=WebSocketConfig(host="127.0.0.1"), bus=MagicMock(), session_manager=None,
        static_dist_path=None, workspace_path=tmp_path, config_path=tmp_path / "config.json",
        default_restrict_to_workspace=False, runtime_model_name=None,
        runtime_surface="browser", runtime_capabilities_overrides=None,
    )


@pytest.mark.parametrize("action", ["save", "discover", "connect", "remove", "trust"])
async def test_http_mutations_are_not_gettable_even_with_token(gateway, action):
    request = Request(f"/api/remote-instances/{action}", Headers())
    connection = SimpleNamespace(remote_address=("127.0.0.1", 10000))
    result = await gateway.http.dispatch(connection, request)
    assert result.status_code == 405


@pytest.mark.parametrize(("peer", "host", "origin", "status"), [
    ("127.0.0.1", "127.0.0.1:8765", "http://127.0.0.1:8765", 200),
    ("203.0.113.1", "127.0.0.1:8765", "http://127.0.0.1:8765", 403),
    ("127.0.0.1", "bot.example.com", "https://bot.example.com", 403),
    ("127.0.0.1", "127.0.0.1:8765", "https://evil.example", 403),
])
async def test_ssh_access_is_local_and_authenticated(gateway, peer, host, origin, status):
    token = gateway.tokens.issue_api_token(60)
    connection = SimpleNamespace(remote_address=(peer, 10000))
    request = Request("/api/remote-instances", Headers({"Host": host, "Origin": origin, "Authorization": f"Bearer {token}"}))
    result = await gateway.http.dispatch(connection, request)
    assert result.status_code == status
    request = Request("/api/remote-instances", Headers({"Host": host}))
    assert (await gateway.http.dispatch(connection, request)).status_code == 401


async def test_cancellation_reaps_inflight_probe(monkeypatch):
    process = MagicMock(returncode=None)
    process.communicate = AsyncMock(side_effect=asyncio.CancelledError)
    process.wait = AsyncMock(return_value=0)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    with pytest.raises(asyncio.CancelledError):
        await remote_ssh.probe(RemoteProfile(name="Test", host="example.test"))
    process.terminate.assert_called_once()


async def test_tunnel_refuses_an_existing_listener(monkeypatch):
    spawn = AsyncMock()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", spawn)
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        with pytest.raises(RemoteError, match="local_port_in_use"):
            await remote_ssh.open_tunnel(
                RemoteProfile(name="Test", host="example.test"), 8765,
                local_port=listener.getsockname()[1],
            )
    spawn.assert_not_awaited()


async def test_tunnel_reuses_closed_port_with_time_wait(monkeypatch):
    with socket.socket() as listener:
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        with socket.create_connection(("127.0.0.1", port), timeout=1) as peer:
            accepted, _ = listener.accept()
            accepted.close()  # Server-side active close leaves TIME_WAIT after peer closes.
            assert peer.recv(1) == b""
    process = MagicMock(returncode=None)
    process.wait = AsyncMock(return_value=0)
    writer = MagicMock()
    writer.wait_closed = AsyncMock()
    monkeypatch.setattr(asyncio, "create_subprocess_exec", AsyncMock(return_value=process))
    monkeypatch.setattr(asyncio, "open_connection", AsyncMock(return_value=(None, writer)))
    tunnel = await remote_ssh.open_tunnel(
        RemoteProfile(name="Test", host="example.test"), 8765, local_port=port,
    )
    assert tunnel.port == port
    await tunnel.close()
