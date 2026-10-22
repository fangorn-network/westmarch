# A Fangorn app

This repo holds the app's recipe, not its data: what a record is (`app.json`), what a good
answer looks like (`eval/`), and how to ship it (`ci/`). It can be public. The data lives
on chain and IPFS, committed by the app's publishers; the Worker indexes it every 5
minutes, and serves the site, the view, `/mcp` and the agent card.

## Set up (testnet, your own Cloudflare)

1. Edit `app.json`: `app` (the name you claim, globally unique), `name`, `description`,
   `site.project` (the Worker's name), and the type: rename `my-app.item.v1` and map your
   fields in `role_map`.
2. Add repo secrets (Settings → Secrets and variables → Actions):
   - `ETH_PRIVATE_KEY`: a Base Sepolia wallet with test ETH; it claims and owns the app
   - `PINATA_JWT`, and the variable `PINATA_GATEWAY`
   - `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers", plus R2 and Workers AI) and `CLOUDFLARE_ACCOUNT_ID`
3. Push `app.json` to `main`. The `ship` workflow claims the app, deploys the Worker and
   binds its agent, then commits `.ship/state.json` back. Ship again whenever `app.json` changes.

## Publish data

Any member of the app commits records of its type, from anywhere:

```sh
echo '{"records":[{"id":"first","type":"my-app.item.v1","payload":{"id":"first","title":"Hello","text":"The first item.","tags":["demo"]}}]}' > items.json
fangorn --app my-app repo init items
fangorn --app my-app commit items.json -m "first items"
fangorn --app my-app push
```

The view picks it up within 5 minutes at `<url>/view`. A source that crawls something
on a schedule goes in `app.json` `sources`; see westmarch's docs.

## Keep it good

Write `eval/goals.md` (who it serves) and `eval/golden.jsonl` (one check per line:
`{"id","q","expect","min","goal"}`). The workflow grades the live view daily, and the run
goes red when a check fails. `ci/ship.sh` runs the same steps on any CI or a laptop.
