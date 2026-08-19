// Key material that never leaves this process.
//
// The wallet is dual-chain from one seed: the same BIP84 keychain signs Bitcoin transactions and
// proves ownership of Sequentia coins, because a Sequentia transparent address IS a Bitcoin one.
// `btcNodeFor` is therefore the right key for a Sequentia coin as well, which is not an accident but
// the design.
//
// The recovery phrase reaches this module once, after the vault is unlocked, and is held only in
// memory. It is never written, never logged and never sent through the gateway.

import { HDKey, mnemonicToSeedSync, sha256 } from './btc.js';

let root = null;
export function keysInit(phrase){
  root = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase.trim().replace(/\s+/g, ' ')));
}
export function btcNodeFor(chain, index){
  if (!root) throw new Error('the wallet is locked');
  return root.derive(`m/84'/1'/0'/${chain ? 1 : 0}/${index}`);
}
export { sha256 };

// DER-encode a 64-byte compact (r||s) ECDSA signature. HDKey.sign already returns a low-S signature,
// so no normalisation is needed — the coordinator verifies this with OpenSSL, which is strict about
// the encoding and not about the S value.
export function derFromCompact(sig){
  const concat = (...arrs) => { let n = 0; for (const a of arrs) n += a.length; const out = new Uint8Array(n); let o = 0; for (const a of arrs){ out.set(a, o); o += a.length; } return out; };
  const trim = (b) => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = concat(Uint8Array.of(0), b); return b; };
  const r = trim(sig.slice(0, 32)), s = trim(sig.slice(32, 64));
  const body = concat(Uint8Array.of(0x02, r.length), r, Uint8Array.of(0x02, s.length), s);
  return concat(Uint8Array.of(0x30, body.length), body);
}
