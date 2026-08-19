// The bridge between the isolated window and the main process.
//
// Everything here is a named, argument-checked call. The renderer gets no `require`, no filesystem,
// no shell and no way to open a socket of its own — when it wants the network it asks for a gateway
// base URL and uses ordinary `fetch` against loopback, where main.cjs's request filter and the
// gateway decide what actually leaves the machine.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('seqognito', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    save: (next) => ipcRenderer.invoke('config:save', next),
  },
  tor: {
    probe: () => ipcRenderer.invoke('tor:probe'),
    // Discard a purpose's circuit so its next request takes a fresh one. The mixing flow calls this
    // between input and output registration; that separation is the reason this application exists.
    rotate: (purpose) => ipcRenderer.invoke('tor:rotate', String(purpose || 'default')),
  },
  net: {
    bases: () => ipcRenderer.invoke('net:bases'),
    log: () => ipcRenderer.invoke('net:log'),
  },
  vault: {
    status: () => ipcRenderer.invoke('vault:status'),
    create: (phrase, passphrase) => ipcRenderer.invoke('vault:create', { phrase, passphrase }),
    unlock: (passphrase) => ipcRenderer.invoke('vault:unlock', passphrase),
    lock: () => ipcRenderer.invoke('vault:lock'),
    phrase: () => ipcRenderer.invoke('vault:phrase'),
  },
  clipboard: { write: (text) => ipcRenderer.invoke('clip:write', text) },
  // The lwk wasm module's bytes. See main.cjs: a file:// page cannot fetch them itself.
  assets: { wasm: () => ipcRenderer.invoke('assets:wasm') },
});
