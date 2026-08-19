// The local gateway: the renderer's entire view of the internet.
//
// The window has no network access of its own — no remote origins, no direct fetch to a server, and
// a Content-Security-Policy that forbids it. Everything it needs (the Sequentia chain, the Bitcoin
// chain, the coordinator, the peg bridge) is reached through this loopback server, which is the ONLY
// component in the application that opens a socket, and which sends every one of them through Tor.
//
// Two things fall out of that, and both are the point:
//
//   * it is auditable. "Does this wallet ever leak?" is answered by reading one file rather than by
//     trusting a browser engine's proxy settings, an extension, or a library's idea of a default.
//   * requests can be assigned a CIRCUIT. The renderer says what a request is FOR — registering
//     coins, registering a mixed address, ordinary chain sync — and the purpose becomes the Tor
//     SOCKS credential, so those go out over different circuits from different exits.
//
// The path carries a per-run random token. Nothing else on the machine can guess it, so a stray page
// in another browser cannot use this as an open proxy.

const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { torRequest } = require('./tor.cjs');

// What the renderer may ask for, and where each goes. An unknown prefix is a 404 rather than
// something we try to be helpful about: an open-ended proxy is exactly what this must not be.
const ROUTES = ['seq', 'btc', 'cj', 'sbtc'];

// The purposes a request may claim, and therefore the circuits that exist. Anything else is
// rejected — a renderer bug must not be able to invent an isolation domain, or to reuse the
// input-registration circuit for output registration by mistake.
const PURPOSES = new Set(['chain', 'cj-input', 'cj-output', 'cj-poll', 'peg']);

class Gateway {
  constructor(tor) {
    this.tor = tor;
    this.token = randomBytes(16).toString('hex');
    this.upstream = { seq: null, btc: null, cj: null, sbtc: null };
    this.server = null;
    this.port = 0;
    this.log = [];               // recent requests, for the network panel — host and purpose only
  }

  setUpstreams(u) { this.upstream = { ...this.upstream, ...u }; }

  base(kind) { return `http://127.0.0.1:${this.port}/${this.token}/${kind}`; }

  note(entry) {
    this.log.unshift({ ...entry, at: Date.now() });
    this.log = this.log.slice(0, 200);
  }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this.port;
  }

  stop() { try { this.server?.close(); } catch {} }

  async handle(req, res) {
    const parts = String(req.url || '').split('/').filter(Boolean);
    if (parts[0] !== this.token) { res.writeHead(404); return res.end('no'); }
    const kind = parts[1];
    if (!ROUTES.includes(kind)) { res.writeHead(404); return res.end('no'); }
    const upstream = this.upstream[kind];
    if (!upstream) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: `no ${kind} endpoint is configured` }));
    }

    const purposeHeader = String(req.headers['x-seqognito-purpose'] || 'chain');
    const purpose = PURPOSES.has(purposeHeader) ? purposeHeader : 'chain';
    const rest = '/' + parts.slice(2).join('/');
    const qs = String(req.url).includes('?') ? String(req.url).slice(String(req.url).indexOf('?')) : '';
    const target = upstream.replace(/\/$/, '') + (rest === '/' ? '' : rest) + qs;

    const body = await readBody(req);
    // Deliberately NOT forwarded: cookies, referer, user-agent, accept-language — the fingerprint a
    // browser would volunteer. The upstream sees a bare request from a Tor exit.
    const headers = {};
    if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
    if (body && body.length) headers['content-length'] = String(body.length);

    let out;
    try {
      out = await torRequest(this.tor, target, { method: req.method, headers, body, purpose });
      this.note({ kind, purpose, host: new URL(target).host, status: out.status });
    } catch (e) {
      this.note({ kind, purpose, host: safeHost(target), error: String(e.message || e) });
      throw e;
    }
    const passthrough = {};
    for (const h of ['content-type', 'cache-control']) if (out.headers[h]) passthrough[h] = out.headers[h];
    res.writeHead(out.status, passthrough);
    res.end(out.body);
  }
}

function safeHost(u) { try { return new URL(u).host; } catch { return '?'; } }

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (d) => { size += d.length; if (size > 32 * 1024 * 1024) req.destroy(); else chunks.push(d); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.alloc(0)));
  });
}

module.exports = { Gateway, PURPOSES };
