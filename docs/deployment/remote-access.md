# Your domain, on every device

**In the app:** sign in as the owner, then open **Settings → Domain & access**
(`/settings/domain`). Enter a hostname you own and the app's local port (default
`7420`), then choose **Caddy** or **Cloudflare Tunnel**. The page prepares copyable
configuration and shows the addresses actually allowed by the running server.
It does not change DNS, install a proxy, restart a service, or claim to have
verified DNS/TLS reachability. Keep the server terminal available while changing
its address.

**中文快速入口：**以管理员身份打开 **设置 → 域名与访问**，填写自己的域名和本地服务
端口，选择 Caddy 或 Cloudflare Tunnel。复制页面配置后，在域名服务商和服务器上
应用配置并重启。页面会读取服务器允许的地址；DNS、HTTPS 证书和外网连通性需要
另行验证。不要把任何隧道令牌、DNS API 密钥或证书私钥粘贴到本页面。

For an installed release, settings live in `~/.config/agent-studio/env`
(or the location selected through `XDG_CONFIG_HOME` / `AGENT_STUDIO_ENV_FILE`).
Edit existing values instead of appending duplicate keys. The compatibility names
`AGENT_STUDIO_*` and `agent-studio` remain supported after the Cloud Harness rename.
For Docker or source deployments, set the same variables in the environment
provided by your container or service manager.

```ini
AGENT_STUDIO_HOST=127.0.0.1
AGENT_STUDIO_PORT=7420
AGENT_STUDIO_PUBLIC_ORIGINS=https://harness.example.com
AGENT_STUDIO_TRUST_PROXY=on
```

Replace the example hostname with your own. Keep any other origins you still use
in `AGENT_STUDIO_PUBLIC_ORIGINS`, separated by commas. Keep the app bound to
loopback when the proxy or tunnel connector runs on the same host. For containers,
use a private container network and do not publish the unencrypted app port to the
Internet; `127.0.0.1` inside one container cannot reach another container.

After applying the proxy/tunnel setup below, restart an installed service:

```sh
cloud-harness service restart
```

Restart/recreate other deployment types using their own service manager and the
updated environment. Cloud Harness does not load a `.env` file when started
directly with Node.js; its environment must be supplied by the launching process.

The shape is always the same:

```
phone ──HTTPS──▶ something that terminates TLS ──▶ 127.0.0.1:7420 (the Studio) ──▶ agent CLIs and model APIs
```

Model requests are made by the server. Your phone never talks to a model
provider and never holds an API key. The Studio is not a public AI proxy: every
API route except sign-in, first-run setup and a bare health check requires a
signed-in session or an API token (the agents' bridge and plugin panels use
tokens the server issues for one run or one panel).

Two rules make every option below safe:

1. **Leave the Studio on loopback** (`AGENT_STUDIO_HOST=127.0.0.1`, the
   default) and let the tunnel or proxy be the only thing that listens on the
   network.
2. **Tell the Studio its public address**: set
   `AGENT_STUDIO_PUBLIC_ORIGINS=https://studio.example.com`. Requests for any
   other host name are refused, session cookies for that origin are marked
   `Secure`, and passkeys become available there.

## Tailscale (private; recommended to start with)

With Tailscale on the server and on your devices, serve the Studio on your
tailnet over HTTPS:

```
tailscale serve --bg http://127.0.0.1:7420
```

(Tailscale 1.52 or newer; older versions use a different syntax — check
`tailscale serve --help`. This was not tested as part of this project.)

Then set `AGENT_STUDIO_PUBLIC_ORIGINS=https://<machine>.<tailnet>.ts.net` and
restart. Only devices on your tailnet can reach it. Do not use `tailscale
funnel` unless you intend the sign-in page to be on the public internet.

Plain `http://100.x.y.z:7420` also works on a tailnet if you bind the Studio to
the Tailscale address and list that origin, but cookies cannot be `Secure`
there and passkeys do not work on IP addresses; the app will warn you.

## Cloudflare Tunnel (public hostname, no inbound ports)

1. Add your domain to Cloudflare. In **Networking → Tunnels**, create a tunnel
   and install its connector on the Cloud Harness host using the command shown in
   the dashboard. Keep that command's tunnel token private.
2. Under the tunnel's **Routes**, add a **Published application**. Set the hostname
   to your chosen domain, and the service URL to `http://127.0.0.1:7420`. Leave the
   path empty: Cloud Harness needs the root of its hostname.
3. Cloudflare creates the DNS route. Keep the original Host header and WebSockets
   enabled. Configure a cache bypass rule for this hostname so authenticated
   pages and API responses are never cached by an edge rule.
4. Apply the server environment above and restart Cloud Harness. For an extra
   sign-in boundary, add a Cloudflare Access policy; Cloud Harness authentication
   remains required. Connector health alone does not verify app sign-in.

See the official [Cloudflare Tunnel setup](https://developers.cloudflare.com/tunnel/get-started/)
and [published application routing](https://developers.cloudflare.com/tunnel/concepts/routing/).
The domain setup page provides a hostname and local service address to copy; it
never asks for or stores your Cloudflare credentials.

## A reverse proxy you run yourself

Use a DNS A record pointing to your server's public IPv4 address. Add AAAA only
when the server is reachable over IPv6. Install Caddy on the same host, make
ports 80 and 443 reachable from the Internet, and keep port 7420 private.
Caddy obtains and renews certificates automatically for the hostname:

```
studio.example.com {
    reverse_proxy 127.0.0.1:7420
}
```

Add that block to your Caddyfile, validate it, then reload the installed Caddy
service. For a standard Linux system service using `/etc/caddy/Caddyfile`:

```sh
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

Use the actual config path and service manager on your installation. Caddy
preserves Host and supports WebSocket upgrades. See its official
[HTTPS quick-start](https://caddyserver.com/docs/quick-starts/https) and
[reverse proxy reference](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
Apply the server environment above and restart Cloud Harness as well.

nginx — note the `Host` header, which nginx otherwise replaces with the
upstream address, and the upgrade headers for WebSockets:

```nginx
server {
    listen 443 ssl http2;
    server_name studio.example.com;
    # ssl_certificate … ; ssl_certificate_key … ;

    client_max_body_size 64m;

    location / {
        proxy_pass http://127.0.0.1:7420;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 1h;
    }
}
```

If writes fail with "Requests from that origin are not accepted", the proxy is
not forwarding the original `Host`.

The Studio expects to be served at the root of its host name, not under a
sub-path.

## SSH port forwarding (no set-up at all)

```
ssh -L 7420:127.0.0.1:7420 you@server
```

and open `http://localhost:7420` on the machine you ran that from.

## HTTPS without a proxy

Set `AGENT_STUDIO_TLS_CERT` and `AGENT_STUDIO_TLS_KEY` to PEM files and
`AGENT_STUDIO_HOST` to the address to listen on. You are then responsible for
renewing the certificate.

## Running as a service (systemd)

```ini
# ~/.config/systemd/user/agent-studio.service
[Unit]
Description=Cloud Harness
After=network-online.target

[Service]
WorkingDirectory=%h/agent-studio
ExecStart=/usr/bin/node apps/server/dist/main.js
Environment=AGENT_STUDIO_PUBLIC_ORIGINS=https://studio.example.com
Environment=AGENT_STUDIO_TRUST_PROXY=on
Restart=on-failure
# Hardening that does not get in an agent's way
NoNewPrivileges=yes
PrivateTmp=no

[Install]
WantedBy=default.target
```

```
systemctl --user daemon-reload
systemctl --user enable --now agent-studio
loginctl enable-linger "$USER"     # keep it running after you log out
```

Run it under an ordinary, unprivileged account — the one whose projects and
agent sign-ins you want it to use. Never run it as root: agents and terminals
have the permissions of the service account.

The service usually gets systemd's default `PATH`, not your shell's. The
Studio looks for `claude`, `codex`, `gh` and `bwrap` on that `PATH`, so if
they (or `node`) live elsewhere — `~/.local/bin`, for example — give
`ExecStart` the full path of `node` and add a line such as
`Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin`; otherwise those
agents show as not installed.

## Installing it on the phone

Open the address in Safari (iOS/iPadOS) or Chrome (Android) and choose **Add to
Home Screen**. On iOS, notifications work only for the installed app (iOS 16.4
or later).

## Checking the result

Open `https://harness.example.com` from another device or network. Confirm the
hostname and valid certificate before entering your password. You can check
liveness from that network with:

```sh
curl --fail --show-error https://harness.example.com/api/health
```

An `ok` response is only a liveness result; it does not prove server identity or
that sign-in, WebSockets and uploads work. Sign in, open a conversation and send a
message to confirm the live connection. Never disable certificate verification
to make a failing setup look successful.

**Settings → Domain & access → Refresh status** reads the running server's allowed
origins. “Address listed in server configuration” means exactly that; it is not a
DNS or TLS verification. **Settings → About** also lists configuration warnings
such as unencrypted exposure or a missing sandbox.

Passkeys belong to a hostname. Keep a password or another working sign-in method
while moving, then register a new passkey on the new address. Keep the old origin
allowed until all devices can sign in through the new one.
