// The privacy property, tested rather than asserted.
//
// Seqognito's whole reason to exist as a desktop application is that it can put input registration
// and output registration on DIFFERENT Tor circuits. Tor keys circuit isolation on the SOCKS
// username/password, so the claim reduces to something checkable without Tor at all: does a request
// tagged 'cj-input' reach the proxy with different credentials from one tagged 'cj-output', and do
// those credentials survive a rotation?
//
// The fake below is a real SOCKS5 server that records the credentials it is offered and then pipes
// the connection to a real upstream. If the isolation ever regressed — a purpose dropped, a header
// ignored, an agent shared — these tests fail.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Tor } = require('../tor.cjs');
const { Gateway } = require('../gateway.cjs');

// A minimal SOCKS5 server that demands username/password, records it, and connects onwards.
function fakeSocks(seen){
  const srv = net.createServer((sock) => {
    let stage = 0;
    sock.on('data', function onData(buf){
      if (stage === 0){
        sock.write(Buffer.from([0x05, 0x02]));            // choose username/password
        stage = 1; return;
      }
      if (stage === 1){
        const ulen = buf[1];
        const user = buf.subarray(2, 2 + ulen).toString();
        const plen = buf[2 + ulen];
        const pass = buf.subarray(3 + ulen, 3 + ulen + plen).toString();
        seen.push({ user, pass });
        sock.write(Buffer.from([0x01, 0x00]));
        stage = 2; return;
      }
      if (stage === 2){
        // CONNECT: ver, cmd, rsv, atyp=domain, len, host, port
        const len = buf[4];
        const host = buf.subarray(5, 5 + len).toString();
        const port = buf.readUInt16BE(5 + len);
        const up = net.connect({ host: host === 'localhost' ? '127.0.0.1' : host, port }, () => {
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          sock.removeListener('data', onData);
          sock.pipe(up); up.pipe(sock);
        });
        up.on('error', () => sock.destroy());
        stage = 3;
      }
    });
    sock.on('error', () => {});
  });
  return srv;
}

async function listen(srv){ await new Promise((r) => srv.listen(0, '127.0.0.1', r)); return srv.address().port; }

test('each purpose gets its own SOCKS credentials, and rotation changes them', async (t) => {
  const seen = [];
  const socks = fakeSocks(seen);
  const socksPort = await listen(socks);

  const hits = [];
  const upstream = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const upPort = await listen(upstream);

  const tor = new Tor();
  tor.configure({ socksHost: '127.0.0.1', socksPort, enabled: true });
  const gw = new Gateway(tor);
  gw.setUpstreams({ cj: `http://127.0.0.1:${upPort}` });
  await gw.start();
  t.after(() => { gw.stop(); socks.close(); upstream.close(); });

  const call = (purpose, path) => fetch(gw.base('cj') + path, { headers: { 'x-seqognito-purpose': purpose } }).then((r) => r.json());

  assert.deepEqual(await call('cj-input', '/register-input'), { ok: true });
  assert.deepEqual(await call('cj-output', '/register-output'), { ok: true });

  assert.equal(seen.length, 2, 'both requests should have gone through the proxy');
  assert.notEqual(seen[0].user, seen[1].user, 'input and output registration must not share a circuit');
  assert.match(seen[0].user, /cj-input/);
  assert.match(seen[1].user, /cj-output/);

  // The same purpose keeps its circuit...
  await call('cj-input', '/again');
  assert.equal(seen[2].pass, seen[0].pass, 'a purpose should keep its circuit until rotated');

  // ...until it is rotated, which is what "new circuits" does before a round.
  tor.rotate('cj-input');
  await call('cj-input', '/after-rotation');
  assert.notEqual(seen[3].pass, seen[0].pass, 'rotation must produce fresh credentials');
  assert.equal(hits.length, 4);
});

test('the gateway is not an open proxy', async (t) => {
  const seen = [];
  const socks = fakeSocks(seen);
  const socksPort = await listen(socks);
  const upstream = http.createServer((_q, res) => { res.writeHead(200); res.end('hi'); });
  const upPort = await listen(upstream);

  const tor = new Tor();
  tor.configure({ socksHost: '127.0.0.1', socksPort, enabled: true });
  const gw = new Gateway(tor);
  gw.setUpstreams({ cj: `http://127.0.0.1:${upPort}` });
  await gw.start();
  t.after(() => { gw.stop(); socks.close(); upstream.close(); });

  // Wrong token: the path carries a per-run secret, so nothing else on the machine can use this.
  const bad = await fetch(`http://127.0.0.1:${gw.port}/deadbeef/cj/x`);
  assert.equal(bad.status, 404);
  // An unknown route is not forwarded anywhere.
  const unknown = await fetch(`http://127.0.0.1:${gw.port}/${gw.token}/somewhere-else/x`);
  assert.equal(unknown.status, 404);
  // A configured-but-empty upstream refuses rather than guessing.
  const missing = await fetch(gw.base('seq') + '/blocks');
  assert.equal(missing.status, 503);
  assert.equal(seen.length, 0, 'nothing should have reached the proxy');
});

test('an invented purpose cannot mint a new isolation domain', async (t) => {
  const seen = [];
  const socks = fakeSocks(seen);
  const socksPort = await listen(socks);
  const upstream = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
  const upPort = await listen(upstream);

  const tor = new Tor();
  tor.configure({ socksHost: '127.0.0.1', socksPort, enabled: true });
  const gw = new Gateway(tor);
  gw.setUpstreams({ cj: `http://127.0.0.1:${upPort}` });
  await gw.start();
  t.after(() => { gw.stop(); socks.close(); upstream.close(); });

  await fetch(gw.base('cj') + '/status', { headers: { 'x-seqognito-purpose': 'whatever-i-like' } });
  // Unknown purposes fall back to the ordinary chain circuit rather than creating one on demand: a
  // renderer bug must not be able to invent isolation domains, or to accidentally reuse the
  // input-registration circuit for output registration.
  assert.match(seen[0].user, /chain/);
});

test('with Tor switched off, requests do not go near the proxy', async (t) => {
  const seen = [];
  const socks = fakeSocks(seen);
  const socksPort = await listen(socks);
  const upstream = http.createServer((_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"direct":true}'); });
  const upPort = await listen(upstream);

  const tor = new Tor();
  tor.configure({ socksHost: '127.0.0.1', socksPort, enabled: false });
  const gw = new Gateway(tor);
  gw.setUpstreams({ seq: `http://127.0.0.1:${upPort}` });
  await gw.start();
  t.after(() => { gw.stop(); socks.close(); upstream.close(); });

  // The development escape hatch really is direct — which is exactly why the UI calls it what it is
  // and refuses to enable it quietly.
  assert.deepEqual(await (await fetch(gw.base('seq') + '/x')).json(), { direct: true });
  assert.equal(seen.length, 0);
});
