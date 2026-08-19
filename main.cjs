// Seqognito — a mixing wallet for Sequentia.
//
// It does four things: hold Bitcoin and Sequentia assets, receive, send, and mix. Everything not in
// service of those is absent on purpose. There is no trading, no staking, no browser, no analytics,
// and no telemetry.
//
// THE ONE ARCHITECTURAL RULE. The window cannot reach the network. Not "is configured not to" —
// cannot: every request it makes is either a local file or the loopback gateway, and anything else
// is cancelled in `onBeforeRequest` below and refused again by Content-Security-Policy. The gateway
// (gateway.cjs) is the only component with a socket, and it sends everything through Tor
// (tor.cjs), tagging requests with a purpose so that registering your coins and registering your
// mixed addresses leave over different circuits.
//
// That is the whole reason a desktop client exists for this. A web page can run the same protocol —
// the browser wallet does — but it cannot separate those two connections, and a coordinator that
// sees the same IP on both has undone the blind signature without breaking any cryptography.

const { app, BrowserWindow, ipcMain, shell, session, clipboard } = require('electron');
const { join } = require('node:path');
const { readFileSync } = require('node:fs');
const { Tor } = require('./tor.cjs');
const { Gateway } = require('./gateway.cjs');
const { Store } = require('./store.cjs');

const store = new Store();
const tor = new Tor();
const gateway = new Gateway(tor);
let win = null;

function applyConfig(cfg) {
  tor.configure({ socksHost: cfg.tor.host, socksPort: cfg.tor.port, enabled: cfg.tor.enabled });
  gateway.setUpstreams(cfg.endpoints);
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1080, height: 780, minWidth: 900, minHeight: 640,
    backgroundColor: '#0d1117',
    title: 'Seqognito',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,          // the preload needs require(); the renderer itself stays isolated
      devTools: !app.isPackaged,
      spellcheck: false,
    },
  });
  win.setMenuBarVisibility(false);

  const ses = win.webContents.session;
  const allowed = `http://127.0.0.1:${gateway.port}/`;

  // The hard stop. Anything that is not a local file or our own gateway simply does not happen —
  // including anything a future dependency might try, which is the point of enforcing it here rather
  // than reviewing every fetch call.
  ses.webRequest.onBeforeRequest((details, cb) => {
    const url = details.url;
    const ok = url.startsWith('file://') || url.startsWith(allowed) || url.startsWith('devtools://');
    if (!ok) console.warn('[seqognito] blocked a request to', safeOrigin(url));
    cb({ cancel: !ok });
  });

  // Belt and braces: a CSP that says the same thing, so a bug in the rule above is not the only
  // thing standing between this wallet and a leak.
  ses.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders,
      'Content-Security-Policy': [
        `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; ` +
        `img-src 'self' data:; connect-src ${allowed}; object-src 'none'; base-uri 'none'; form-action 'none'`,
      ] } });
  });

  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  // External links open in the user's browser, and nothing opens a window inside the wallet.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // In a dev run, the renderer's console and any failed load come out on the terminal. Without this
  // a broken import is a silently blank window, which is a miserable way to find a typo.
  if (!app.isPackaged) {
    win.webContents.on('console-message', (_e, _level, message, line, source) =>
      console.log('[renderer]', message, `(${String(source).split('/').pop()}:${line})`));
    win.webContents.on('did-fail-load', (_e, code, desc) => console.error('[renderer] load failed', code, desc));
    win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer] gone', d.reason));
  }

  await win.loadFile(join(__dirname, 'ui', 'index.html'));
}

function safeOrigin(u) { try { return new URL(u).origin; } catch { return '(unparseable)'; } }

// ---- IPC --------------------------------------------------------------------
// Narrow on purpose: config, Tor, the vault, and the gateway's addresses. No file access, no shell,
// no arbitrary requests — the renderer asks for a base URL and talks to it with ordinary fetch.
ipcMain.handle('config:get', () => store.config());
ipcMain.handle('config:save', (_e, next) => { const c = store.saveConfig(next || {}); applyConfig(c); return c; });
ipcMain.handle('tor:probe', async () => {
  if (!tor.enabled) return { ok: false, disabled: true };
  try { return await tor.probe(); } catch (e) { return { ok: false, error: String(e.message || e) }; }
});
// "New identity", per purpose. The mixing flow calls this between phases so that the connection
// registering a mixed address has nothing in common with the one that registered the coins.
ipcMain.handle('tor:rotate', (_e, purpose) => { tor.rotate(purpose); return true; });
ipcMain.handle('net:bases', () => ({
  seq: gateway.base('seq'), btc: gateway.base('btc'), cj: gateway.base('cj'), sbtc: gateway.base('sbtc'),
}));
ipcMain.handle('net:log', () => gateway.log.slice(0, 60));

ipcMain.handle('vault:status', () => ({ exists: store.hasVault(), unlocked: !!store.phrase }));
ipcMain.handle('vault:create', (_e, { phrase, passphrase }) => { store.createVault(phrase, passphrase); return true; });
ipcMain.handle('vault:unlock', (_e, passphrase) => store.unlock(passphrase));
ipcMain.handle('vault:lock', () => { store.lock(); return true; });
// The phrase is handed over only after an unlock in this session, and only to our own renderer.
ipcMain.handle('vault:phrase', () => {
  if (!store.phrase) throw new Error('the wallet is locked');
  return store.phrase;
});
// The wasm module's own loader fetches its .wasm, and a page served from file:// cannot fetch
// anything — Chromium refuses file:// fetches outright. Rather than stand up an HTTP server for the
// UI (and give the window an origin it does not need), the bytes come across the bridge.
ipcMain.handle('assets:wasm', () => readFileSync(join(__dirname, 'ui', 'pkg', 'lwk_wasm_bg.wasm')));
ipcMain.handle('clip:write', (_e, text) => { clipboard.writeText(String(text ?? '')); return true; });

app.whenReady().then(async () => {
  applyConfig(store.config());
  await gateway.start();
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { gateway.stop(); if (process.platform !== 'darwin') app.quit(); });
