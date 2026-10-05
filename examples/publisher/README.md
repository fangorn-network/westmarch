# Publishing a file, from your own machine

This is the whole publisher surface. A folder, a price, a relay URL, and a key.

You do **not** need a clone of the app you are publishing to. That is the point
of this directory: its only dependency is `@fangorn/westmarch`, and everything
here would work identically against any Fangorn app, not just this one.

```
examples/publisher/
  package.json      one dependency
  lib/rain.wav      the thing being sold
  lib/rain.wav.txt  what it is — a sidecar, see "Descriptions" below
```

## Setup

```sh
pnpm install
export PUBLISHER_PRIVATE_KEY=0x…        # env only, never argv — `ps` shows argv
```

The key is your identity as a publisher. It signs the sign-in, the rights
attestation, the `createResource` transactions and the `commitStateRoot`. It
owns everything you publish.

## Am I set up?

Free. Sends nothing, signs nothing on-chain, costs no gas:

```sh
npx westmarch-publish <relay> --setup
```

```
signed in as 0x147c…5Ef6 — publishing to http://localhost:8787 as "sond3r"
SETUP {"address":"0x147c…5Ef6","ns":"sond3r","registered":true,"acceptedTerms":true,
       "workerUrl":"https://fangorn-access-worker…workers.dev","storage":true}
```

The last line is one JSON object so a script or an agent can parse it instead of
scraping prose. If `registered` is false it also tells you the fee and how many
transactions it would take. Add `--register` to actually send them — that costs
ETH and is irreversible, so it never happens implicitly.

## Publish

```sh
npx westmarch-publish <relay> lib/rain.wav --price=1000
```

```
signed in as 0x147c…5Ef6 — publishing to http://localhost:8787 as "sond3r"
↑ rain.wav … ok (described)
createResource 1/1 — rain.wav
relay pins on its own account — no storage gate to authorize against
commitStateRoot…
published — 5 vertices, 2 edges
  supercuts/the-coleman-file.mp4  0x737d74ca…522dfa97
  rain.wav                        0x5d672c6e…9f4460f5
```

One thing about that output surprises people:

**It lists files you did not just publish.** A publish is a SNAPSHOT of your
whole library, not a diff — one `commitStateRoot` re-states everything you have.
That is why bulk ingest is cheap, and it is also why deleting a file is just
leaving it out of the next one.

That resourceId is the file's permanent identity, and the R2 key its first
ciphertext chunk lives under. Apps usually also expose it as a permalink —
sond3r serves `/c/<resourceId>` — but that part is the app's convention, not
this tool's.

`--price` is in USDC **base units**: 6 decimals, so `1000` is $0.001 and
`1000000` is $1.00.

### What happened to your bytes

The file was encrypted **on this machine**, chunk by chunk, under a fresh
AES-256-GCM key sealed to the access worker's public key. Only ciphertext left
the room. The relay never had the file, and no step of this can be done for you
by someone else — which is the reason this is a CLI and not a web form.

You can check that yourself:

```sh
curl -s https://<worker>/ct/0x5d672c6e…9f4460f5 | head -c 64 | xxd
```

## Descriptions

A description is the highest-signal thing a file carries. For an image it is the
*only* thing — nothing in a JPEG's bytes says what it is, and a vector built from
`IMG_4471.jpg` ranks about as well as the filename does.

So `lib/rain.wav.txt` is picked up automatically as the description of
`lib/rain.wav`. A `.txt` **next to a file it names** is a caption and is never
published as its own product; a `.txt` with nothing beside it is a document, and
sells like anything else. Use `--desc="…"` to describe a whole run at once.

## Publishing without selling

```sh
npx westmarch-publish <relay> ./big-archive --catalog-only
```

Committed to the graph and searchable, but never encrypted, uploaded or minted.
One `commitStateRoot` covers a graph of any size, so bulk ingest costs one
transaction instead of one per file. That is what makes it affordable to put a
large catalogue up and price only the parts worth pricing.

## Flags

| | |
|---|---|
| `--price=N` | USDC base units per file |
| `--desc="…"` | description for every file in this run |
| `--dir=sub/folder` | stage under a folder instead of the library root |
| `--catalog-only` | free catalog entries — committed, searchable, not sold |
| `--ns=name` | app namespace. Defaults to what the relay declares — see below |
| `--register` | send the one-time registration transactions |
| `--setup` | report readiness and exit |

## Two things worth understanding

**The namespace is permanent.** `ns` is folded into every resourceId you mint.
The relay declares its own on `/api/config`, so you normally never pass `--ns`.
If you do pass it and get it wrong, you mint ids that address nobody's bytes and
read back a library that looks empty — so the CLI refuses to guess one rather
than defaulting.

**The relay must be writable.** A hosted relay serving a public catalogue runs
read-only and will refuse you by name. Publishing runs against the relay for the
app you are publishing to; deploying one is the app operator's job, not yours.

## Running one locally to try this against

From a clone of an app (e.g. sond3r), with `READ_ONLY` unset:

```sh
node --env-file=.env server/index.js       # :8787
```

Then point this directory at `http://localhost:8787`. Note this is the only step
in the whole document that needs an app's repo — and it is the *operator* who
needs it, not the publisher.
