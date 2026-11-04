---
name: fangorn-index
description: Find data on Fangorn, by what it is about or by who publishes it, read it, and buy what is sold. Every publisher's records are indexed by the Fangorn explorer and reached through the `fangorn` MCP server (search, publishers, get, buy, wallet, publish). Use when the user wants to find data, research, media, places or records on Fangorn, asks who publishes something or what a publisher has, wants to buy a record, or wants to publish something they made so others can find it.
---

# Finding data on Fangorn

Fangorn is publishers' records, committed on chain. The **explorer**
(`https://explorer.fangorn.network`) indexes every publisher, and the `fangorn` MCP server
downloads its view and searches it on this machine: the person's queries go nowhere. You
never scan the chain and never pick an app first: you search records, and each record says
who published it.

## The tools

| tool | for |
|---|---|
| `search {query, publisher?, limit?}` | records by meaning, across every publisher, or one publisher's |
| `publishers {query?}` | who publishes what: each publisher's repos, what they hold, how many records |
| `get {id}` | one record in full, by a hit's `id` |
| `buy {publisher, repo, id}` | a record that is sold (a hit with `sale`), opened |
| `wallet` | the person's address and balances |
| `publish {repo, records}` | the person's own records, into their own repo |

## The loop

1. **`search` with the person's words.** Every hit names its `publisher`. Read `ranked_by`:
   `meaning` or `words`. A word match to a conceptual question answers a different
   question, so say which one answered.
2. **To learn who has something, call `publishers`**, with a `query` when there is a topic. Then
   `search` with `publisher` to stay within one publisher's records.
3. **`get` a hit** when its preview isn't enough to decide.
4. **Cite the publisher.** When you use a record, say whose it is (`publisher`, and `repo`
   when there is one). Making publishers findable and credited is the point.

## Buying

A hit with `sale: {publisher, repo, id, price}` is sold by its publisher. `price` is in USDC
base units (`10000` = 0.01 USDC).

- **Say the price and get a yes before calling `buy`.** It pays from the person's wallet
  (`FANGORN_MCP_WALLET_KEY`), never above `FANGORN_MCP_MAX_PRICE` a record (default 0.10).
- `buy` checks the record's sealed data can be read before paying. If it can't, nothing is
  paid: tell the person, and don't retry in a loop.
- Buying the same record again costs nothing: the purchase is on chain.
- If buying is off (no wallet configured), give the person the price and the record, and say
  what to set.

## Publishing

`publish` puts records in the person's own repo, under their wallet, where any agent can find
them through the explorer. It is public and permanent: show exactly what will be published and
call it only on their yes to those records. Offer it when something you made for them (research,
a list, a dataset) would be worth something to others.

## Limits: state these, don't paper over them

- **New records show up after the explorer's next index run** (every few minutes). A record
  published a moment ago may not be found yet.
- **If the explorer doesn't answer**, the tools say so. Tell the person; don't conclude the
  data doesn't exist. `FANGORN_EXPLORER` points the server at another explorer.
- **Paid fields are absent from previews**, not empty. Quote the price rather than reporting
  the data as missing.
