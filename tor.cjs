// Tor: the only way out of this application.
//
// A CoinJoin round asks you to tell the coordinator two things it must not be able to connect —
// "these coins are mine" and "pay this address" — and blind signatures make the second one
// anonymous. All of which a single IP address undoes in one line of a log file.
//
// A browser cannot fix that: it has one network stack and the page does not choose the route. A
// desktop client can, and that is the reason Seqognito exists. Every request here goes through a
// SOCKS5 proxy, and — this is the part that matters — requests are tagged with a PURPOSE that
// becomes the SOCKS username. Tor's IsolateSOCKSAuth (on by default) gives each distinct
// username/password pair its own circuit, so registering your coins and registering your mixed
// addresses genuinely leave from different exits. The coordinator sees two unrelated strangers.
//
// No dependencies: SOCKS5 is a short binary handshake, and writing it here means the one thing the
// whole privacy claim rests on is 150 readable lines rather than a supply chain.

const net = require('node:net');
const tls = require('node:tls');
const http = require('node:http');
const https = require('node:https');
const { randomBytes } = require('node:crypto');

// SOCKS5 constants, spelled out so the handshake below reads as the RFC does.
const VER = 0x05;
const AUTH_NONE = 0x00;
const AUTH_USERPASS = 0x02;
const CMD_CONNECT = 0x01;
const ATYP_DOMAIN = 0x03;

// A handshake reader. ONE 'data' listener for the whole exchange, consuming from an internal
// buffer: attaching a fresh listener per field and unshifting the remainder looks equivalent and is
// not — the stream stops flowing and the next read waits for bytes that were already delivered.
// (It cost an afternoon; the symptom is a connection that completes the greeting and then hangs.)
function makeReader(socket) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  let failed = null;
  const pump = () => {
    while (waiters.length && buf.length >= waiters[0].n) {
      const w = waiters.shift();
      w.resolve(buf.subarray(0, w.n));
      buf = buf.subarray(w.n);
    }
  };
  const onData = (d) => { buf = Buffer.concat([buf, d]); pump(); };
  const onErr = (e) => { failed = e; while (waiters.length) waiters.shift().reject(e); };
  socket.on('data', onData);
  socket.on('error', onErr);
  return {
    read(n) {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => { waiters.push({ n, resolve, reject }); pump(); });
    },
    // Hand the socket back to whoever will speak the real protocol over it, with anything the proxy
    // sent early put back in front of them.
    release() {
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
      if (buf.length) socket.unshift(buf);
    },
  };
}

// Open a TCP connection to host:port THROUGH the SOCKS proxy. The hostname is sent to the proxy, not
// resolved locally — that is what makes .onion addresses work at all, and what stops a DNS lookup
// announcing to your resolver every server this wallet talks to.
async function socksConnect({ socksHost, socksPort, host, port, user, pass, timeoutMs = 30000 }) {
  const socket = net.connect({ host: socksHost, port: socksPort });
  socket.setTimeout(timeoutMs);
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('timeout', () => reject(new Error('timed out connecting to the Tor SOCKS port')));
    socket.once('error', reject);
  });
  const r = makeReader(socket);
  try {
    socket.write(Buffer.from([VER, 2, AUTH_NONE, AUTH_USERPASS]));
    const greeting = await r.read(2);
    if (greeting[0] !== VER) throw new Error('not a SOCKS5 proxy');
    if (greeting[1] === AUTH_USERPASS) {
      const u = Buffer.from(user || 'seqognito', 'utf8');
      const p = Buffer.from(pass || 'x', 'utf8');
      socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
      const auth = await r.read(2);
      if (auth[1] !== 0x00) throw new Error('the SOCKS proxy rejected the isolation credentials');
    } else if (greeting[1] !== AUTH_NONE) {
      throw new Error('the SOCKS proxy demands an authentication method we do not speak');
    }

    const h = Buffer.from(host, 'utf8');
    socket.write(Buffer.concat([
      Buffer.from([VER, CMD_CONNECT, 0x00, ATYP_DOMAIN, h.length]), h,
      Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    ]));
    const head = await r.read(4);
    if (head[1] !== 0x00) {
      const why = {
        0x01: 'general failure', 0x02: 'connection not allowed', 0x03: 'network unreachable',
        0x04: 'host unreachable', 0x05: 'connection refused', 0x06: 'TTL expired',
        0x07: 'command not supported', 0x08: 'address type not supported',
      }[head[1]] || ('SOCKS error ' + head[1]);
      throw new Error(`Tor could not reach ${host}:${port} — ${why}`);
    }
    // Consume the bound address the proxy echoes back, so the socket is left exactly at the start of
    // the payload.
    if (head[3] === 0x01) await r.read(4 + 2);
    else if (head[3] === ATYP_DOMAIN) { const l = await r.read(1); await r.read(l[0] + 2); }
    else if (head[3] === 0x04) await r.read(16 + 2);
  } catch (e) {
    socket.destroy();
    throw e;
  }
  r.release();
  socket.setTimeout(0);
  return socket;
}

// One agent per (purpose, rotation). The agent's SOCKS credentials are what Tor keys its circuit
// isolation on, so two purposes never share an exit.
class TorAgent extends http.Agent {
  constructor(opts, cfg) { super({ ...opts, keepAlive: false }); this.cfg = cfg; }
  createConnection(options, callback) {
    socksConnect({ ...this.cfg, host: options.host, port: Number(options.port) })
      .then((socket) => callback(null, socket))
      .catch((e) => callback(e));
  }
}
class TorTlsAgent extends https.Agent {
  constructor(opts, cfg) { super({ ...opts, keepAlive: false }); this.cfg = cfg; }
  createConnection(options, callback) {
    socksConnect({ ...this.cfg, host: options.host, port: Number(options.port) })
      .then((socket) => callback(null, tls.connect({ socket, servername: options.host })))
      .catch((e) => callback(e));
  }
}

// The live circuit table. `rotate(purpose)` throws away a purpose's credentials so its next request
// takes a brand-new circuit — the desktop equivalent of "new identity", and what the mixing flow
// calls between phases.
class Tor {
  constructor() {
    this.socksHost = '127.0.0.1';
    this.socksPort = 9050;
    this.creds = new Map();
    this.enabled = true;
  }
  configure({ socksHost, socksPort, enabled }) {
    if (socksHost) this.socksHost = socksHost;
    if (socksPort) this.socksPort = Number(socksPort);
    if (enabled !== undefined) this.enabled = !!enabled;
    this.creds.clear();
  }
  rotate(purpose) { this.creds.delete(String(purpose || 'default')); }
  credentials(purpose) {
    const key = String(purpose || 'default');
    if (!this.creds.has(key)) {
      this.creds.set(key, { user: 'seqognito-' + key, pass: randomBytes(9).toString('hex') });
    }
    return this.creds.get(key);
  }

  // Is there actually a Tor there? A SOCKS5 greeting is enough to tell a running Tor from a closed
  // port or something else listening, and it costs no circuit.
  async probe() {
    const socket = net.connect({ host: this.socksHost, port: this.socksPort });
    try {
      await new Promise((resolve, reject) => {
        socket.setTimeout(4000);
        socket.once('connect', resolve);
        socket.once('timeout', () => reject(new Error('no answer on ' + this.socksHost + ':' + this.socksPort)));
        socket.once('error', reject);
      });
      socket.write(Buffer.from([VER, 2, AUTH_NONE, AUTH_USERPASS]));
      const g = await makeReader(socket).read(2);
      if (g[0] !== VER) throw new Error('something is listening there, but it is not SOCKS5');
      return { ok: true, socks: `${this.socksHost}:${this.socksPort}`, userpass: g[1] === AUTH_USERPASS };
    } finally { socket.destroy(); }
  }

  agentFor(url, purpose) {
    const cfg = { socksHost: this.socksHost, socksPort: this.socksPort, ...this.credentials(purpose) };
    return url.protocol === 'https:' ? new TorTlsAgent({}, cfg) : new TorAgent({}, cfg);
  }
}

// A plain HTTP request over Tor. Returns the status, headers and body — enough for the gateway to
// pass through, and small enough that nothing here needs a streaming abstraction.
function torRequest(tor, urlString, { method = 'GET', headers = {}, body = null, purpose = 'default', timeoutMs = 120000 } = {}) {
  const url = new URL(urlString);
  if (!tor.enabled) {
    // The escape hatch exists because a developer running against a local regtest has no Tor and no
    // adversary. It is never the default, and the UI says so in as many words.
    return plainRequest(url, { method, headers, body, timeoutMs });
  }
  const lib = url.protocol === 'https:' ? https : http;
  const agent = tor.agentFor(url, purpose);
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: url.protocol, hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method, agent,
      headers: { host: url.host, ...headers },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out over Tor')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function plainRequest(url, { method, headers, body, timeoutMs }) {
  const lib = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: url.protocol, hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, method, headers, timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => req.destroy(new Error('request timed out')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { Tor, torRequest, socksConnect };
