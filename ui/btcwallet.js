// The Bitcoin half of the wallet.
//
// Seqognito is dual-chain by construction: one recovery phrase, one BIP84 keychain, and the same
// `tb1…` address on Bitcoin and on Sequentia — the Sequentia default address is byte-identical to a
// Bitcoin one, which is why holding both from one seed is natural rather than a bolt-on.
//
// Ported, deliberately unchanged in substance, from the browser wallet: the gap-limit scan that
// keeps looking until a whole batch is empty (a fixed window makes drifted change invisible and
// therefore unspendable), the dust rule, and the fee arithmetic.

import { HDKey, mnemonicToSeedSync, btc } from './btc.js';
import { btcApi } from './chain.js';

const GAP = 20;
export const BTC_DUST = 294n;                 // P2WPKH dust threshold, sats
export const BTC_DEFAULT_FEERATE = 2;         // sat/vB on testnet4

let root = null;
let state = { balance: 0n, used: new Set(), changeNext: 0, scanLimit: GAP + 1 };

export function btcInit(phrase){
  root = HDKey.fromMasterSeed(mnemonicToSeedSync(phrase.trim().replace(/\s+/g, ' ')));
  state = { balance: 0n, used: new Set(), changeNext: 0, scanLimit: GAP + 1 };
}
export function btcNode(internal, i){ return root.derive(`m/84'/1'/0'/${internal ? 1 : 0}/${i}`); }
export function btcAddr(internal, i){ return btc.p2wpkh(btcNode(internal, i).publicKey, btc.TEST_NETWORK).address; }
export function btcState(){ return state; }

// The next unused receive index, shared with the Sequentia side by the caller so one address is
// never handed out twice across the two chains.
export function btcNextUnused(){ return state.used.size ? Math.max(...state.used) + 1 : 0; }

export async function btcScan(){
  let bal = 0n; const used = new Set(); let chgMax = -1, start = 0, scanned = GAP;
  for (let guard = 0; guard < 64; guard++){
    const jobs = [];
    for (let i = start; i < start + GAP; i++){ jobs.push(['e', i, btcAddr(false, i)]); jobs.push(['i', i, btcAddr(true, i)]); }
    const res = await Promise.all(jobs.map(([t, i, a]) => btcApi.addressInfo(a).then((d) => ({ t, i, d }))));
    let anyUsed = false;
    for (const r of res){
      if (!r.d) continue;
      const cs = r.d.chain_stats || {}, ms = r.d.mempool_stats || {};
      bal += BigInt((cs.funded_txo_sum || 0) - (cs.spent_txo_sum || 0) + (ms.funded_txo_sum || 0) - (ms.spent_txo_sum || 0));
      const tc = (cs.tx_count || 0) + (ms.tx_count || 0);
      if (tc > 0){ anyUsed = true; if (r.t === 'e') used.add(r.i); else if (r.i > chgMax) chgMax = r.i; }
    }
    start += GAP; scanned = start;
    if (!anyUsed) break;
  }
  state = { balance: bal, used, changeNext: chgMax + 1, scanLimit: scanned };
  return state;
}

async function gatherUtxos(){
  const lim = Math.max(state.scanLimit, state.changeNext + 1);
  const jobs = [];
  for (const internal of [false, true]) for (let i = 0; i < lim; i++) jobs.push([internal, i]);
  const lists = await Promise.all(jobs.map(async ([internal, i]) => {
    const node = btcNode(internal, i);
    const p = btc.p2wpkh(node.publicKey, btc.TEST_NETWORK);
    const us = await btcApi.utxos(p.address);
    return (us || []).map((u) => ({ txid: u.txid, vout: u.vout, value: BigInt(u.value), script: p.script, priv: node.privateKey }));
  }));
  return lists.flat();
}

const vbytes = (nin, nout) => Math.ceil(10.75 + 68 * nin + 31 * nout);

// Build and sign a P2WPKH payment. Returns everything the review dialog needs BEFORE anything is
// broadcast — this wallet never signs something the user has not been shown.
export async function btcBuild(outputs, feeRate = BTC_DEFAULT_FEERATE){
  const utxos = await gatherUtxos();
  if (!utxos.length) throw new Error('no spendable Bitcoin in this wallet');
  utxos.sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
  const target = outputs.reduce((s, o) => s + o.amount, 0n);
  const feeFor = (nin, nout) => BigInt(Math.ceil(vbytes(nin, nout) * feeRate));
  const sel = []; let inSum = 0n;
  for (const u of utxos){ sel.push(u); inSum += u.value; if (inSum >= target + feeFor(sel.length, outputs.length + 1)) break; }
  let fee = feeFor(sel.length, outputs.length + 1), change = inSum - target - fee, withChange = true;
  if (change < 0n) throw new Error('not enough Bitcoin for that amount plus the fee');
  if (change <= BTC_DUST){
    withChange = false;
    if (inSum - target < feeFor(sel.length, outputs.length)) throw new Error('not enough Bitcoin for that amount plus the fee');
    fee = inSum - target; change = 0n;
  }
  const tx = new btc.Transaction();
  for (const u of sel) tx.addInput({ txid: u.txid, index: u.vout, witnessUtxo: { script: u.script, amount: u.value } });
  for (const o of outputs) tx.addOutputAddress(o.address, o.amount, btc.TEST_NETWORK);
  if (withChange) tx.addOutputAddress(btcAddr(true, state.changeNext), change, btc.TEST_NETWORK);
  const seen = new Set();
  for (const u of sel){ const k = [...u.priv].join(','); if (seen.has(k)) continue; seen.add(k); tx.sign(u.priv); }
  tx.finalize();
  return { hex: tx.hex, txid: tx.id, fee, inputs: sel.length, vsize: tx.vsize, change, withChange };
}

export async function btcSend(outputs, feeRate){
  const built = await btcBuild(outputs, feeRate);
  const txid = await btcApi.broadcast(built.hex);
  // Only a successful broadcast burns a change index, so a failed build never marches the wallet
  // past its own scan window.
  if (built.withChange) state.changeNext += 1;
  return { ...built, txid };
}
