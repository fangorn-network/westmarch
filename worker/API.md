# westmarch Worker API

**Version:** 0.4 · **Base URL:** `https://<app>.fangorn.network`, or any westmarch Worker deployment

Every westmarch Worker deployment serves this API. Apps differ only in their [`Config`](#config): which repos the Worker follows, on which network, what it calls itself and the record types it documents. A UI is built against this API with a base URL; no app code runs in the Worker.

The same spec as OpenAPI 3.1, for Swagger UI, Redoc or a client generator: [openapi.yaml](openapi.yaml). Keep the two in step.

## Overview

| Method | Path | Summary | Auth |
|---|---|---|---|
| `GET` | [`/api.json`](#get-apijson) | What this deployment is and how to use it | none |
| `GET` | [`/view.json`](#get-viewjson) | The whole index | none |
| `GET` | [`/search`](#get-search) | Records by meaning | none |
| `POST` | [`/publish`](#post-publish) | Publish a record into the bearer's own repo | grant |
| `POST` | [`/mcp`](#post-mcp) | MCP server: `search`, `repos`, `get`, `publish` | grant, for `publish` |

### Authentication

**grant** (`http`, scheme `bearer`): a fangorn.network grant token, as `Authorization: Bearer <token>`. A person gets one at the deployment's `connect` URL ([`Manifest`](#manifest)). It lets the app publish to the listed repos of *their* account, on their signature: fangorn.network signs each update with their wallet, and the Worker never holds their keys.

### Conventions

- **Content type.** Request and response bodies are `application/json`.
- **CORS.** Every response carries `access-control-allow-origin: *`. `POST` endpoints answer `OPTIONS` preflights and allow the `authorization`, `content-type` and `mcp-protocol-version` headers.
- **Files.** A payload's `src` is a CID in storage, served at `<gateway>/ipfs/<src>`. `payload.mime`, when present, is the file's media type. A file without `mime` is JSON.
- **Errors.** Every HTTP error body is an [`Error`](#error).

---

## Endpoints

### `GET /api.json`

What this deployment is and how to use it, so a UI needs to hard-code only the base URL. It's `/api.json` rather than `/` so that an app's static site can keep `/`.

**Parameters:** none

**Responses**

| Status | Body | Description |
|---|---|---|
| `200` | [`Manifest`](#manifest) | The deployment |

```json
{
  "name": "internet slop warehouse",
  "network": "baseSepolia",
  "gateway": "https://ipfs-test.fangorn.network",
  "repos": ["internet-slop-warehouse"],
  "types": { "game": "a self-contained HTML page", "asset": "a file, with mime" },
  "publish": true,
  "mcp": "https://internet-slop-warehouse.fangorn.network/mcp",
  "connect": "https://fangorn.network/#/connect?app=https%3A%2F%2Finternet-slop-warehouse.fangorn.network&repos=internet-slop-warehouse&name=internet+slop+warehouse&mcp=https%3A%2F%2Finternet-slop-warehouse.fangorn.network%2Fmcp"
}
```

---

### `GET /view.json`

The whole index: every record, the stitch it was built from, and the gateway.

**Parameters:** none

**Responses**

| Status | Body | Description |
|---|---|---|
| `200` | [`View`](#view) | The index |
| `404` | [`Error`](#error) | Not indexed yet: the first cron run (within a minute of deploying) hasn't finished |

---

### `GET /search`

Records ranked by meaning. The query is embedded with the same model as the rows.

**Parameters**

| Name | In | Type | Required | Description |
|---|---|---|---|---|
| `q` | query | string | no | What to look for, in your own words. Empty or missing: `[]` |
| `k` | query | integer | no | How many results. Default `10`, maximum `50` |
| `type` | query | string | no | Only rows of this type |

**Responses**

| Status | Body | Description |
|---|---|---|
| `200` | [`Hit`](#hit)`[]` | Best first |

---

### `POST /publish`

Publishes one record into the bearer's own repo. The Worker builds the commit, fangorn.network signs it with the bearer's wallet (if their grant covers the repo), and the Worker relays it and pays the gas. It answers once the record has been read back from the chain at its new `cid`.

**Security:** grant

**Request body:** [`PublishRequest`](#publishrequest)

```jsonc
{
  "repo": "internet-slop-warehouse",
  "record": {
    "id": "cubes",
    "type": "game",
    "payload": {
      "title": "Cubes",
      "parent": { "id": "cube" },
      "uses": [{ "publisher": "0xabc…", "id": "orbit" }]
    }
  },
  "file": { "json": { "html": "<!doctype html>…" } },
  "pin": ["parent", "uses"]
}
```

**Responses**

| Status | Body | Description |
|---|---|---|
| `200` | [`PublishResult`](#publishresult) | Published and read back |
| `400` | [`Error`](#error) | Malformed body, `type` not in `Config.types`, file over 5 MB, or a pinned record that doesn't exist |
| `401` | [`Error`](#error) | No bearer, or fangorn.network doesn't recognize it |
| `403` | [`Error`](#error) | The grant doesn't cover `repo`, or the app doesn't follow the bearer's `repo` |
| `404` | [`Error`](#error) | Publishing is off (`Config.publishPerDay` unset), or `repo` isn't one of the app's |
| `429` | [`Error`](#error) | Today's `Config.publishPerDay` is used up |
| `502` | [`Error`](#error) | Storage, signing or the chain failed. Safe to retry |

```json
{
  "publisher": "0x1234…",
  "repo": "internet-slop-warehouse",
  "id": "cubes",
  "type": "game",
  "cid": "bafy…",
  "src": "bafk…",
  "txHash": "0x…"
}
```

---

### `POST /mcp`

MCP over streamable HTTP, stateless: one JSON-RPC 2.0 message per POST, answered with one JSON body. Add it to a client with `claude mcp add --transport http <name> <base>/mcp`.

**Security:** grant, optional; only the `publish` tool needs it

**Request body:** one JSON-RPC message (a batch array is refused)

**Responses**

| Status | Body | Description |
|---|---|---|
| `200` | JSON-RPC response | The answer to a request. A tool's failure is a result with `isError: true` and its message as text, not a JSON-RPC error |
| `202` | empty | A notification (no `id`) |
| `400` | JSON-RPC error | Not JSON (`-32700`), or a batch (`-32600`) |
| `405` | text | Not a POST |

**Methods**

| Method | Result |
|---|---|
| `initialize` | `serverInfo.name` = `Config.name`, `instructions` = `Config.instructions` with `{gateway}` filled in, `capabilities.tools` |
| `ping` | `{}` |
| `tools/list` | the tools below |
| `tools/call` | a tool's result, as JSON text content |
| anything else | JSON-RPC error `-32601` |

#### Tool `search`

Records ranked by meaning, as [`GET /search`](#get-search). When `Config.types` is set, `type` is an enum of its keys and the description lists what each one is.

| Argument | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | What to look for, in your own words |
| `type` | string | no | Only rows of this type |
| `k` | integer | no | How many results, 1–50, default `10` |

**Result:** [`Hit`](#hit)`[]`

#### Tool `repos`

Every indexed repo.

**Arguments:** none

**Result:** `{ publisher: string, repo: string, records: integer }[]`

#### Tool `get`

One record's current version, read live from Fangorn, so it can be newer than the index.

| Argument | Type | Required | Description |
|---|---|---|---|
| `publisher` | string | yes | The publisher's 0x address |
| `repo` | string | yes | |
| `id` | string | yes | |

**Result:** [`Record`](#record)

#### Tool `publish`

As [`POST /publish`](#post-publish), through the same code path, quota and checks. Without a bearer, the error says to open the `connect` URL.

| Argument | Type | Required | Description |
|---|---|---|---|
| `repo` | string | no | As in [`PublishRequest`](#publishrequest) |
| `record` | object | yes | |
| `file` | [`File`](#file) | no | |
| `pin` | string[] | no | |

**Result:** [`PublishResult`](#publishresult)

---

## Schemas

### Config

The Worker's `CONFIG` var. In the ops repo, one `apps.json` entry per app, with `name` defaulting to the entry's key. "The app's repos" means the repo names that `follow` or `repos` cover.

| Field | Type | Required | Description |
|---|---|---|---|
| `network` | string | no | A `SupportedNetworks` key. Default `baseSepolia` |
| `follow` | string[] | one of `follow`, `repos` | `publisher/repo` patterns to follow |
| `repos` | string[] | one of `follow`, `repos` | Repo names, followed across every publisher |
| `publishers` | string[] | no | With `repos`: only these 0x addresses |
| `publishView` | string | no | Repo the view is published to on each new root |
| `publishPerDay` | integer | no | Publishes per UTC day the app pays gas for, across all publishers. Unset: publishing is off |
| `name` | string | no | Shown to agents and on the connect page |
| `instructions` | string | no | Told to agents at MCP `initialize`. `{gateway}` is replaced with the network's IPFS gateway |
| `types` | object | no | `{ "<type>": "<what a record of this type is>" }`. Documents `type` in `search` and `publish`; when set, `publish` refuses any other type |

### Manifest

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | yes | `Config.name` |
| `network` | string | yes | |
| `gateway` | string | yes | IPFS gateway base URL: files are at `<gateway>/ipfs/<src>` |
| `repos` | string[] | yes | The app's repos |
| `types` | object | yes | `Config.types`, or `{}` |
| `publish` | boolean | yes | Whether publishing is on |
| `mcp` | string | yes | This deployment's MCP URL |
| `connect` | string | when `publish` | fangorn.network's connect page for this app. It names the API's own origin as the app, never a UI's, so a grant matches the API that uses it |

### View

| Field | Type | Required | Description |
|---|---|---|---|
| `root` | string | yes | The stitch's root |
| `stitch` | string | yes | CID of the stitch the rows were built from; checkable with `verifyStitch` |
| `gateway` | string | yes | IPFS gateway base URL |
| `records` | [`Row`](#row)`[]` | yes | Every indexed record |

### Row

A record as indexed.

| Field | Type | Required | Description |
|---|---|---|---|
| `publisher` | string | yes | Lowercase 0x address |
| `repo` | string | yes | |
| `id` | string | yes | |
| `cid` | string | yes | The version indexed |
| `type` | string | yes | |
| `payload` | object | yes | The record's data. `src` and `mime` describe its file, if it has one |

### Hit

[`Row`](#row), plus:

| Field | Type | Required | Description |
|---|---|---|---|
| `score` | number | yes | Similarity to the query, higher is closer |

### Record

[`Row`](#row) read live from Fangorn, plus:

| Field | Type | Required | Description |
|---|---|---|---|
| `url` | string | when `payload.src` | `<gateway>/ipfs/<src>` |
| `file` | any | no | The file, parsed, when it's JSON (no `payload.mime`, or `application/json`) and at most 5 MB |

### Reference

A pointer to another record, resolved by `pin`.

| Field | Type | Required | Description |
|---|---|---|---|
| `publisher` | string | no | 0x address. Default: the bearer |
| `repo` | string | no | Default: the repo being published to |
| `id` | string | yes | |

### PinnedReference

A record at one version.

| Field | Type | Required | Description |
|---|---|---|---|
| `publisher` | string | yes | Lowercase 0x address |
| `repo` | string | yes | |
| `id` | string | yes | |
| `cid` | string | yes | The version that was current when it was pinned |
| `type` | string | yes | |

### File

One of:

| Variant | Fields | Stored as |
|---|---|---|
| JSON | `json`: any | JSON, without `mime` |
| Bytes | `base64`: string, `mime`: string | The decoded bytes; `mime` is set as `payload.mime` |

At most 5 MB decoded. Its CID is set as `payload.src`, overwriting any given one.

### PublishRequest

| Field | Type | Required | Description |
|---|---|---|---|
| `repo` | string | when the app has more than one repo | One of the app's repos |
| `record.id` | string | yes | Publishing an existing `id` replaces it |
| `record.type` | string | yes | One of `Config.types`' keys, when set |
| `record.payload` | object | no | |
| `file` | [`File`](#file) | no | Uploaded first |
| `pin` | string[] | no | Top-level payload keys whose values are [`Reference`](#reference)s, or arrays of them. Each is replaced by the [`PinnedReference`](#pinnedreference) to that record's current version |

### PublishResult

| Field | Type | Required | Description |
|---|---|---|---|
| `publisher` | string | yes | The bearer's address, lowercase |
| `repo` | string | yes | |
| `id` | string | yes | |
| `type` | string | yes | |
| `cid` | string | yes | The record's new version |
| `src` | string | when a `file` was sent | The file's CID |
| `txHash` | string | yes | The relayed transaction |

### Error

| Field | Type | Required | Description |
|---|---|---|---|
| `error` | string | yes | What went wrong, for a person to read |

---

## Not in this API

- **App-specific validation.** Rules beyond the above (a field's format, a file's contents agreeing with its labels) belong to the app's client side: its CLI, its agent skill, or its `instructions`. Schemas checked at `publish` may come once repos carry them.
- **Non-Fangorn endpoints.** Proxies, geocoding and the like are an app's own hosting.
- **An agent card per deployment.** The registry could list each deployment from its card, with `mcp` and `connect` taken from the manifest. Not yet.
