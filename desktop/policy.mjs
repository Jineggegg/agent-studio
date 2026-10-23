const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function serverUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048)
    throw new Error('Enter a server URL. / 请输入服务地址。');
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('Invalid server URL. / 服务地址无效。');
  }
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      'Credentials, query strings and fragments are not allowed. / 地址不可包含凭据、查询参数或片段。',
    );
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(url.hostname)))
    throw new Error('Use HTTPS, or HTTP on localhost only. / 请使用 HTTPS，本机地址可用 HTTP。');
  return url.href;
}

export function sameServer(raw, configured) {
  try {
    return new URL(raw).origin === new URL(serverUrl(configured)).origin;
  } catch {
    return false;
  }
}

export function externalLink(raw) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export function notificationPayload(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.title !== 'string' ||
    typeof value.body !== 'string'
  )
    return null;
  // Remove control characters from untrusted notification text.
  return {
    // eslint-disable-next-line no-control-regex
    title: value.title.replace(/[\u0000-\u001f]/g, '').slice(0, 120),
    // eslint-disable-next-line no-control-regex
    body: value.body.replace(/[\u0000-\u001f]/g, ' ').slice(0, 600),
  };
}
