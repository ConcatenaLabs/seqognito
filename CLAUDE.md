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
  [seqcj](https://github.com/ConcatenaLabs/seqcj)**, byte-identical apart from the
  import path. Do not edit them here; fix seqcj and re-vendor (`sync` by hand: they are
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

<!-- BEGIN SHARED AGENT CONVENTIONS: identical in every Sequentia repo. Change it in all of them together. -->
## Working with git and GitHub here

These rules are the same in every Sequentia repository. They are repeated in each
one because this file is the only thing an agent is guaranteed to read, whatever
machine it is working from.

**Nothing pushed to GitHub credits Claude, Anthropic, or any AI tool.** No
`Co-Authored-By: Claude` trailer, no `Claude-Session:` trailer or `claude.ai`
link, no "Generated with Claude Code" in a commit message or a pull request body,
no `claude/*` branch names or session ids, and no mention in source, comments,
docs or issue text. Agent tooling offers several of these by default; compose the
message without them rather than stripping them afterwards.

**Author every commit as**
`GracedEternalKingCabbageMan <151803062+GracedEternalKingCabbageMan@users.noreply.github.com>`.
Never a personal address.

**Every change lands through a pull request that you merge yourself, at once.**
There is no reviewer on this project; the pull request exists so the reasoning is
recorded beside the diff. Branch, push, open it, merge it, delete the branch, all
in one sitting. Pushing straight to the default branch is the rule most often
broken here, and it is the one that costs the record. A pull request stays open
only when the repository owner asks for that specific one, and that never carries
over to the next.

**Name branches `area/short-description`**: `fix/`, `doc/`, `feature/`, `test/`,
`build/`, or the component being changed. Never a tool name, a session id, or
`worktree-*`.

**Write the subject as `area: what changed`**, one line, 72 characters at the
outside and 50 where you can manage it. Put the reasoning in the body, and
explain why rather than what.

**These repositories are public and world-readable.** Never commit private keys,
seeds, `wallet.dat`, RPC credentials, `.env` files or API tokens. Read the diff
before every commit. Secrets belong on the server and in offline backups.

**A file belongs to the repository whose code it describes.** Decide which repo
owns it before writing it; if it landed in the wrong one, move it rather than
deleting it.

**Push the same day you commit.** The testnet server pulls only from GitHub, so a
branch left on one laptop is invisible to every other machine and to the box.
<!-- END SHARED AGENT CONVENTIONS -->
