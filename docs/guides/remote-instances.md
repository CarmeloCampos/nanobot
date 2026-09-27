# Connect to an existing remote nanobot

Open your local **nanobot WebUI** and choose **Remote connections** in the sidebar
(below Channels). Setup opens in the main content area, with the sidebar still
available. Choose a host from **From your SSH config**, or enter an SSH address
such as `ubuntu@your-server` using **Connect to remote nanobot…**.
Give it a recognizable name, then choose **Save & connect**. Next time, select
the saved server. No port-forwarding command or `.command` launcher is needed.

To add another server, choose **Connect to remote nanobot…** below your saved
connections. Use a server's menu to edit or forget it. The page supports browser
back/forward and the `#/remote` route. Leaving setup while SSH is connecting won't
switch you away from the page you chose when that connection finishes.

This connects to the nanobot **already running on the server**. It does not
install a worker, clone a workspace, move conversations, or start a second bot.
It is separate from remote execution/worker deployment.

## Find a server you already use

nanobot lists named hosts from `~/.ssh/config` and the system SSH config, including
ordinary `Include` files. Search by alias, then select a host to review its setup.
If your configuration lives elsewhere, expand **Use another SSH config file**
and enter its local path. Returning from setup keeps the previous list and search.

Discovery is passive: it reads host names and source paths, not private keys,
and does not contact servers or execute SSH hooks. Wildcard and negated patterns
aren't destinations. Conditional includes may suggest hosts; only connecting
checks reachability. Large or dynamic configurations show a partial-list notice;
you can still enter an alias manually. Discovery is capped at 200 hosts, 64 files,
256 KiB per file, and approximately 1 MiB in total.

At connection time, the system SSH client resolves your existing `User`, `Port`,
`IdentityFile`, jump hosts and other connection settings. An empty port field
inherits SSH configuration instead of overriding it with 22. Listing a host
does not mean nanobot is installed there. Enter an alias or address, not a full
shell command.

## Prerequisites

- Run the local WebUI on a loopback address, using the system OpenSSH client.
- Your SSH key must already have access to the server. Encrypted keys should
  be unlocked in the system SSH agent. Interactive SSH passwords are not
  collected by this UI.
- The remote server needs `python3` and an already running nanobot WebUI with
  a configured `tokenIssueSecret` (or `token`) in its configuration file.
- The remote gateway must support the authenticated `/webui/terminal`
  identity probe, protocol version 1, and have the WebUI bundle installed.
  The initial transport supports HTTP on the server's loopback address; SSH
  encrypts the connection. A configured public WebSocket URL is not supported.

If this machine has never connected to the server, nanobot displays its SSH
fingerprint. Compare it with the server console or your administrator before
confirming. The public key is pinned for this connection, without changing
your system `known_hosts`. A **changed** host key is blocked, not automatically
accepted. Jump-host-only or non-Ed25519 hosts can use a previously verified
system SSH configuration instead of the in-app first-contact verifier.

## Advanced options

Most setups only need the SSH address. Expand **Advanced** when necessary:

| Option | Meaning |
| --- | --- |
| SSH port | Optional override; empty inherits SSH config (normally 22) |
| SSH config file | Existing local config, including aliases or jump hosts |
| Private key path | Path to an existing local key; key contents aren't uploaded |
| nanobot config path | Server-side config, default `~/.nanobot/config.json` |
| nanobot service account | Optional account owning the remote config; requires existing passwordless `sudo -u` permission |

For a service installation, the SSH login and nanobot owner may differ. For
example, you might sign in as `ubuntu`, with nanobot running as `nanobot` and
its config in `/var/lib/nanobot/.nanobot/config.json`. Enter those last two
values in Advanced. The connection does not grant new sudo privileges.

## Using the remote instance

The remote instance's **own complete WebUI** fills the main window. Its UI
version follows the server, independently of the local
installation. Model settings, channels, tools and conversations belong to that
server. The isolated remote view cannot navigate the local application's
top-level window. The first version has been exercised in macOS Chrome; native
desktop-host packaging and other platforms still need their own acceptance.

The host switcher lives beside **Settings at the bottom of the sidebar**, showing
**Local** or your saved server name. It is also available in Settings. Its menu
opens upward and shows the computer name, recent hosts, and **Manage connections…**.
With the sidebar collapsed, the icon still opens the same menu. Recent, loaded
hosts show **Ready**. Remote
connection setup is hidden inside the embedded remote view, and connecting back
to the same gateway is rejected rather than creating a nested local session.

Updated remote WebUIs put the switcher in the same sidebar location. A narrowly
scoped, origin- and frame-checked bridge sends only the current host's display
identity and allows its button to open the local shell's menu. The remote page
does not receive your host directory, SSH configuration, or connection commands.
Older remote WebUIs retain a compact bottom-strip switcher so you can always
return local without covering their controls.

Refreshing restores the selected remote instance. A failed connection stays
on a remote error screen; it never silently redirects work to your local agent.
The selected server ID is stored per browser tab, without credentials.

- **Switching hosts**, including returning local, keeps both pages mounted and
  keeps SSH connected. Each host retains its own chat, unsent draft, scroll
  position and UI state; nothing is copied between hosts. Up to three remote
  views are kept per tab. At the limit, explicitly disconnect one rather than
  silently discarding its work. Reloading the browser still follows each
  instance's normal draft persistence; unfinished uploads aren't guaranteed.
- A first connection prepares a hidden server page while the current page stays
  usable. It switches after the page loads; **Cancel switch** keeps you where
  you are. The most recent choice wins even if an earlier SSH request finishes
  later. Cancelling navigation does not stop an in-flight server connection.
  Older server WebUIs can still show their own sign-in/startup indicator after
  the initial page load; returning to an already loaded view avoids that startup.
- **Disconnect** in a server's menu confirms before closing its view and shared
  SSH tunnel. Unsaved view-only work can be lost; the remote bot keeps running.
  Idle views do not automatically close a tunnel another tab might be using.
- **Forget server** removes its local connection metadata and pinned public key.
  It does not delete remote conversations, keys, files, or the installation.
- Closing the local gateway cleans up its SSH processes. The independently
  running remote gateway, Linear integration, and scheduled tasks keep running.
- Connections to the same saved server share one tunnel; explicitly disconnecting
  it also disconnects other local tabs using that tunnel. Reloading a tab reuses
  a healthy connection. Up to four servers can be connected concurrently.

## Security and troubleshooting

The local connection directory is stored beside the local config under
`webui/remote-instances.json`. It contains connection metadata, not private-key
contents or model/channel credentials. A stable loopback port per saved server
keeps browser preferences scoped to that server. Port conflicts fail explicitly;
nanobot does not attach to an unrelated listener.

SSH authenticates the server. A read-only, fixed Python probe retrieves only
WebUI login information from its config. The gateway's protocol and runtime ID
are verified before navigation. The WebUI credential is held by the live
connection and passed in the remote view's URL fragment, not an HTTP query or
local model configuration. The remote WebUI uses its existing browser login
storage. Nothing opens a public administration port or forwards your SSH agent.

Remote-connection actions require an authenticated local WebUI connection, a
loopback-bound gateway, and local request origin. They are unavailable from a
public/reverse-proxied administration page. Connecting requires server admin
access; permission to mention nanobot in Linear is **not** that permission.

Common errors explain whether SSH authentication, a missing config, a service
account, WebUI authentication, protocol compatibility or networking failed.
Configurations whose WebUI secret is supplied only by a service environment,
interactive SSH passwords, and remote WebUIs with a public WebSocket URL need
additional setup; this flow does not silently weaken their authentication.
