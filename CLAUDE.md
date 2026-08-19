# Seqognito

A mixing wallet for Sequentia: Electron, Windows and Linux, everything over Tor. Read `README.md`
first — the privacy model is the product, and most of the code exists to hold one property up.

## The rule everything else serves

**The renderer has no network.** It can read local files and talk to one loopback address; anything
else is cancelled in `main.cjs`'s `onBeforeRequest` and refused again by the CSP. `gateway.cjs` is
the only component that opens a socket, and every socket it opens goes through `tor.cjs`.

If you find yourself adding a `fetch` to a remote host in `ui/`, you are about to break the wallet.
Add a route to the gateway instead.

## Layout

- `main.cjs` — window, request filter, CSP, IPC. Narrow by design: config, Tor, vault, gateway bases.
- `tor.cjs` — SOCKS5 by hand (no dependency), and the circuit table. **Requests carry a PURPOSE, and
  the purpose becomes the SOCKS username**, which is how Tor is told to use a different circuit.
- `gateway.cjs` — the loopback proxy. Four routes (`seq`, `btc`, `cj`, `sbtc`), a per-run token in
  the path, a closed set of purposes, and no header pass-through beyond content-type.
- `store.cjs` — settings, and the seed vault (scrypt + AES-256-GCM).
- `ui/` — the renderer. `chain.js` is the ONLY place a URL or a purpose is named; `mix.js` is the
  mixing engine; `seqwallet.js`/`btcwallet.js` are the two chains; `app.js` is screens.
- `ui/blindsig.js`, `ui/coinjoin-protocol.js` — **vendored from
  [seqcj](https://github.com/GracedEternalKingCabbageMan/seqcj)**, byte-identical apart from the
  header and import path. Do not edit them here; fix seqcj and re-vendor (`sync` by hand: they are
  small and the divergence risk is the point of the rule).
- `ui/btc.js` — vendored scure-btc-signer bundle, same file the browser wallet uses. Do not edit.
- `ui/pkg/` — `lwk_wasm`, untracked, produced by `npm run sync-wasm`.

## Traps

- **The renderer is a `file://` document, so it cannot `fetch` anything at all** — not even its own
  wasm. The bytes come over the bridge (`assets:wasm`). Do not "fix" this by adding a web server for
  the UI; the window does not need an origin.
- **SOCKS5 handshake reads must share one buffered reader.** Attaching a fresh `data` listener per
  field and unshifting the remainder stalls the socket, and the symptom is a connection that greets
  successfully and then hangs for ever.
- **`wollet.address()` returns the same unused index until it is spent.** Drawing two mix addresses
  in a row without an explicit cursor hands out one address twice, which re-links the two outputs it
  was meant to separate. `mix.js` keeps the cursor.
- **Only transparent coins can be mixed.** The coordinator refuses confidential inputs: blinding the
  round needs every input's blinders, and revealing yours would unblind that coin's whole history.
- **A coin counts as "mixed" only if this wallet mixed it.** A coin that merely looks blinded may be
  change from a payment; treating it as private would be a lie the user acts on.

## Verification bar

`npm test` for the isolation property. The mixing protocol is proven in seqcj against a real node —
do not re-prove it here with mocks. Before claiming anything works end to end, RUN THE APP
(`npm start`): a broken import in a renderer module is a silently blank panel, which is why main
forwards renderer console output in dev.

## Repository

Public. Never commit `config.json`, a vault, or private endpoints. Open a PR and merge it yourself;
there is no review process. Commit author:
`GracedEternalKingCabbageMan <151803062+GracedEternalKingCabbageMan@users.noreply.github.com>`.
