# Reaching your Studio from a phone

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

## Cloudflare Tunnel (public host name, no open ports)

```
cloudflared tunnel create studio
cloudflared tunnel route dns studio studio.example.com
```

`~/.cloudflared/config.yml`:

```yaml
tunnel: studio
credentials-file: /home/you/.cloudflared/<tunnel-id>.json
ingress:
  - hostname: studio.example.com
    service: http://127.0.0.1:7420
  - service: http_status:404
```

Set `AGENT_STUDIO_PUBLIC_ORIGINS=https://studio.example.com` and
`AGENT_STUDIO_TRUST_PROXY=on`. Strongly consider putting Cloudflare Access in
front, so that the sign-in page itself is only reachable after your identity
provider has let you through.

WebSockets pass through tunnels without extra configuration.

## A reverse proxy you run yourself

Caddy obtains certificates automatically:

```
studio.example.com {
    reverse_proxy 127.0.0.1:7420
}
```

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
Description=Agent Cloud Studio
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

After signing in as the owner, **Settings → About** lists anything about the
configuration that deserves a second look (plain-http exposure, a missing
sandbox, a data directory other accounts can read).
