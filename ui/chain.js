// Chain access, and the only place the renderer names a URL.
//
// The window has no route to the internet: every base here is a loopback address served by the main
// process's gateway, which forwards over Tor. The `purpose` argument is not decoration — it becomes
// the Tor SOCKS credential upstream, so two requests with different purposes leave over different
// circuits. Getting that wrong is the difference between a mix and a mix that a coordinator can undo
// by reading its own access log.

let BASES = { seq: '', btc: '', cj: '', sbtc: '' };

export async function initChain(){
  BASES = await window.seqognito.net.bases();
  return BASES;
}
export function bases(){ return BASES; }

// A raw fetch through the gateway. `purpose` must be one the gateway knows ('chain', 'cj-input',
// 'cj-output', 'cj-poll', 'peg'); anything else is silently downgraded to 'chain' upstream, which
// would be a privacy bug rather than an error, so the callers below never pass a free-form string.
export function gwFetch(kind, path, { method = 'GET', body, purpose = 'chain', headers = {} } = {}){
  const base = BASES[kind];
  if (!base) return Promise.reject(new Error(`no ${kind} endpoint is configured`));
  return fetch(base + path, {
    method,
    headers: { 'x-seqognito-purpose': purpose, ...headers },
    body,
    cache: 'no-store',
  });
}

async function json(kind, path, opts){
  const res = await gwFetch(kind, path, opts);
  const txt = await res.text();
  let j; try { j = txt ? JSON.parse(txt) : {}; } catch { j = { ok: false, error: txt || 'bad json' }; }
  if (!res.ok || j.ok === false) throw new Error(j.error || `${kind} HTTP ${res.status}`);
  return j;
}

// ---- Bitcoin (Esplora) ------------------------------------------------------
export const btcApi = {
  addressInfo: (a) => json('btc', `/address/${a}`).catch(() => null),
  utxos: (a) => json('btc', `/address/${a}/utxo`).catch(() => []),
  broadcast: async (hex) => {
    const res = await gwFetch('btc', '/tx', { method: 'POST', body: hex, headers: { 'content-type': 'text/plain' } });
    const txt = (await res.text()).trim();
    if (!res.ok) throw new Error('Bitcoin broadcast refused: ' + txt);
    return txt;
  },
  tx: (txid) => json('btc', `/tx/${txid}`),
};

// ---- Sequentia (Esplora, plus lwk's own client) ------------------------------
export const seqApi = {
  base: () => BASES.seq,
  tx: (txid) => json('seq', `/tx/${txid}`),
  broadcast: async (hex) => {
    const res = await gwFetch('seq', '/tx', { method: 'POST', body: hex, headers: { 'content-type': 'text/plain' } });
    const txt = (await res.text()).trim();
    if (!res.ok) throw new Error('Sequentia broadcast refused: ' + txt);
    return txt;
  },
};

// ---- the coordinator ---------------------------------------------------------
// The two registration phases are deliberately given different purposes. This is the single most
// important line in the application: it is what a browser cannot do.
export const cjApi = {
  status: () => json('cj', '/status', { purpose: 'cj-poll' }),
  rounds: () => json('cj', '/rounds', { purpose: 'cj-poll' }),
  round: (id) => json('cj', '/round/' + id, { purpose: 'cj-poll' }),
  registerInput: (body) => json('cj', '/register-input', { method: 'POST', body: JSON.stringify(body), purpose: 'cj-input', headers: { 'content-type': 'application/json' } }),
  registerOutput: (body) => json('cj', '/register-output', { method: 'POST', body: JSON.stringify(body), purpose: 'cj-output', headers: { 'content-type': 'application/json' } }),
  sign: (body) => json('cj', '/sign', { method: 'POST', body: JSON.stringify(body), purpose: 'cj-input', headers: { 'content-type': 'application/json' } }),
};

// ---- the SBTC peg bridge -----------------------------------------------------
export const pegApi = {
  pegIn: (seqRecipient) => json('sbtc', '/pegin', { method: 'POST', body: JSON.stringify({ seq_recipient: seqRecipient }), purpose: 'peg', headers: { 'content-type': 'application/json' } }),
  pegOut: (btcDest) => json('sbtc', '/pegout', { method: 'POST', body: JSON.stringify({ btc_dest: btcDest }), purpose: 'peg', headers: { 'content-type': 'application/json' } }),
};
