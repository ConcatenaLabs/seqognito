# Seqognito

A mixing wallet for Sequentia. Desktop (Electron), Windows and Linux, and everything it does goes
over Tor.

It holds Bitcoin and Sequentia assets, receives, sends, and mixes. There is no trading, no staking,
no issuance, no browser and no telemetry. Anything the mixing does not need is a surface that can
leak and a surface somebody has to maintain.

```
   your coins ──▶ [ circuit one ]  ──┐
                                     ├──▶  coordinator  ──▶  one confidential CoinJoin
   your mixed  ──▶ [ circuit two ] ──┘         (seqcj)         every output a commitment
   addresses
```

## Why a desktop application

A CoinJoin asks you to tell a coordinator two things it must not be able to connect — *these coins
are mine*, and *pay this address* — and a blind signature makes the second anonymous. One IP address
in a log file undoes all of it.

A web page cannot fix that. It has one network stack, and the page does not choose the route. This
application does: the two registrations go out over **different Tor circuits**, each rotated before
use, because Tor isolates circuits by SOCKS credentials and the gateway assigns credentials by
purpose. The coordinator sees two unrelated strangers. Round polling uses a third circuit that lasts
the whole round; it names nothing, but its timing is visible to the coordinator.

That is the whole reason Seqognito exists. The [browser
wallet](https://github.com/GracedEternalKingCabbageMan/sequentia-web-wallet) runs the identical
protocol and says plainly that it cannot do this.

## Why on Sequentia

On Bitcoin a CoinJoin is only as private as its equal, public denominations. Unequal outputs get
re-linked by subset-sum arithmetic, and the change output is a permanent tag pointing back at you.

Sequentia has Confidential Transactions, so every output of the round is a Pedersen commitment with
a range proof. The chain sees a transaction and not one amount in it. Your change is blinded exactly
like your mixed coins and, to an observer, is indistinguishable from them. Rounds are still
fixed-denomination — that is what makes the blind-signature credential sound — but only the
coordinator ever learns the number.

Bitcoin itself is mixed by pegging to SBTC, mixing, and pegging back out to a fresh address. SBTC
is a custody peg run by sbtc-bridge, not Elements' consensus peg. Be clear-eyed about that: the
bridge is a custodian while your coins are pegged, and it sees the Bitcoin going in and the Bitcoin
coming out. What the round removes is its ability to pair them.

## What is guaranteed, and by what

| Claim | Enforced by |
|---|---|
| The window never reaches the network directly | `main.cjs` cancels every request that is not a local file or the loopback gateway, and a CSP refuses it again |
| Everything leaves through Tor | `gateway.cjs` is the only component that opens a socket; it calls `tor.cjs` for all of them |
| Coins and mixed addresses use different circuits | the purpose of a request becomes the SOCKS username (`test/gateway.test.mjs` proves it) |
| Hostnames are never resolved locally | SOCKS5 CONNECT sends the name to the proxy — which is also what makes `.onion` work |
| The seed is not readable from the disk | scrypt (N=2¹⁸) + AES-256-GCM, `store.cjs` |
| The round pays what it promised | `verifyRoundOutputs`, vendored from [seqcj](https://github.com/GracedEternalKingCabbageMan/seqcj) and tested there |

And what is **not** guaranteed: your anonymity set is the round you were in. A round with two people
in it has an anonymity set of two, whatever else is true. The wallet lets you set a floor and walks
away below it, at the last moment, after the round is final.

## Running it

You need a Tor SOCKS proxy — a system `tor` daemon (port 9050) or Tor Browser (9150) — and Esplora
endpoints for Sequentia and Bitcoin testnet4. Your own node behind an `.onion` is the point;
somebody else's is a choice you are making.

To build: Node 22 (what CI uses), Rust stable with the `wasm32-unknown-unknown` target, and
`wasm-pack`.

```sh
npm install
npm run sync-wasm        # copies the lwk_wasm build from ../SWK (see below)
npm start
```

`ui/pkg/` is the `lwk_wasm` package and is not tracked — it is built from
[SWK](https://github.com/GracedEternalKingCabbageMan/SWK):

```sh
git clone -b sequentia https://github.com/GracedEternalKingCabbageMan/SWK.git ../SWK
cd ../SWK/lwk_wasm && wasm-pack build --target web --release && cd -
npm run sync-wasm
```

`ui/pkg/` must be a copy, not a symlink: the packager follows its file list, not links, and the
symptom is a blank window.

Settings has a "Route everything over Tor" switch, on by default. Off is a development escape hatch
for a local regtest, and the wallet says so; nothing in the table above holds while it is off.

Packaging:

```sh
npm run dist:linux       # AppImage + deb — verified: 117 MB AppImage, boots
npm run dist:win         # NSIS installer + zip
```

`dist:win` **must run on Windows, or on Linux with wine installed** — electron-builder rewrites the
executable's resources, and without wine it stops with `wine is required`. Cross-built installers
that nobody has run are worth little anyway, so the real home for it is CI:

```sh
gh workflow run build.yml        # or push a v* tag
```

`.github/workflows/build.yml` runs the tests, then builds on an Ubuntu runner and a Windows runner,
compiling `lwk_wasm` from SWK first — so a green run proves the whole chain, Rust to wasm to
installer, rather than only the JavaScript. It produces:

| | |
|---|---|
| `Seqognito-<version>-win-x64.exe` | NSIS installer, choose-your-directory, per-user |
| `Seqognito-<version>-win-x64.zip` | portable |
| `Seqognito-<version>-linux-x86_64.AppImage` | |
| `Seqognito-<version>-linux-amd64.deb` | |

## Tests

```sh
npm test
```

`test/gateway.test.mjs` stands up a real SOCKS5 server and asserts the property the whole application
rests on: input registration and output registration arrive with different credentials, rotation
changes them, an invented purpose cannot mint a new isolation domain, and the gateway is not an open
proxy.

The mixing protocol itself is tested in the seqcj repo, against a real node — including a run where
the participant is driven through the same wasm calls this wallet makes.

## Repository

Public, MIT. Never commit a `config.json`, a vault, or endpoints you would not publish. Commits are
authored as
`GracedEternalKingCabbageMan <151803062+GracedEternalKingCabbageMan@users.noreply.github.com>`.
