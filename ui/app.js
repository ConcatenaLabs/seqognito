// Seqognito's UI.
//
// The window is a renderer with no network of its own: everything it fetches goes to the loopback
// gateway (see chain.js), which is the only component that opens a socket and which sends every
// request through Tor. This file is therefore just screens and orchestration — if it looks like it
// is doing anything clever with the network, that is a bug.

import { initChain, cjApi } from './chain.js';
import { seqInit, seq, newPhrase } from './seqwallet.js';
import { keysInit } from './keys.js';
import { btcInit, btcScan, btcState, btcAddr, btcNextUnused, btcBuild, btcSend } from './btcwallet.js';
import { lanes, mix, mixBitcoin, history, isMixed, ledger } from './mix.js';

const API = window.seqognito;
const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const show = (id, on = true) => $(id).classList.toggle('hide', !on);

let CFG = null;
let assetNames = {};                 // asset id -> ticker, learned from the round labels we are shown
let confidentialReceive = false;
let recvIndex = null;
let pendingSend = null;

// ---- formatting --------------------------------------------------------------
// Amounts are BigInt atoms everywhere and only become strings here. Sequentia amounts are 8dp on the
// wire whatever an asset's display precision, so 8 is the honest default for a wallet that does not
// carry an asset registry.
function fmt(atoms, dp = 8){
  let a = BigInt(atoms); const neg = a < 0n; if (neg) a = -a;
  const s = a.toString().padStart(dp + 1, '0');
  const whole = s.slice(0, -dp) || '0';
  const frac = dp ? s.slice(-dp).replace(/0+$/, '') : '';
  return (neg ? '-' : '') + whole + (frac ? '.' + frac : '');
}
function parseAmount(str, dp = 8){
  const m = /^(\d+)(?:\.(\d{0,8}))?$/.exec(String(str || '').trim());
  if (!m) throw new Error('that is not an amount');
  return BigInt(m[1]) * 10n ** BigInt(dp) + BigInt((m[2] || '').padEnd(dp, '0') || '0');
}
const ticker = (hex) => assetNames[hex] || (hex === 'btc' ? 'BTC' : (hex ? hex.slice(0, 8) + '…' : '?'));
const short = (s, n = 18) => (String(s).length > n ? String(s).slice(0, n) + '…' : String(s));

// ---- boot --------------------------------------------------------------------
async function boot(){
  await initChain();
  CFG = await API.config.get();
  await refreshTorPill();
  const v = await API.vault.status();
  if (!v.exists){
    $('lockIntro').textContent = 'A mixing wallet for Sequentia. Everything it does goes over Tor.';
    show('lockUnlock', false); show('lockNew', true);
  }
}

async function refreshTorPill(){
  const p = await API.tor.probe();
  const dot = $('torDot'), text = $('torText');
  if (p.disabled){ dot.className = 'dot warn'; text.textContent = 'Tor off'; return p; }
  dot.className = 'dot ' + (p.ok ? 'on' : 'off');
  text.textContent = p.ok ? 'Tor ' + p.socks : 'no Tor';
  return p;
}

// ---- unlock / create ---------------------------------------------------------
$('lockGo').onclick = async () => {
  const st = $('lockStatus'); st.className = 'status'; st.textContent = 'Unlocking…';
  try {
    const phrase = await API.vault.unlock($('lockPass').value);
    $('lockPass').value = '';
    await openWallet(phrase);
  } catch (e){ st.className = 'status err'; st.textContent = String(e.message || e); }
};
$('lockPass').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('lockGo').click(); });

let restoring = false;
$('newCreate').onclick = async () => {
  restoring = false;
  show('veilNew', true); show('restoreBox', false);
  $('newTitle').textContent = 'Your recovery phrase';
  $('newSub').textContent = 'Twelve words. They are the wallet: anyone who has them has the coins, and nobody can give them back to you. Write them down on paper, off this machine.';
  const words = (await newPhrase(12)).split(/\s+/);
  const box = $('newWords'); box.innerHTML = ''; box.classList.remove('hide');
  words.forEach((w, i) => { const d = el('div'); d.appendChild(el('span', null, String(i + 1))); d.appendChild(document.createTextNode(w)); box.appendChild(d); });
};
$('newRestore').onclick = () => {
  restoring = true;
  show('veilNew', true); show('restoreBox', true);
  $('newWords').classList.add('hide');
  $('newTitle').textContent = 'Restore a wallet';
  $('newSub').textContent = 'Type the twelve words. Everything else — coins, mixes, addresses — comes back from them.';
};
$('newCancel').onclick = () => show('veilNew', false);
$('newSave').onclick = async () => {
  const st = $('newStatus'); st.className = 'status';
  const phrase = restoring ? $('restoreWords').value.trim() : [...$('newWords').children].map((d) => d.lastChild.textContent).join(' ');
  const p1 = $('newPass').value, p2 = $('newPass2').value;
  if (p1 !== p2){ st.className = 'status err'; st.textContent = 'those passphrases do not match'; return; }
  st.textContent = 'Encrypting…';
  try {
    await API.vault.create(phrase, p1);
    $('newPass').value = $('newPass2').value = $('restoreWords').value = '';
    show('veilNew', false);
    await openWallet(phrase);
  } catch (e){ st.className = 'status err'; st.textContent = String(e.message || e); }
};

async function openWallet(phrase){
  const need = !CFG.endpoints.seq || !CFG.endpoints.btc;
  keysInit(phrase);
  btcInit(phrase);
  if (need){ show('veilLock', false); renderSetup(); show('veilSetup', true); return; }
  await seqInit(phrase);
  show('veilLock', false); show('veilSetup', false); show('shell', true);
  await sync();
}

$('btnLock').onclick = async () => { await API.vault.lock(); location.reload(); };

// ---- connection setup --------------------------------------------------------
const FIELDS = [
  ['seq', 'Sequentia Esplora', 'http://…onion/api — your own node, ideally'],
  ['btc', 'Bitcoin (testnet4) Esplora', 'http://…onion/api'],
  ['cj', 'CoinJoin coordinator', 'http://…onion'],
  ['sbtc', 'Bitcoin peg bridge (optional)', 'only needed to mix parent-chain BTC'],
];
function connectionFields(container){
  container.innerHTML = '';
  for (const [key, label, hint] of FIELDS){
    const l = el('label', 'lbl', label); container.appendChild(l);
    const i = el('input'); i.id = 'ep-' + key + '-' + container.id; i.value = CFG.endpoints[key] || ''; i.placeholder = hint;
    container.appendChild(i);
    container.appendChild(el('p', 'sub', hint));
  }
  const l = el('label', 'lbl', 'Tor SOCKS port'); container.appendChild(l);
  const row = el('div', 'row');
  const host = el('input'); host.id = 'tor-host-' + container.id; host.value = CFG.tor.host; host.style.flex = '2 1 160px';
  const port = el('input'); port.id = 'tor-port-' + container.id; port.value = String(CFG.tor.port); port.style.flex = '1 1 90px';
  row.appendChild(host); row.appendChild(port); container.appendChild(row);
  container.appendChild(el('p', 'sub', 'Tor Browser listens on 9150; a system tor daemon on 9050. Circuit isolation — the thing that keeps your coins and your mixed addresses apart — comes from Tor itself, so there is no substitute for it.'));
  const tl = el('label', 'lbl', 'Route everything over Tor'); tl.style.marginTop = '12px'; container.appendChild(tl);
  const sel = el('select'); sel.id = 'tor-enabled-' + container.id;
  for (const [v, t] of [['1', 'Yes — required'], ['0', 'No (development only: your IP is exposed)']]){
    const o = el('option', null, t); o.value = v; sel.appendChild(o);
  }
  sel.value = CFG.tor.enabled ? '1' : '0';
  container.appendChild(sel);
}
function readConnectionFields(container){
  const endpoints = {};
  for (const [key] of FIELDS) endpoints[key] = $('ep-' + key + '-' + container.id).value.trim();
  return {
    endpoints,
    tor: {
      host: $('tor-host-' + container.id).value.trim() || '127.0.0.1',
      port: Number($('tor-port-' + container.id).value) || 9050,
      enabled: $('tor-enabled-' + container.id).value === '1',
    },
  };
}
function renderSetup(){ connectionFields($('setupFields')); }
$('setupProbe').onclick = async () => {
  const p = await refreshTorPill();
  $('setupStatus').className = 'status' + (p.ok ? ' ok' : ' err');
  $('setupStatus').textContent = p.ok ? 'Tor is answering on ' + p.socks : (p.disabled ? 'Tor is switched off for this wallet.' : 'No Tor: ' + (p.error || 'nothing is listening'));
};
$('setupSave').onclick = async () => {
  const st = $('setupStatus'); st.className = 'status';
  const next = readConnectionFields($('setupFields'));
  if (!next.endpoints.seq || !next.endpoints.btc){ st.className = 'status err'; st.textContent = 'a Sequentia and a Bitcoin endpoint are both needed'; return; }
  if (next.tor.enabled){
    const p = await API.tor.probe();
    if (!p.ok){ st.className = 'status err'; st.textContent = 'Tor is not reachable, and this wallet will not send anything without it. Start Tor, or turn the requirement off for development.'; return; }
  }
  CFG = await API.config.save(next);
  await initChain();
  st.textContent = 'Connecting…';
  try {
    await seqInit(await API.vault.phrase());
    show('veilSetup', false); show('shell', true);
    await sync();
  } catch (e){ st.className = 'status err'; st.textContent = String(e.message || e); }
};

// ---- navigation --------------------------------------------------------------
document.querySelectorAll('nav button[data-page]').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('nav button[data-page]').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('section[data-page]').forEach((s) => s.classList.toggle('hide', s.dataset.page !== b.dataset.page));
    if (b.dataset.page === 'receive') renderReceive();
    if (b.dataset.page === 'mix') renderMix();
    if (b.dataset.page === 'network') renderNet();
    if (b.dataset.page === 'settings') renderSettings();
    if (b.dataset.page === 'send') renderSendAssets();
  };
});

// ---- sync + balance ----------------------------------------------------------
async function sync(){
  const st = $('balStatus'); st.className = 'status'; st.textContent = 'Scanning over Tor…';
  try {
    await Promise.all([seq.scan(), btcScan()]);
    renderBalance();
    st.textContent = 'Up to date.';
  } catch (e){ st.className = 'status err'; st.textContent = 'Scan failed: ' + String(e.message || e); }
}
$('btnSync').onclick = sync;

function renderBalance(){
  const box = $('balList'); box.innerHTML = '';
  const rows = [];
  rows.push(['BTC', fmt(btcState().balance) + ' BTC']);
  const b = seq.balances();
  for (const [hex, atoms] of Object.entries(b)) rows.push([ticker(hex), fmt(atoms) + ' ' + ticker(hex)]);
  for (const [k, v] of rows){
    const d = el('div', 'kv'); d.appendChild(el('span', 'k', k)); d.appendChild(el('span', 'v', v)); box.appendChild(d);
  }
  const coins = $('coinList'); coins.innerHTML = '';
  const utxos = seq.utxos();
  if (!utxos.length){ coins.appendChild(el('p', 'sub', 'No Sequentia coins yet.')); return; }
  const t = el('table');
  const head = el('tr');
  for (const h of ['Asset', 'Amount', 'Coin', 'State']) head.appendChild(el('th', null, h));
  t.appendChild(head);
  for (const u of utxos){
    const tr = el('tr');
    tr.appendChild(el('td', null, ticker(u.asset)));
    tr.appendChild(el('td', null, fmt(u.atoms)));
    const c = el('td'); c.appendChild(el('span', 'mono', short(u.txid, 12) + ':' + u.vout)); tr.appendChild(c);
    const s = el('td');
    if (isMixed(u.txid, u.vout)) s.appendChild(el('span', 'tag mixed', 'mixed'));
    else if (!u.explicit) s.appendChild(el('span', 'tag', 'blinded'));
    else s.appendChild(el('span', 'tag', 'unmixed'));
    tr.appendChild(s);
    t.appendChild(tr);
  }
  coins.appendChild(t);
}

// ---- receive -----------------------------------------------------------------
function renderReceive(){
  if (recvIndex === null) recvIndex = seq.nextUnusedIndex();
  const a = seq.address(recvIndex, confidentialReceive);
  $('recvAddr').textContent = a.address;
  $('recvConf').textContent = confidentialReceive ? 'Show plain' : 'Show blinded';
  $('recvStatus').textContent = confidentialReceive
    ? 'A blinded address. Amounts sent here are hidden on chain, and only Sequentia assets can reach it.'
    : 'This same address receives parent-chain Bitcoin and Sequentia assets.';
}
$('recvCopy').onclick = () => API.clipboard.write($('recvAddr').textContent);
$('recvNext').onclick = () => { recvIndex = (recvIndex ?? seq.nextUnusedIndex()) + 1; renderReceive(); };
$('recvConf').onclick = () => { confidentialReceive = !confidentialReceive; renderReceive(); };

// ---- send --------------------------------------------------------------------
function renderSendAssets(){
  const sel = $('sendAsset'); sel.innerHTML = '';
  const o = el('option', null, 'BTC (parent chain)'); o.value = 'btc'; sel.appendChild(o);
  for (const hex of Object.keys(seq.balances())){
    const opt = el('option', null, ticker(hex)); opt.value = hex; sel.appendChild(opt);
  }
}
$('sendGo').onclick = async () => {
  const st = $('sendStatus'); st.className = 'status'; st.textContent = 'Building…';
  try {
    const asset = $('sendAsset').value, to = $('sendTo').value.trim();
    const atoms = parseAmount($('sendAmt').value);
    const rows = [];
    if (asset === 'btc'){
      const built = await btcBuild([{ address: to, amount: atoms }]);
      pendingSend = { kind: 'btc', to, atoms, built };
      rows.push(['Network', 'Bitcoin testnet4 — the parent chain, not a Sequentia asset']);
      rows.push(['To', to]);
      rows.push(['Amount', fmt(atoms) + ' BTC']);
      rows.push(['Fee', fmt(built.fee) + ' BTC · ' + built.vsize + ' vB']);
    } else {
      const pset = await seq.build({ address: to, asset, atoms });
      pendingSend = { kind: 'seq', to, atoms, asset, pset };
      rows.push(['Network', 'Sequentia']);
      rows.push(['To', to]);
      rows.push(['Amount', fmt(atoms) + ' ' + ticker(asset)]);
    }
    const spendsMixed = seq.utxos().some((u) => isMixed(u.txid, u.vout));
    if (asset !== 'btc' && spendsMixed) rows.push(['Note', 'This wallet holds mixed coins. A payment that spends one tells the recipient which mixed coin is yours.']);
    const box = $('sendReviewRows'); box.innerHTML = '';
    for (const [k, v] of rows){ const d = el('div', 'kv'); d.appendChild(el('span', 'k', k)); d.appendChild(el('span', 'v', v)); box.appendChild(d); }
    show('sendReview', true);
    st.textContent = 'Check it, then confirm.';
  } catch (e){ st.className = 'status err'; st.textContent = String(e.message || e); }
};
$('sendCancel').onclick = () => { pendingSend = null; show('sendReview', false); };
$('sendConfirm').onclick = async () => {
  const st = $('sendStatus'); st.className = 'status'; st.textContent = 'Signing and broadcasting…';
  try {
    let txid;
    if (pendingSend.kind === 'btc') txid = (await btcSend([{ address: pendingSend.to, amount: pendingSend.atoms }])).txid;
    else txid = await seq.signAndBroadcast(pendingSend.pset);
    pendingSend = null; show('sendReview', false);
    st.className = 'status ok'; st.textContent = 'Sent: ' + txid;
    await sync();
  } catch (e){ st.className = 'status err'; st.textContent = String(e.message || e); }
};

// ---- mix ---------------------------------------------------------------------
let mixLanes = [];
let mixing = false;

const STEPS = [
  ['selecting', 'Choosing coins'],
  ['registering-inputs', 'Registering coins (circuit one)'],
  ['registering-outputs', 'Registering mixed addresses (circuit two)'],
  ['verifying', 'Checking the round pays what it promised'],
  ['signing', 'Signing my own coins'],
  ['signed', 'Waiting for the other participants'],
  ['done', 'Broadcast'],
];
function timeline(active){
  const ol = $('mixTimeline'); ol.innerHTML = '';
  const idx = STEPS.findIndex(([k]) => k === active);
  STEPS.forEach(([key, label], i) => {
    const li = el('li', i < idx ? 'done' : (i === idx ? 'now' : ''));
    li.appendChild(el('span', 'bullet'));
    li.appendChild(el('span', null, label));
    ol.appendChild(li);
  });
}

async function renderMix(){
  $('mixHistory').innerHTML = '';
  const h = history();
  if (!h.length) $('mixHistory').appendChild(el('p', 'sub', 'None yet.'));
  for (const r of h){
    const d = el('div', 'kv');
    d.appendChild(el('span', 'k', new Date(r.at).toLocaleString()));
    d.appendChild(el('span', 'v', `${r.denominations} × ${fmt(r.denom_atoms)} ${ticker(r.asset)} · ${short(r.txid, 16)}`));
    $('mixHistory').appendChild(d);
  }
  try {
    const st = await cjApi.status();
    mixLanes = await lanes();
    for (const l of mixLanes) if (l.label && !assetNames[l.asset]) assetNames[l.asset] = String(l.label).split(' ')[0];
    const box = $('mixLanes'); box.innerHTML = '';
    if (!mixLanes.length) box.appendChild(el('p', 'sub', 'No round is open for registration right now. They open continuously; try again in a moment.'));
    const sel = $('mixLane'); sel.innerHTML = '';
    mixLanes.forEach((l, i) => {
      const d = el('div', 'kv');
      d.appendChild(el('span', 'k', l.label));
      d.appendChild(el('span', 'v', `${fmt(l.denom)} per denomination · ${l.participants} waiting · closes in ${Math.round(l.deadlineMs / 1000)}s`));
      box.appendChild(d);
      const o = el('option', null, `${l.label} — ${fmt(l.denom)} each`); o.value = String(i); sel.appendChild(o);
    });
    show('mixPlanCard', mixLanes.length > 0);
    show('mixBtcCard', !!(st.btc && st.btc.lane_asset && mixLanes.some((l) => l.asset === st.btc.lane_asset) && CFG.endpoints.sbtc));
    plan();
  } catch (e){
    $('mixLanes').innerHTML = '';
    $('mixLanes').appendChild(el('p', 'sub', 'No coordinator reachable: ' + String(e.message || e)));
    show('mixPlanCard', false); show('mixBtcCard', false);
  }
}
$('mixRefresh').onclick = renderMix;
$('mixRotate').onclick = async () => {
  await API.tor.rotate('cj-input'); await API.tor.rotate('cj-output');
  $('mixStatus').className = 'status ok';
  $('mixStatus').textContent = 'Both circuits discarded. The next round starts from two fresh ones.';
};
$('mixLane').onchange = plan;
$('mixCount').oninput = plan;

function plan(){
  const lane = mixLanes[Number($('mixLane').value) || 0];
  if (!lane){ $('mixPlan').textContent = ''; return; }
  const k = Math.max(1, Math.floor(Number($('mixCount').value) || 1));
  const held = seq.utxos().filter((u) => u.asset === lane.asset && u.explicit && !isMixed(u.txid, u.vout)).reduce((s, u) => s + u.atoms, 0n);
  const cost = BigInt(k) * (lane.denom + lane.coordFee);
  const bits = [`${k} × ${fmt(lane.denom)} ${ticker(lane.asset)}`];
  bits.push(lane.coordFee > 0n ? `coordination fee ${fmt(BigInt(k) * lane.coordFee)}` : 'no coordination fee');
  bits.push(`${fmt(held)} unmixed available`);
  // The network fee is absent on purpose: the coordinator pays it, in its own fee asset, so mixing
  // one asset never requires holding another.
  if (cost > held) bits.push('— not enough; lower the count');
  else bits.push(`change ${fmt(held - cost)} comes back blinded`);
  $('mixPlan').textContent = bits.join(' · ');
  $('mixGo').disabled = mixing || cost > held;
}

$('mixGo').onclick = async () => {
  if (mixing) return;
  const lane = mixLanes[Number($('mixLane').value) || 0];
  const k = Math.max(1, Math.floor(Number($('mixCount').value) || 1));
  mixing = true; $('mixGo').disabled = true;
  const st = $('mixStatus'); st.className = 'status'; st.textContent = 'Starting…';
  try {
    const res = await mix({
      assetId: lane.asset, denominations: k,
      minAnonymitySet: Number(CFG.prefs.minAnonymitySet) || 3,
      rotateCircuits: !!CFG.prefs.rotateCircuits,
      onStatus: (phase, d) => { timeline(phase); st.textContent = say(phase, d); },
    });
    timeline('done');
    st.className = 'status ok';
    st.textContent = `Mixed. ${res.denominations} × ${fmt(res.denom_atoms)} in ${short(res.txid, 20)}`;
    await sync(); renderMix();
  } catch (e){
    st.className = 'status err'; st.textContent = String(e.message || e);
  } finally { mixing = false; plan(); }
};

$('mixBtcGo').onclick = async () => {
  if (mixing) return;
  const st = $('mixBtcStatus'); st.className = 'status';
  let sats;
  try { sats = parseAmount($('mixBtcAmt').value); } catch { st.className = 'status err'; st.textContent = 'Enter an amount of BTC.'; return; }
  mixing = true; $('mixBtcGo').disabled = true;
  try {
    const res = await mixBitcoin({
      sats, minAnonymitySet: Number(CFG.prefs.minAnonymitySet) || 3,
      onStatus: (phase, d) => { st.textContent = say(phase, d); },
    });
    st.className = 'status ok';
    st.textContent = 'Done. Mixed Bitcoin is on its way to ' + res.btcDest;
    await sync();
  } catch (e){ st.className = 'status err'; st.textContent = String(e.message || e); }
  finally { mixing = false; $('mixBtcGo').disabled = false; }
};

function say(phase, d = {}){
  switch (phase){
    case 'selecting': return 'Choosing coins…';
    case 'registering-inputs': return `Registering ${d.inputs} coin(s) for ${d.denominations} denomination(s) — first circuit.`;
    case 'waiting': return d.phase === 'output' ? 'Waiting for output registration to open…'
      : d.phase === 'signing' ? 'Waiting for the round transaction…' : 'Waiting for other participants…';
    case 'registering-outputs': return `Registering mixed address ${d.registered} of ${d.of} — second circuit, anonymously.`;
    case 'verifying': return 'Unblinding the round with my own key to check it pays what it promised…';
    case 'signing': return `Checks passed (${d.participants} participants). Signing my own coins…`;
    case 'signed': return 'Signed. Waiting for everyone else to sign…';
    case 'pegging-in': return 'Sending Bitcoin to the bridge…';
    case 'waiting-for-peg-in': return 'Waiting for the bridge to credit SBTC — Bitcoin confirmations take their time.';
    case 'pegged-in': return 'Credited. Joining a round…';
    case 'pegging-out': return 'Sending the mixed coins back through the bridge…';
    case 'pegged-out': return 'Bitcoin sent to a fresh address of yours.';
    default: return phase;
  }
}

// ---- network -----------------------------------------------------------------
async function renderNet(){
  const box = $('netLog'); box.innerHTML = '';
  const log = await API.net.log();
  if (!log.length){ box.appendChild(el('p', 'sub', 'Nothing yet.')); return; }
  const t = el('table');
  const head = el('tr');
  for (const h of ['When', 'What', 'Circuit', 'Host', 'Result']) head.appendChild(el('th', null, h));
  t.appendChild(head);
  for (const r of log){
    const tr = el('tr');
    tr.appendChild(el('td', null, new Date(r.at).toLocaleTimeString()));
    tr.appendChild(el('td', null, r.kind));
    tr.appendChild(el('td', null, r.purpose));
    const h = el('td'); h.appendChild(el('span', 'mono', r.host)); tr.appendChild(h);
    tr.appendChild(el('td', null, r.error ? r.error : String(r.status)));
    t.appendChild(tr);
  }
  box.appendChild(t);
}
$('netRefresh').onclick = renderNet;

// ---- settings ----------------------------------------------------------------
function renderSettings(){
  connectionFields($('settingsFields'));
  $('setMinAnon').value = String(CFG.prefs.minAnonymitySet ?? 3);
  $('phraseBox').textContent = '';
}
$('settingsSave').onclick = async () => {
  const next = readConnectionFields($('settingsFields'));
  next.prefs = { ...CFG.prefs, minAnonymitySet: Math.max(2, Number($('setMinAnon').value) || 3) };
  CFG = await API.config.save(next);
  await initChain();
  await refreshTorPill();
  $('settingsStatus').className = 'status ok';
  $('settingsStatus').textContent = 'Saved.';
};
$('settingsProbe').onclick = async () => {
  const p = await refreshTorPill();
  $('settingsStatus').className = 'status' + (p.ok ? ' ok' : ' err');
  $('settingsStatus').textContent = p.ok ? 'Tor is answering on ' + p.socks : (p.disabled ? 'Tor is switched off.' : 'No Tor: ' + (p.error || 'nothing listening'));
};
$('showPhrase').onclick = async () => {
  try { $('phraseBox').textContent = await API.vault.phrase(); }
  catch (e){ $('phraseBox').textContent = String(e.message || e); }
};

// Any uncaught error in here would otherwise leave a blank panel with no explanation.
window.addEventListener('error', (e) => console.error('seqognito ui error:', e.message, e.filename, e.lineno));
window.addEventListener('unhandledrejection', (e) => console.error('seqognito ui rejection:', String(e.reason?.message || e.reason)));

boot().then(() => console.log('seqognito ui ready')).catch((e) => console.error('seqognito boot failed:', e.message));
