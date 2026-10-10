/* secondmind – Electron Preload
   Liefert die native Schnittstelle ("sm") an den Renderer – ohne Node-Zugriff. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sm', {
  platform: 'windows',
  version: process.versions.electron,
  openAuth: (url, timeoutMs) => ipcRenderer.invoke('sm:open-auth', url, timeoutMs),
  encrypt: (value) => ipcRenderer.invoke('sm:encrypt', value),
  decrypt: (value) => ipcRenderer.invoke('sm:decrypt', value),
  openExternal: (url) => ipcRenderer.send('sm:open-external', url),
});
