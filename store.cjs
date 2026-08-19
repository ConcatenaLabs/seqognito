// Settings, and the seed vault.
//
// The browser wallet keeps its recovery phrase in plaintext localStorage and says so. A desktop
// wallet has no excuse for that: the phrase here is encrypted with a passphrase the user chooses,
// using scrypt (memory-hard, so a stolen file is not brute-forced on a GPU farm) and AES-256-GCM
// (authenticated, so a tampered vault fails to open rather than decrypting to a subtly wrong seed).
//
// The decrypted phrase lives in memory for the session and is never written anywhere, never logged,
// and never sent through the gateway. It reaches the renderer only after an explicit unlock.

const { app } = require('electron');
const { randomBytes, scryptSync, createCipheriv, createDecipheriv, timingSafeEqual } = require('node:crypto');
const { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');

// scrypt at these parameters costs ~1s and 256 MB on a desktop. That is deliberately unpleasant for
// anyone working through a wordlist against a stolen vault, and unnoticeable once per session.
const SCRYPT = { N: 2 ** 18, r: 8, p: 1, maxmem: 512 * 1024 * 1024 };

const DEFAULTS = {
  tor: { host: '127.0.0.1', port: 9050, enabled: true },
  endpoints: {
    seq: '',        // a Sequentia Esplora/electrs URL — your own node, or someone's .onion
    btc: '',        // a Bitcoin (testnet4) Esplora URL
    cj: '',         // the seqcj coordinator
    sbtc: '',       // the SBTC peg bridge, for mixing parent-chain Bitcoin
  },
  prefs: { rotateCircuits: true, minAnonymitySet: 3 },
};

class Store {
  constructor(dir) {
    this.dir = dir || app.getPath('userData');
    mkdirSync(this.dir, { recursive: true });
    this.cfgPath = join(this.dir, 'config.json');
    this.vaultPath = join(this.dir, 'vault.json');
    this.phrase = null;                       // in memory only, for this session
  }

  config() {
    if (!existsSync(this.cfgPath)) return structuredClone(DEFAULTS);
    try {
      const raw = JSON.parse(readFileSync(this.cfgPath, 'utf8'));
      return {
        tor: { ...DEFAULTS.tor, ...(raw.tor || {}) },
        endpoints: { ...DEFAULTS.endpoints, ...(raw.endpoints || {}) },
        prefs: { ...DEFAULTS.prefs, ...(raw.prefs || {}) },
      };
    } catch { return structuredClone(DEFAULTS); }
  }

  saveConfig(next) {
    const merged = {
      tor: { ...this.config().tor, ...(next.tor || {}) },
      endpoints: { ...this.config().endpoints, ...(next.endpoints || {}) },
      prefs: { ...this.config().prefs, ...(next.prefs || {}) },
    };
    atomicWrite(this.cfgPath, JSON.stringify(merged, null, 2));
    return merged;
  }

  hasVault() { return existsSync(this.vaultPath); }

  createVault(phrase, passphrase) {
    if (!phrase || String(phrase).trim().split(/\s+/).length < 12) throw new Error('a recovery phrase of at least 12 words is required');
    if (!passphrase || String(passphrase).length < 8) throw new Error('choose a passphrase of at least 8 characters');
    const salt = randomBytes(32);
    const key = scryptSync(String(passphrase), salt, 32, SCRYPT);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(String(phrase).trim().replace(/\s+/g, ' '), 'utf8'), cipher.final()]);
    atomicWrite(this.vaultPath, JSON.stringify({
      v: 1, kdf: 'scrypt', N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
      salt: salt.toString('hex'), iv: iv.toString('hex'),
      ct: ct.toString('hex'), tag: cipher.getAuthTag().toString('hex'),
    }, null, 2));
    this.phrase = String(phrase).trim().replace(/\s+/g, ' ');
    return true;
  }

  unlock(passphrase) {
    if (!this.hasVault()) throw new Error('there is no wallet on this machine yet');
    const v = JSON.parse(readFileSync(this.vaultPath, 'utf8'));
    const key = scryptSync(String(passphrase || ''), Buffer.from(v.salt, 'hex'), 32,
      { N: v.N || SCRYPT.N, r: v.r || SCRYPT.r, p: v.p || SCRYPT.p, maxmem: SCRYPT.maxmem });
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'hex'));
    d.setAuthTag(Buffer.from(v.tag, 'hex'));
    let phrase;
    try {
      phrase = Buffer.concat([d.update(Buffer.from(v.ct, 'hex')), d.final()]).toString('utf8');
    } catch {
      // GCM authentication failed: either the passphrase is wrong or the file has been altered. Both
      // are "no", and distinguishing them for the user would also distinguish them for an attacker.
      throw new Error('that passphrase does not open this wallet');
    }
    this.phrase = phrase;
    return phrase;
  }

  lock() { this.phrase = null; }
}

function atomicWrite(path, contents) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}

module.exports = { Store, DEFAULTS };
