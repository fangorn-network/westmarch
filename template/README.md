# A Fangorn app

This repo holds the app's recipe, not its data: what a record is (`app.json`), what a good
answer looks like (`eval/`), and the Worker that serves it (`wrangler.json`). It can be
public. The data lives on chain and IPFS, committed by the app's members; the Worker
indexes it every 5 minutes, and serves the site, the view, `/mcp` and the agent card.

## Deploy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/fangorn-network/westmarch/tree/main/template)

1. Claim the app at [fangorn.network](https://fangorn.network).
2. Press the button. Name the Worker after the app (`my-app`) and its R2 bucket
   `my-app-view`. Cloudflare copies this repo into your GitHub, makes the bucket and
   deploys; every push to `main` deploys again.
3. Back at fangorn.network, give the app its Worker's URL. Your wallet registers the
   app's agent and binds its card there.

An app name with a dot or an underscore can't be a Worker name: set `"app"` in
`app.json` to the name you claimed.

`npm run build` (`westmarch build`) is what Cloudflare runs: it builds the site and writes
the app's config into `wrangler.json`, without signing or deploying anything.

## Make it yours

Edit `app.json`: `name`, `description`, and the type: rename `my-app.item.v1` and map your
fields in `role_map`. Push, and the Worker follows.

## Publish data

Any member of the app commits records of its type, from anywhere:

```sh
echo '{"records":[{"id":"first","type":"my-app.item.v1","payload":{"id":"first","title":"Hello","text":"The first item.","tags":["demo"]}}]}' > items.json
fangorn --app my-app repo init items
fangorn --app my-app commit items.json -m "first items"
fangorn --app my-app push
```

The view picks it up within 5 minutes at `<url>/view`. A source that crawls something
on a schedule goes in `app.json` `sources`, and publishes with
`npx westmarch-ship app.json --no-deploy` (the push to `main` deploys; without the flag it
would deploy a second copy over this Worker). See westmarch's docs.

## Keep it good

Write `eval/goals.md` (who it serves) and `eval/golden.jsonl` (one check per line:
`{"id","q","expect","min","goal"}`), then grade the live view:
`npx westmarch-eval <url>/view`.
