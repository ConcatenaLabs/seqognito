// The Sequentia half of the wallet, over lwk (wasm).
//
// Small on purpose. Seqognito holds, receives, sends and mixes; there is no trading, no staking, no
// issuance and no history archaeology. Anything the mixing flow does not need is a surface that can
// leak, and a surface someone has to maintain.
//
// Two Sequentia specifics that the code below depends on and that are easy to get backwards:
//
//   * addresses are TRANSPARENT by default here, and the transparent form is byte-identical to a
//     Bitcoin one. Confidentiality is opt-in, which is exactly what a mix opts into: transparent
//     coins go in, blinded coins come out.
//   * fees are payable in any accepted asset. Nothing in this wallet assumes the policy asset, and
//     a send pays its fee in the asset it moves whenever the node prices it.

import init, {
  Mnemonic, Network, Signer, Wollet, EsploraClient, Address, AssetId, Transaction,
  coinjoinSignInputs, coinjoinUnblindOutputs,
} from './pkg/lwk_wasm.js';
import { seqApi } from './chain.js';

export const wasm = { Address, AssetId, Transaction, coinjoinSignInputs, coinjoinUnblindOutputs, Mnemonic };

// wasm-bindgen's init is not idempotent, and the create-a-wallet screen needs Mnemonic before any
// wallet exists, so initialisation is a shared promise rather than a step inside seqInit.
let wasmReady = null;
export function ensureWasm(){
  if (!wasmReady) wasmReady = (async () => {
    // The bytes arrive over the bridge rather than by fetch: this page is a file:// document and
    // Chromium refuses file:// fetches, which is the correct behaviour and not worth a local web
    // server to work around.
    const bytes = await window.seqognito.assets.wasm();
    return init({ module_or_path: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) });
  })();
  return wasmReady;
}
export async function newPhrase(words = 12){ await ensureWasm(); return Mnemonic.fromRandom(words).toString(); }

let network = null, signer = null, wollet = null, client = null, descriptor = null;
let phrase = '';
let queue = Promise.resolve();

// The lwk objects are shared wasm state and a scan running against a build throws "recursive use".
// One queue for all of them, exactly as the browser wallet does.
export function withWollet(fn){
  const run = queue.then(fn, fn);
  queue = run.then(() => {}, () => {});
  return run;
}

export async function seqInit(recoveryPhrase){
  await ensureWasm();
  network = Network.sequentiaTestnet();
  phrase = recoveryPhrase.trim().replace(/\s+/g, ' ');
  signer = new Signer(new Mnemonic(phrase), network);
  descriptor = signer.wpkhSlip77Descriptor();
  wollet = new Wollet(network, descriptor);
  client = new EsploraClient(network, seqApi.base(), false, 1, false);
  return { network: network.toString(), policy: network.policyAsset().toString() };
}

export const seq = {
  network: () => network,
  policyHex: () => network.policyAsset().toString(),
  descriptor: () => descriptor,
  phrase: () => phrase,
  ready: () => !!wollet,

  scan: () => withWollet(async () => {
    const update = await client.fullScan(wollet);
    if (update) wollet.applyUpdate(update);
    return true;
  }),

  balances: () => { try { return wollet.balance().toJSON(); } catch { return {}; } },

  // The receive address. Transparent by default — that is the Sequentia address, and the same string
  // receives parent-chain Bitcoin. `confidential` is the opt-in.
  address: (index, confidential = false) => {
    const r = wollet.address(index === undefined ? undefined : index);
    const a = r.address();
    return { address: (confidential ? a : a.toUnconfidential()).toString(), index: r.index() };
  },
  nextUnusedIndex: () => { try { return wollet.address(undefined).index(); } catch { return 0; } },

  // Every coin, with the derivation coordinates a coinjoin signature needs and the one fact that
  // decides whether it can be mixed at all: whether it is explicit on chain.
  utxos: () => {
    const out = [];
    for (const u of wollet.utxos()){
      const sec = u.unblinded();
      const op = u.outpoint(), spk = u.scriptPubkey();
      const explicit = !(sec.isExplicit && !sec.isExplicit());
      out.push({
        txid: op.txid().toString(), vout: op.vout(),
        atoms: BigInt(sec.value()), asset: sec.asset().toString(),
        spkHex: (spk.toString ? spk.toString() : [...spk.bytes()].map((b) => b.toString(16).padStart(2, '0')).join('')),
        chain: (u.extInt && String(u.extInt()).toLowerCase().includes('internal')) ? 1 : 0,
        index: u.wildcardIndex(),
        explicit,
      });
    }
    return out;
  },

  // Build a send. Returned unsigned so the caller can show it before anything is signed.
  build: ({ address, asset, atoms, feeAsset }) => withWollet(() => {
    const a = new Address(address);
    if (a.isMainnet()) throw new Error('that is a mainnet address; this wallet is on testnet');
    const policy = network.policyAsset().toString();
    const id = asset === policy ? network.policyAsset() : new AssetId(asset);
    let b = network.txBuilder();
    b = a.isBlinded()
      ? (asset === policy ? b.addLbtcRecipient(a, atoms) : b.addRecipient(a, atoms, id))
      : b.addExplicitRecipient(a, atoms, id);
    if (feeAsset && feeAsset.asset && feeAsset.asset !== policy) b = b.feeAsset(new AssetId(feeAsset.asset), feeAsset.rate);
    return b.finish(wollet);
  }),

  signAndBroadcast: (pset) => withWollet(async () => {
    const finalized = wollet.finalize(signer.sign(pset));
    const txid = await client.broadcast(finalized);
    try { wollet.applyTransaction(finalized); } catch {}    // so the next build cannot re-select a spent coin
    return String(txid);
  }),

  broadcastRaw: async (hex) => {
    const txid = await seqApi.broadcast(hex);
    try { await withWollet(() => { const tx = new Transaction(hex); wollet.applyTransaction(tx); }); } catch {}
    return txid;
  },
};
