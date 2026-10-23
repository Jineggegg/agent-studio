import { app, BrowserWindow, Menu, Notification, dialog, ipcMain, shell, session } from 'electron';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { externalLink, notificationPayload, sameServer, serverUrl } from './policy.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const setupUrl = pathToFileURL(join(root, 'connect.html')).href;
let window;
let configured = null;
let notificationConsent = false;
let microphoneConsent = false;
let lastNotification = 0;
let connectionError = '';
let choosing = false;
const prefPath = () => join(app.getPath('userData'), 'connection.json');

app.setName('Cloud Harness');
app.setAppUserModelId('io.cloudharness.desktop');
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  });
  app.on('certificate-error', (_event, _webContents, _url, _error, _certificate, callback) =>
    callback(false),
  );
  app
    .whenReady()
    .then(start)
    .catch(() => {
      dialog.showErrorBox(
        'Cloud Harness',
        'Could not start the desktop application. / 无法启动桌面应用。',
      );
      app.quit();
    });
}

function isSetup(event) {
  return (
    event.sender === window?.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    event.senderFrame.url === setupUrl
  );
}
function isConnected(event) {
  return (
    event.sender === window?.webContents &&
    event.senderFrame === event.sender.mainFrame &&
    configured &&
    sameServer(event.senderFrame.url, configured)
  );
}

async function saveConnection(url) {
  await mkdir(dirname(prefPath()), { recursive: true });
  await writeFile(prefPath(), JSON.stringify({ url }), { mode: 0o600 });
}
async function connect(raw) {
  const next = serverUrl(raw);
  if (configured && !sameServer(next, configured)) {
    notificationConsent = false;
    microphoneConsent = false;
  }
  configured = next;
  connectionError = '';
  await saveConnection(next);
  installMenu();
  try {
    await window.loadURL(next);
  } catch {
    connectionError =
      'Could not reach the server. Check the address and connection. / 无法访问服务，请检查地址和网络。';
    await window.loadFile(join(root, 'connect.html'));
  }
}

function installMenu() {
  const menu = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    {
      label: 'Cloud Harness',
      submenu: [
        {
          label: 'Connect to server… / 连接服务…',
          click: () => {
            notificationConsent = false;
            microphoneConsent = false;
            void window.loadFile(join(root, 'connect.html'));
            installMenu();
          },
        },
        {
          label: 'Native notifications / 桌面通知',
          type: 'checkbox',
          checked: notificationConsent,
          enabled: Boolean(configured),
          click: async () => {
            if (notificationConsent) notificationConsent = false;
            else {
              const notificationOrigin = configured;
              const answer = await dialog.showMessageBox(window, {
                type: 'question',
                title: 'Cloud Harness',
                message: 'Allow notifications from this server? / 允许此服务显示通知？',
                detail: configured ?? '',
                buttons: ['Cancel / 取消', 'Allow / 允许'],
                defaultId: 0,
                cancelId: 0,
                noLink: true,
              });
              notificationConsent = answer.response === 1 && configured === notificationOrigin;
            }
            installMenu();
          },
        },
        {
          label: 'Revoke microphone permission / 撤销麦克风权限',
          click: () => {
            microphoneConsent = false;
            window.webContents.reload();
          },
        },
        { type: 'separator' },
        { role: process.platform === 'darwin' ? 'close' : 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(menu));
}

async function start() {
  const storage = session.fromPartition('persist:cloud-harness');
  storage.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) =>
      contents === window?.webContents &&
      Boolean(configured && sameServer(requestingOrigin, configured)) &&
      ((permission === 'notifications' && notificationConsent) ||
        (permission === 'media' &&
          microphoneConsent &&
          details.mediaType === 'audio' &&
          details.isMainFrame !== false)),
  );
  storage.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    if (
      contents !== window?.webContents ||
      !configured ||
      !sameServer(details.requestingUrl, configured) ||
      details.isMainFrame === false
    ) {
      callback(false);
      return;
    }
    if (permission === 'notifications') {
      callback(notificationConsent);
      return;
    }
    if (
      permission !== 'media' ||
      !details.mediaTypes?.length ||
      details.mediaTypes.some((type) => type !== 'audio')
    ) {
      callback(false);
      return;
    }
    if (microphoneConsent) {
      callback(true);
      return;
    }
    const permissionOrigin = configured;
    const answer = await dialog.showMessageBox(window, {
      type: 'question',
      title: 'Cloud Harness',
      message: 'Allow microphone for dictation? / 允许麦克风用于语音输入？',
      detail: new URL(configured).origin,
      buttons: ['Cancel / 取消', 'Allow / 允许'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    microphoneConsent = answer.response === 1 && configured === permissionOrigin;
    callback(microphoneConsent);
  });
  storage.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  storage.on('will-download', (event, item) => {
    if (!configured || !sameServer(item.getURL(), configured)) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({
      title: 'Save file / 保存文件',
      defaultPath: join(app.getPath('downloads'), item.getFilename().replace(/[\\/]/g, '_')),
    });
  });
  window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 500,
    title: 'Cloud Harness',
    show: false,
    webPreferences: {
      preload: join(root, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      partition: 'persist:cloud-harness',
      spellcheck: true,
    },
  });
  window.webContents.on('will-attach-webview', (event) => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (configured && sameServer(url, configured)) return;
    event.preventDefault();
    const link = externalLink(url);
    if (!link || choosing) return;
    choosing = true;
    void dialog
      .showMessageBox(window, {
        type: 'question',
        title: 'Cloud Harness',
        message: 'Open link in your browser? / 在浏览器中打开链接？',
        detail: link,
        buttons: ['Cancel / 取消', 'Open / 打开'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
      .then((answer) => {
        if (answer.response === 1) return shell.openExternal(link);
      })
      .finally(() => {
        choosing = false;
      });
  });
  window.webContents.on('will-redirect', (event, url) => {
    if (!configured || !sameServer(url, configured)) event.preventDefault();
  });
  window.webContents.on('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && window.webContents.getURL() !== setupUrl)
      void window.loadFile(join(root, 'connect.html'));
  });
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    window = undefined;
  });
  ipcMain.handle('harness:connection', (event) =>
    isSetup(event) ? { url: configured ?? '', error: connectionError } : null,
  );
  ipcMain.handle('harness:connect', async (event, raw) => {
    if (!isSetup(event)) return { error: 'Not allowed / 不允许' };
    try {
      await connect(raw);
      return { ok: true };
    } catch (error) {
      return { error: error instanceof Error ? error.message : 'Connection failed / 连接失败' };
    }
  });
  ipcMain.on('harness:notify', (event, value) => {
    if (
      !isConnected(event) ||
      !notificationConsent ||
      !Notification.isSupported() ||
      Date.now() - lastNotification < 3000
    )
      return;
    const payload = notificationPayload(value);
    if (!payload) return;
    lastNotification = Date.now();
    const notification = new Notification(payload);
    notification.on('click', () => {
      window?.show();
      window?.focus();
    });
    notification.show();
  });
  installMenu();
  let saved;
  try {
    saved = JSON.parse(await readFile(prefPath(), 'utf8')).url;
  } catch {
    /* First launch has no connection. */
  }
  const requested = process.env.CLOUD_HARNESS_URL ?? saved;
  try {
    if (requested) await connect(requested);
    else await window.loadFile(join(root, 'connect.html'));
  } catch {
    await window.loadFile(join(root, 'connect.html'));
  }
}
app.on('window-all-closed', () => app.quit());
