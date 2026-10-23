export const domainEn = {
  'domain.title': 'Domain & access',
  'domain.eyebrow': 'MAKE IT YOURS',
  'domain.hero': 'Your workspace. Your address.',
  'domain.intro':
    'Bring Cloud Harness to your own domain. Open the same workspace from your phone, iPad or computer.',
  'domain.private': 'Your server',
  'domain.secure': 'HTTPS access',
  'domain.devices': 'Every device',
  'domain.current': 'Server configuration',
  'domain.current.empty': 'No public address configured',
  'domain.current.ready': 'Address listed in server configuration',
  'domain.current.pending': 'Address not yet listed in server configuration',
  'domain.current.hint':
    'This reads the server’s allowed addresses. DNS, certificates and outside connectivity must be checked separately.',
  'domain.refresh': 'Refresh status',
  'domain.address': '1 · Choose your address',
  'domain.name': 'Your domain',
  'domain.name.hint':
    'Use a domain you own, without https://, a path or a port. For international domains, enter the ASCII (punycode) name.',
  'domain.name.error':
    'Enter a full DNS hostname, such as harness.example.com. URLs, IP addresses and local-only names are not supported here.',
  'domain.port': 'Local service port',
  'domain.port.hint': 'Use the port your Cloud Harness server listens on. The default is 7420.',
  'domain.port.error': 'Enter a port from 1 to 65535.',
  'domain.method': 'Connection method',
  'domain.caddy': 'Caddy',
  'domain.cloudflare': 'Cloudflare Tunnel',
  'domain.caddy.hint':
    'For a server with a public IP. Point DNS to your server; Caddy manages HTTPS certificates.',
  'domain.cloudflare.hint':
    'For a server behind a home router. A tunnel connects outward; your domain must be on Cloudflare.',
  'domain.empty': 'Enter your domain to prepare a setup guide.',
  'domain.setup': '2 · Set up your connection',
  'domain.manual':
    'These instructions prepare your setup. Apply them on your server and at your domain provider; this page does not change DNS or server settings.',
  'domain.dns.title': 'Point DNS to your server',
  'domain.dns.detail':
    'In your DNS provider, add an A record for {domain} pointing to your server’s public IPv4 address. Add AAAA only if IPv6 works. Allow incoming ports 80 and 443 to Caddy; keep the app port private.',
  'domain.proxy.title': 'Install Caddy on the same host',
  'domain.proxy.detail':
    'Add this site block to your Caddyfile. Validate the file, then reload the Caddy service. Preserve the original Host header; WebSockets are supported automatically.',
  'domain.proxy.docs': 'Caddy HTTPS setup',
  'domain.caddyfile': 'Caddyfile',
  'domain.tunnel.title': 'Create a Cloudflare Tunnel',
  'domain.tunnel.detail':
    'In Cloudflare, open Networking → Tunnels. Create a tunnel and install its connector on this server using the command shown there. Keep the tunnel token private.',
  'domain.route.title': 'Add a published application route',
  'domain.route.detail':
    'Choose your hostname below and set Service URL to the local address. Leave the path blank and the Host header unchanged. Cloudflare creates the DNS route. Keep WebSockets enabled; bypass caching for this hostname.',
  'domain.route.host': 'Public hostname',
  'domain.route.service': 'Service URL',
  'domain.route.docs': 'Cloudflare Tunnel setup',
  'domain.access':
    'Add a Cloudflare Access policy if you want to restrict who can reach the sign-in page. Cloud Harness sign-in is still required.',
  'domain.environment.title': 'Allow your address in Cloud Harness',
  'domain.environment.detail':
    'For a packaged install, edit ~/.config/agent-studio/env with these values. For Docker or a source install, use its service environment. Keep any existing public origins you still use in the comma-separated PUBLIC_ORIGINS list.',
  'domain.environment': 'Server environment',
  'domain.restart.title': 'Restart and verify',
  'domain.restart.detail':
    'Restart the packaged service with cloud-harness service restart. For Docker or another service manager, recreate or restart it using the updated environment. Then open your HTTPS address and sign in.',
  'domain.verify': '3 · Check from another device',
  'domain.verify.detail':
    'Run the health check from a different network, then test sign-in and a live conversation. A health response alone does not prove that this is your server. Check the address and certificate before entering your password.',
  'domain.check': 'Health check',
  'domain.passkeys':
    'Passkeys are tied to a hostname. Keep a password or another working sign-in method, then register a new passkey at your new address.',
  'domain.open': 'Open your address',
  'domain.guide': 'Full deployment guide',
  'domain.copy': 'Copy {name}',
  'domain.copy.failed': 'Copy failed. Select the configuration text and copy it manually.',
} as const;

export const domainZhCN: Record<keyof typeof domainEn, string> = {
  'domain.title': '域名与访问',
  'domain.eyebrow': '属于你的工作空间',
  'domain.hero': '你的工作台，你的专属域名。',
  'domain.intro': '为 Cloud Harness 使用自己的域名，在手机、iPad 和电脑上打开同一个工作空间。',
  'domain.private': '自己的服务器',
  'domain.secure': 'HTTPS 访问',
  'domain.devices': '多设备使用',
  'domain.current': '服务器配置',
  'domain.current.empty': '尚未配置公开访问地址',
  'domain.current.ready': '该地址已列入服务器配置',
  'domain.current.pending': '该地址尚未列入服务器配置',
  'domain.current.hint': '这里读取服务器允许的地址。DNS、证书和外网连通性仍需单独验证。',
  'domain.refresh': '刷新状态',
  'domain.address': '1 · 选择你的地址',
  'domain.name': '你的域名',
  'domain.name.hint':
    '填写自己拥有的域名，不含 https://、路径或端口。国际化域名请使用 ASCII（punycode）形式。',
  'domain.name.error':
    '请输入完整 DNS 域名，例如 harness.example.com。此处不支持网址、IP 地址或仅本地使用的名称。',
  'domain.port': '本地服务端口',
  'domain.port.hint': '填写 Cloud Harness 服务器实际监听的端口，默认为 7420。',
  'domain.port.error': '请输入 1 到 65535 之间的端口。',
  'domain.method': '连接方式',
  'domain.caddy': 'Caddy',
  'domain.cloudflare': 'Cloudflare Tunnel',
  'domain.caddy.hint': '适合有公网 IP 的服务器。将 DNS 指向服务器，由 Caddy 管理 HTTPS 证书。',
  'domain.cloudflare.hint':
    '适合位于家庭路由器后的服务器。隧道主动向外连接，域名需托管在 Cloudflare。',
  'domain.empty': '输入域名后即可生成配置指南。',
  'domain.setup': '2 · 配置连接',
  'domain.manual':
    '请在服务器和域名服务商处应用下面的配置。本页提供操作指南，不会直接修改 DNS 或服务器设置。',
  'domain.dns.title': '将 DNS 指向服务器',
  'domain.dns.detail':
    '在 DNS 服务商处，为 {domain} 添加指向服务器公网 IPv4 的 A 记录。仅在 IPv6 可用时添加 AAAA 记录。让 Caddy 接收 80 和 443 端口的入站连接，应用端口保持不对外开放。',
  'domain.proxy.title': '在同一台主机安装 Caddy',
  'domain.proxy.detail':
    '把这个站点配置加入 Caddyfile，验证配置文件后重新加载 Caddy 服务。保留原始 Host 请求头；WebSocket 会自动得到支持。',
  'domain.proxy.docs': 'Caddy HTTPS 配置说明',
  'domain.caddyfile': 'Caddyfile',
  'domain.tunnel.title': '创建 Cloudflare Tunnel',
  'domain.tunnel.detail':
    '在 Cloudflare 中打开 Networking → Tunnels，创建隧道，并使用页面提供的命令在这台服务器上安装连接器。请妥善保管隧道令牌。',
  'domain.route.title': '添加公开应用路由',
  'domain.route.detail':
    '选择下面的公开域名，把 Service URL 设为本地地址。路径留空，不要改写 Host 请求头。Cloudflare 会创建 DNS 路由。保持 WebSocket 开启，并为这个域名绕过缓存。',
  'domain.route.host': '公开域名',
  'domain.route.service': 'Service URL',
  'domain.route.docs': 'Cloudflare Tunnel 配置说明',
  'domain.access':
    '如果希望限制登录页的访问人群，可添加 Cloudflare Access 策略。通过后仍需登录 Cloud Harness。',
  'domain.environment.title': '在 Cloud Harness 中允许新地址',
  'domain.environment.detail':
    '安装包用户请将这些值写入 ~/.config/agent-studio/env。Docker 或源码部署请修改对应服务的环境变量。PUBLIC_ORIGINS 支持逗号分隔，请保留仍需使用的已有地址。',
  'domain.environment': '服务器环境变量',
  'domain.restart.title': '重启并验证',
  'domain.restart.detail':
    '安装包服务执行 cloud-harness service restart。Docker 或其他服务管理器请使用新环境变量重新创建或重启服务。然后打开 HTTPS 地址并登录。',
  'domain.verify': '3 · 换一台设备检查',
  'domain.verify.detail':
    '从另一个网络执行健康检查，再测试登录和实时对话。健康响应本身不能证明这是你的服务器；输入密码前请确认地址和证书。',
  'domain.check': '健康检查',
  'domain.passkeys':
    '通行密钥与域名绑定。请保留密码或其他可用登录方式，然后在新域名重新注册通行密钥。',
  'domain.open': '打开你的地址',
  'domain.guide': '完整部署指南',
  'domain.copy': '复制{name}',
  'domain.copy.failed': '复制失败，请选中配置文本手动复制。',
};
