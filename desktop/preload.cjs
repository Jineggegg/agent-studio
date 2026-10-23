const { contextBridge, ipcRenderer } = require('electron');
// No filesystem, shell, arbitrary channels or general-purpose IPC cross this boundary.
contextBridge.exposeInMainWorld(
  'cloudHarnessDesktop',
  Object.freeze({
    connection: () => ipcRenderer.invoke('harness:connection'),
    connect: (url) => ipcRenderer.invoke('harness:connect', url),
    notify: (title, body) => ipcRenderer.send('harness:notify', { title, body }),
  }),
);
