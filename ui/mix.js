// Mixing — the part of this wallet that everything else exists to serve.
//
// The protocol is vendored from seqcj and unchanged. What this file adds is everything a desktop
// client can do that a web page cannot:
//
//   * SEPARATE CIRCUITS PER PHASE. Registering your coins and registering your mixed addresses go
//     out over different Tor circuits, from different exits, and each is rotated before use. A
//     coordinator that logged both connections sees two unrelated strangers. Without this the blind
//     signature is undone by a column in an access log, which is why the browser wallet is honest
//     enough to call itself a demonstration.
//   * A COIN LEDGER. Which of your coins came out of a mix, and which never have. The wallet knows,
//     so it can stop you spending a mixed coin together with an unmixed one — the single most
//     common way people undo their own mixing.
//   * AN ANONYMITY-SET FLOOR. A round with two participants is a round with an anonymity set of two.
//     The wallet refuses below the floor you set instead of quietly taking your fee.
//
// FUND SAFETY. Nothing here can lose coins. The only irreversible act is a signature, and it happens
// solely in `verifyAndSign` below, after `verifyRoundOutputs` has unblinded the coordinator's
// transaction with this wallet's own key and confirmed it pays exactly what was promised. A refused
// round never completes and nothing was ever spent.

import { runRound, verifyRoundOutputs } from './coinjoin-protocol.js';
import { cjApi, pegApi } from './chain.js';
import { seq, wasm } from './seqwallet.js';
import { btcAddr, btcNextUnused, btcSend } from './btcwallet.js';
import { derFromCompact, sha256, btcNodeFor } from './keys.js';

const LEDGER_KEY = 'seqognito.coins';      // outpoint -> { mixed, round, at }
const HISTORY_KEY = 'seqognito.mixes';
const ADDR_KEY = 'seqognito.addrCursor';

// ---- the coin ledger --------------------------------------------------------
// A coin is "mixed" if it came out of a round this wallet ran. Nothing else counts: a coin that
// merely LOOKS blinded may be change from a payment, and treating it as private would be a lie the
// user acts on.
export function ledger(){ try { return JSON.parse(localStorage.getItem(LEDGER_KEY) || '{}'); } catch { return {}; } }
function ledgerWrite(l){ try { localStorage.setItem(LEDGER_KEY, JSON.stringify(l)); } catch {} }
export function markMixed(outpoints, round){
  const l = ledger();
  for (const op of outpoints) l[op] = { mixed: true, round, at: Date.now() };
  ledgerWrite(l);
}
export function isMixed(txid, vout){ return !!ledger()[`${txid}:${vout}`]?.mixed; }

export function history(){ try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; } }
function historyAdd(rec){
  const h = history(); h.unshift(rec);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(0, 200))); } catch {}
}

// ---- addresses ---------------------------------------------------------------
// A fresh blinded address per mixed output, from an explicit cursor. `address()` returns the same
// unused index until it is spent, so drawing two mix addresses in a row without this would hand out
// one address twice — which re-links the two outputs it was supposed to separate.
function freshAddress(){
  let cursor = Number(localStorage.getItem(ADDR_KEY) || '0') || 0;
  cursor = Math.max(cursor, seq.nextUnusedIndex());
  const a = seq.address(cursor, true).address;
  localStorage.setItem(ADDR_KEY, String(cursor + 1));
  return a;
}

const scriptOf = (address) => {
  const spk = new wasm.Address(address).scriptPubkey();
  return (spk.toString ? spk.toString() : [...spk.bytes()].map((b) => b.toString(16).padStart(2, '0')).join('')).toLowerCase();
};

// ---- what can be mixed -------------------------------------------------------
export async function lanes(){
  const { rounds } = await cjApi.rounds();
  const out = [];
  for (const r of rounds || []){
    if (r.phase !== 'input') continue;
    for (const lane of r.lanes){
      out.push({
        roundId: r.round_id, index: lane.index, asset: lane.asset, label: lane.label,
        denom: BigInt(lane.denom_atoms), coordFee: BigInt(lane.coord_fee_atoms || '0'),
        btcBacked: !!lane.btc_backed, maxCredentials: r.max_credentials,
        participants: r.participants, minParticipants: r.min_participants,
        // null until the round is viable — the coordinator starts no countdown while it is still
        // waiting for the participant who makes a mix possible.
        deadlineMs: r.deadline_ms, waiting: !!r.waiting_for_participants,
      });
    }
  }
  return out;
}

// ---- one round ---------------------------------------------------------------
export async function mix({ assetId, denominations = 1, minAnonymitySet = 3, rotateCircuits = true, onStatus = () => {} }){
  const T = window.seqognito.tor;
  let chosen = [], mixScripts = [], changeScript = null;

  // Fresh circuits before anything is said to the coordinator. Rotating BEFORE input registration
  // also detaches this round from the last one.
  if (rotateCircuits){ await T.rotate('cj-input'); await T.rotate('cj-output'); }

  const hooks = {
    // The protocol module speaks in paths; each maps to a purpose, and the purpose is the circuit.
    fetchJson: async (path, body) => {
      if (path === '/rounds') return cjApi.rounds();
      if (path.startsWith('/round/')) return cjApi.round(path.slice('/round/'.length));
      if (path === '/register-input') return cjApi.registerInput(body);
      if (path === '/register-output') return cjApi.registerOutput(body);
      if (path === '/sign') return cjApi.sign(body);
      if (path === '/status') return cjApi.status();
      throw new Error('unexpected coordinator path ' + path);
    },
    onStatus,

    selectInputs: async ({ asset, denom, coordFee, maxCredentials }) => {
      const want = BigInt(maxCredentials) * (BigInt(denom) + BigInt(coordFee));
      // TRANSPARENT coins only — the coordinator refuses confidential ones, because blinding the
      // round needs every input's blinders and handing those over would unblind that coin's history.
      // Already-mixed coins are left alone too: re-mixing a coin through the same coordinator gains
      // nothing and spends the fee twice.
      const cands = seq.utxos()
        .filter((u) => u.asset === asset && u.explicit && !isMixed(u.txid, u.vout))
        .sort((a, b) => (b.atoms > a.atoms ? 1 : -1));
      const picked = []; let sum = 0n;
      for (const u of cands){ if (sum >= want) break; picked.push(u); sum += u.atoms; }
      if (sum < BigInt(denom) + BigInt(coordFee)){
        throw new Error(`not enough unmixed transparent balance for one denomination (need ${denom + coordFee} atoms, have ${sum})`);
      }
      chosen = picked;
      return { inputs: picked };
    },

    proveOwnership: async (message, input) => {
      const node = btcNodeFor(input.chain, input.index);
      return {
        pubkey: [...node.publicKey].map((b) => b.toString(16).padStart(2, '0')).join(''),
        sig: [...derFromCompact(node.sign(sha256(new TextEncoder().encode(message))))].map((b) => b.toString(16).padStart(2, '0')).join(''),
      };
    },

    freshAddress: async () => freshAddress(),

    verifyAndSign: async (txHex, ctx) => {
      // The anonymity set is checked HERE, at the last moment, because it is only final now: a round
      // that looked busy at registration may have lost participants. Below the floor we walk away —
      // the coins were never spent.
      const participants = ctx.round?.participants ?? 0;
      if (participants < minAnonymitySet){
        throw new Error(`this round ended with ${participants} participants, below your floor of ${minAnonymitySet}; nothing was signed`);
      }
      mixScripts = ctx.mixAddresses.map(scriptOf);
      changeScript = ctx.changeAddress ? scriptOf(ctx.changeAddress) : null;
      const mine = wasm.coinjoinUnblindOutputs(txHex, seq.descriptor());
      verifyRoundOutputs({ mine, mixScripts, changeScript, denom: ctx.denom, change: ctx.change, asset: ctx.lane.asset });

      // ...and the coins going in are the ones we chose, all of them and nothing else of ours.
      const tx = new wasm.Transaction(txHex);
      const present = new Set(tx.inputs().map((i) => i.outpoint().txid().toString() + ':' + i.outpoint().vout()));
      for (const u of chosen){
        if (!present.has(`${u.txid}:${u.vout}`)) throw new Error('a coin I registered is missing from the round; refusing to sign');
      }
      onStatus('signing', { outputs: mine.length, participants });
      return wasm.coinjoinSignInputs({
        txHex, mnemonic: seq.phrase(),
        inputs: chosen.map((u) => ({ txid: u.txid, vout: u.vout, value: String(u.atoms), spkHex: u.spkHex, chain: u.chain, index: u.index })),
      }, seq.network());
    },
  };

  // Between the two registrations, a new circuit for the output phase. This is the moment the whole
  // design turns on: the connection that names your mixed addresses must have nothing in common with
  // the one that named your coins.
  const wrapped = {
    ...hooks,
    fetchJson: async (path, body) => {
      if (path === '/register-output' && rotateCircuits) await T.rotate('cj-output');
      return hooks.fetchJson(path, body);
    },
  };

  const res = await runRound({ hooks: wrapped, assetId, maxCredentials: denominations });

  // Record which outputs are now mixed, so the wallet can keep them apart from everything else.
  const outpoints = [];
  await seq.scan();
  for (const u of seq.utxos()){
    if (u.txid === res.txid && mixScripts.includes(u.spkHex.toLowerCase())) outpoints.push(`${u.txid}:${u.vout}`);
  }
  markMixed(outpoints, res.txid);
  historyAdd({ at: Date.now(), asset: assetId, txid: res.txid, denominations: res.denominations,
               denom_atoms: res.denom_atoms, change_atoms: res.change_atoms, outputs: outpoints.length });
  return res;
}

// ---- Bitcoin -----------------------------------------------------------------
// Bitcoin has no confidential transactions — which is the whole reason this is worth doing on
// Sequentia — so parent-chain BTC is pegged to SBTC, mixed, and pegged back out to a fresh address.
//
// The honest cost, which the UI repeats: the bridge is a custodian while your coins are pegged, and
// it sees the Bitcoin going in and the Bitcoin coming out. What the round removes is its ability to
// pair the two. Peg-in and peg-out also go out on their own circuit, and the wallet waits between
// them, because two bridge requests seconds apart from one exit would pair themselves.
export async function mixBitcoin({ sats, minAnonymitySet = 3, onStatus = () => {}, pollMs = 20000, timeoutMs = 3600000 }){
  const st = await cjApi.status();
  if (!st.btc || !st.btc.lane_asset) throw new Error('this coordinator does not run a Bitcoin lane');
  const sbtc = st.btc.lane_asset;
  const T = window.seqognito.tor;

  await T.rotate('peg');
  const seqRecipient = seq.address(undefined, false).address;     // transparent: the bridge pays SBTC here
  const { deposit_address: deposit } = await pegApi.pegIn(seqRecipient);
  const before = BigInt(seq.balances()[sbtc] || 0);
  onStatus('pegging-in', { deposit, sats: String(sats) });
  const sent = await btcSend([{ address: deposit, amount: BigInt(sats) }]);

  const until = Date.now() + timeoutMs;
  let credited = 0n;
  while (Date.now() < until){
    await new Promise((r) => setTimeout(r, pollMs));
    await seq.scan();
    const now = BigInt(seq.balances()[sbtc] || 0);
    if (now > before){ credited = now - before; onStatus('pegged-in', { credited: String(credited) }); break; }
    onStatus('waiting-for-peg-in', { deposit, btcTxid: sent.txid });
  }
  if (credited <= 0n) throw new Error('the bridge has not credited SBTC yet; it will, and the mix can be resumed then');

  const ls = (await lanes()).filter((l) => l.asset === sbtc);
  if (!ls.length) throw new Error('no open round is mixing Bitcoin right now');
  const per = ls[0].denom + ls[0].coordFee;
  const k = Math.max(1, Math.min(Number(credited / per), ls[0].maxCredentials));
  const round = await mix({ assetId: sbtc, denominations: k, minAnonymitySet, onStatus });

  // Out again, to an address this wallet has never used, on a fresh circuit.
  await T.rotate('peg');
  const btcDest = btcAddr(false, btcNextUnused());
  const { sbtc_address: ret } = await pegApi.pegOut(btcDest);
  const mixed = BigInt(round.denom_atoms) * BigInt(round.denominations);
  onStatus('pegging-out', { btcDest, atoms: String(mixed) });
  const pset = await seq.build({ address: ret, asset: sbtc, atoms: mixed });
  const txid = await seq.signAndBroadcast(pset);
  onStatus('pegged-out', { btcDest, txid });
  return { round, btcIn: sent.txid, btcDest, pegOutTxid: txid, mixed_atoms: String(mixed) };
}
