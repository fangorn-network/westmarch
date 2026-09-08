// What will the index be able to do with what you baked?
//
// Every capability on the consumer side is paid for at bake time, and the bill
// is invisible until a reader hits it. A corpus with no `coverage` can never be
// ranked — it is simply absent from every question anyone asks. One with no
// `role_map` renders as a column of filenames. One whose `paywall` names fields
// the free shard ships anyway puts a price on data it already gave away, which
// is the bug that shipped in this repo's own fixture and that nobody noticed for
// weeks because nothing looks broken.
//
// So this is the publisher's mirror of `directory.js`: the same fetches, read
// for what is MISSING. It is deliberately not a schema validator — a bundle is
// allowed to declare nothing, and the honest report for that is "your rows will
// appear as filenames and nobody will find them", not an error.
//
// ponytail: one pass, no caching, no severity config. Three levels, because
// there are three real outcomes — the reader cannot find you, they find you and
// cannot read you, or they read you and cannot go anywhere.

import { configure, loadShard, resetShard, trimView } from "./shard.js";
import { shapeOf } from "./ui.js";
import { inSample, rolesFrom, textOf } from "./roles.js";

/** The model every corpus on this network is baked with. Cosine between two
 *  models' vectors is noise that still looks like a score, so a mismatch is not
 *  a warning — it is exclusion from the directory. */
export const NETWORK_MODEL = "nomic-ai/nomic-embed-text-v1.5";

const F = (level, what, why, fix) => ({ level, what, why, fix });

async function readJson(url, timeoutMs = 8000) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const res = await fetch(url, { signal: ctl.signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } finally { clearTimeout(t); }
}

/**
 * Lint one baked view.
 *
 * `rows` samples the free shard — the only way to catch a paywall that lies and
 * vectors that are not there. It is the free index, the same bytes any reader
 * downloads, but it is the slow part; pass `rows: false` for catalog-only.
 */
export async function lint(view, { rows = true, model = NETWORK_MODEL, timeoutMs } = {}) {
    const at = trimView(view);
    const found = [];
    let cat;
    try {
        cat = await readJson(`${at}/cdn/catalog`, timeoutMs);
    } catch (e) {
        return {
            view: at, reachable: false, domains: [],
            findings: [F("blocks", "no catalog", `${at}/cdn/catalog — ${e.message}`,
                "The directory reads this one file to learn you exist. Nothing works until it serves.")],
        };
    }

    if (!cat.embedding_model) {
        found.push(F("blocks", "no embedding_model in the catalog",
            "The directory cannot tell whether your vectors are comparable to a reader's query.",
            `Write "embedding_model": "${model}" at the top of the catalog.`));
    } else if (cat.embedding_model !== model) {
        found.push(F("blocks", `embedded with ${cat.embedding_model}`,
            `The network shares ${model}. Cosine between two models is noise that still looks like a score, so readers exclude you rather than rank you wrong.`,
            "Re-bake with the network model, or accept that only readers using yours will see this corpus."));
    }

    const domains = [];
    for (const d of cat.domains ?? []) {
        const dom = { name: d.name, rows: d.count ?? 0, findings: [] };
        const add = (...a) => dom.findings.push(F(...a));
        // Deferred until the rows are in hand — see its call site.
        const deadEnd = (playable) => {
            const doors = Object.keys(roles.externalUrl ?? {}).length + Object.keys(roles.actions ?? {}).length;
            if (doors || roles.launch || playable) return;
            add("degrades", "nowhere to go",
                "With no presentation.externalUrl, no actions, no launch, and no row a reader could play where it stands, a hit is a dead end.",
                "Either declare where a row lives — presentation.externalUrl per entity type — or ship a media role the rows actually carry, and the stage will play it here.");
        };

        if (!d.coverage?.vectors?.length) {
            add("blocks", "no coverage centroids",
                "find-corpora ranks corpora it has not downloaded by matching a question against ~4 KB of published centroids. Without them this corpus scores null — sorted last on every question, and never opened by an agent that has anything else to try.",
                "Re-bake: coverage is spherical k-means over a sample of your own vectors. It is the cheapest thing in the pipeline and the only thing that makes you findable.");
        }
        if (!d.description) {
            add("degrades", "no description",
                "The one line a person reads to decide whether to open you.",
                "One sentence saying what is in here and roughly when it is from.");
        }
        if (!(d.entity_types ?? []).length) {
            add("degrades", "no entity_types",
                "browse-collection has nothing to group by, so 'show me what's here' returns one undifferentiated list.",
                "Declare the kinds your rows come in and their counts.");
        }

        // The manifest: the shape, the price and the door out.
        let man = null;
        try { man = await readJson(`${at}/cdn/domains/${encodeURIComponent(d.name)}/manifest`, timeoutMs); }
        catch { /* reported below as an absent role_map */ }
        const roles = rolesFrom(man ? [man] : []);

        if (!roles.declared) {
            add("degrades", "no role_map",
                "Readers fall back to sniffing field names. Titles become whatever looked title-ish, and the text a search matches is a guess.",
                "Declare title, text, subtitle and tags. It is the highest-value dozen lines in the manifest.");
        } else {
            if (!roles.text.length) {
                add("blocks", "role_map declares no text",
                    "The prose a query matches is empty, so lexical search matches nothing and every hit rests on the vector alone.",
                    "Name the field(s) holding the describing prose.");
            }
            if (!roles.title.length) {
                add("degrades", "role_map declares no title",
                    "Every result is labelled by id.",
                    "Name the field a person would call the title.");
            }
        }

        const pay = man?.paywall ?? d.paywall;
        if (pay && !pay.resourceId) {
            add("degrades", "priced but not purchasable",
                "A paywall with no resourceId quotes a price nobody can pay.",
                "Publish the payload and write its resourceId, or drop the paywall.");
        }

        if (rows) {
            resetShard();
            // The text role is evaluated AT PARSE TIME, so a lint that does not
            // wire it reads the default sniff and grades a corpus on prose the
            // publisher never declared. (This file had that bug too, which is
            // some evidence for how easy it is to have.)
            configure({ rowText: (f) => textOf(f, roles), onManifests: () => {} });
            let sample = [];
            try { sample = (await loadShard(at)).slice(0, 2000); }
            catch (e) { add("blocks", "the shard did not load", e.message, "The free index is what a reader streams. If it does not serve, nothing else matters."); }

            if (sample.length) {
                const withVec = sample.filter((r) => r.vector?.length).length;
                if (!withVec) {
                    add("blocks", "no vectors on the sampled rows",
                        "Search silently degrades to word matching, and taste, recommend and similar-rows stop working entirely.",
                        "The bake writes packed vectors per row. Check they survived the shard write.");
                } else if (withVec < sample.length) {
                    add("degrades", `${sample.length - withVec} of ${sample.length} sampled rows have no vector`,
                        "Those rows can only ever be found by word match, and never by taste.",
                        "Usually rows whose text role was empty at bake time.");
                }

                // A text role that is present and useless. Two buying agents in the
                // market simulation hit this from opposite directions: a corpus
                // sold as "21,131 timed dialogue rows" had baked the FILENAME
                // into its text field, so every question about what was said
                // returned nothing, and both agents read that as "worthless
                // corpus" rather than "broken index". A publisher cannot see it
                // — their manifest is correct and their rows have a text field.
                const texts = sample.map((r) => String(r.text ?? "")).filter(Boolean);
                const titles = new Set(roles.title.flatMap((f) => sample.map((r) => String(r[f] ?? ""))));
                // Two ways to have no readable text, with opposite fixes: the
                // role points at nothing, or the role points at something you
                // are selling. Only the second is legitimate, and only if the
                // buyer gets enough of it free to tell what it is.
                const gatedText = roles.text.length && roles.text.every((f) => (pay?.locked ?? []).includes(f));
                const free = pay?.sample?.count ?? 0;
                if (gatedText && !free) {
                    add("blocks", "the whole text role is behind the paywall",
                        `${roles.text.join(", ")} — every word this corpus is about costs money, so a reader can rank it but cannot read one line to check the ranking means anything. Buying is a coin flip, and agents that hit this walk away rather than gamble.`,
                        "Set paywall.sample (1% is the default) so a deterministic slice of rows ships whole. The seller does not pick them, so the sample is evidence rather than advertising.");
                } else if (gatedText) {
                    add("degrades", `text is paid, ${free.toLocaleString()} rows free to read`,
                        "Working as intended — a reader ranks the whole corpus and reads the sample to check the ranking before paying.",
                        "Nothing to fix. Raise paywall.sample if buyers still say they cannot tell what they are getting.");
                } else if (!texts.length) {
                    add("blocks", "no searchable text on the sampled rows",
                        "The text role resolved to nothing, so lexical search matches nothing and every hit rests on the vector alone.",
                        "Check the field your role_map names actually carries prose in the shard.");
                } else {
                    const distinct = new Set(texts).size;
                    const echoes = texts.filter((t) => titles.has(t)).length;
                    if (echoes > texts.length * 0.8) {
                        add("blocks", "the text role is the title",
                            `${echoes} of ${texts.length} sampled rows have searchable text identical to their title. Readers can only find you by name — which means they cannot find you by what you are about, which is the only thing search is for.`,
                            "Point role_map.text at the prose, not the filename. If the prose is what you are selling, some of it has to be in the free index or nobody can rank you.");
                    } else if (distinct < texts.length / 20) {
                        add("degrades", `only ${distinct} distinct texts across ${texts.length} rows`,
                            "Most rows are indistinguishable to search, so they will rank identically and flood each other.",
                            "Usually a text role pointing at a shared field (a series name, a collection) rather than a per-row one.");
                    }
                }

                // The one that only rows can catch, and the one that shipped here.
                // A row is allowed to carry locked fields if and only if it is in
                // the declared free sample, and that is not the seller's word —
                // the slice is a hash of each row's own id, so it is recomputed
                // here. Rows outside it carrying paid fields is a leak; a sample
                // that does not match the hash is a seller who picked its own
                // shop window, which is the failure the hash exists to prevent.
                const locked = pay?.locked ?? [];
                const rate = pay?.sample?.rate ?? 0;
                const carrying = sample.filter((r) => locked.some((f) => r[f] != null && r[f] !== ""));
                const picked = [];
                for (const r of carrying) if (!(await inSample(r.id, rate))) picked.push(r);
                if (picked.length) {
                    const given = [...new Set(locked.filter((f) => picked.some((r) => r[f] != null && r[f] !== "")))];
                    add("blocks", `paywall names ${given.length} field${given.length === 1 ? "" : "s"} the free shard ships anyway`,
                        `${given.join(", ")} on ${picked.length} of ${sample.length} sampled rows outside the declared free slice — readers are told these cost money and are handed them for free. Anything a reader believes about your price is now wrong.`,
                        rate ? "Those rows are not the ones the sample hash picks. Re-bake rather than editing the shard."
                             : "Either withhold them from the shard, or take them out of paywall.locked.");
                }
            }

            // A hit is a dead end when there is nowhere to go AND nothing to
            // play. The second half of that used to not exist: an index handed
            // the reader to an app, so a corpus with no link was a corpus with
            // no destination. `ui.js:stage` presents a row where it stands, so a
            // publisher who ships playable files owes nobody a link.
            //
            // Measured on the sampled rows, never on the declaration. This
            // corpus's own sibling declares `media: "url"` and ships no url on
            // any row, which is exactly the dead end the rule is looking for,
            // and a manifest-only check would have passed it.
            deadEnd(sample.filter((r) => shapeOf(r, roles) !== "read").length);
        } else {
            deadEnd(0);
        }
        domains.push(dom);
    }

    if (!domains.length) {
        found.push(F("blocks", "the catalog declares no domains", "There is nothing here to find.", "Bake at least one domain into this view."));
    }
    return { view: at, reachable: true, model: cat.embedding_model ?? null, domains, findings: found };
}

/** The report as a person reads it. Blocking first — a corpus nobody can find
 *  has no second problem. */
export function format(r) {
    const line = (f) => `  ${f.level === "blocks" ? "✗" : "·"} ${f.what}\n      ${f.why}\n      → ${f.fix}`;
    const order = (a, b) => (a.level === b.level ? 0 : a.level === "blocks" ? -1 : 1);
    const out = [`${r.view}${r.model ? ` · ${r.model}` : ""}`];
    if (!r.reachable) return [...out, ...r.findings.map(line)].join("\n");
    for (const f of [...r.findings].sort(order)) out.push(line(f));
    for (const d of r.domains) {
        const blocks = d.findings.filter((f) => f.level === "blocks").length;
        out.push(`\n${d.name} — ${d.rows.toLocaleString()} rows — `
            + (blocks ? `${blocks} thing${blocks === 1 ? "" : "s"} stopping readers finding or reading this`
                      : d.findings.length ? "findable, with rough edges" : "nothing to fix"));
        for (const f of [...d.findings].sort(order)) out.push(line(f));
    }
    return out.join("\n");
}

// ── cli + self-check: `node consume/lint.js [viewUrl]` ─────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const arg = process.argv.slice(2).find((a) => !a.startsWith("--"));
    if (arg) {
        console.log(format(await lint(arg, { rows: !process.argv.includes("--no-rows") })));
        process.exit(0);
    }

    const body = (o) => {
        const b = Buffer.from(typeof o === "string" ? o : JSON.stringify(o));
        return { ok: true, status: 200, headers: new Headers(),
                 json: async () => JSON.parse(b.toString()), text: async () => b.toString(), arrayBuffer: async () => b,
                 body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(b)); c.close(); } }) };
    };
    const vec = Array.from({ length: 8 }, (_, i) => (i ? 0 : 1));
    const ndjson = (rows) => rows.map((r) => JSON.stringify(r)).join("\n");

    let CATALOG = null, MANIFEST = null, ROWS = [];
    globalThis.fetch = async (url) => {
        const { pathname } = new URL(String(url), "https://ok.test");
        if (!CATALOG) return { ok: false, status: 404, headers: new Headers() };
        if (pathname.endsWith("/cdn/catalog")) return body(CATALOG);
        if (/\/cdn\/domains\/[^/]+\/manifest$/.test(pathname)) return MANIFEST ? body(MANIFEST) : { ok: false, status: 404, headers: new Headers() };
        if (/\/cdn\/domains\/[^/]+\/shards\//.test(pathname)) return body(ndjson(ROWS));
        return { ok: false, status: 404, headers: new Headers() };
    };

    const has = (r, what) => [...r.findings, ...r.domains.flatMap((d) => d.findings)].some((f) => f.what.includes(what));

    // Unreachable is its own answer, not a crash.
    let r = await lint("https://gone.test/q/v1", { rows: false });
    if (r.reachable || !has(r, "no catalog")) throw new Error("an unreachable view must report, not throw");

    // The bake that forgot the one thing that makes it findable.
    CATALOG = {
        embedding_model: NETWORK_MODEL,
        domains: [{ name: "films", count: 10, description: "Films", entity_types: ["video"] }],
    };
    MANIFEST = {
        name: "films", shards: [{ file: "shard-0000-films.ndjson" }],
        role_map: { title: "name", text: ["desc"], subtitle: "creator" },
        presentation: { externalUrl: { video: "https://x.test/{id}" } },
    };
    r = await lint("https://ok.test/q/v1", { rows: false });
    if (!has(r, "no coverage centroids")) throw new Error("a corpus with no coverage must be told it is unfindable");
    if ([...r.domains[0].findings].find((f) => f.what.includes("coverage")).level !== "blocks") {
        throw new Error("unfindable is blocking, not cosmetic");
    }

    // …and the same bake with coverage is clean.
    CATALOG.domains[0].coverage = { dim: 8, sampled: 10, vectors: [vec], counts: [10] };
    r = await lint("https://ok.test/q/v1", { rows: false });
    if (r.domains[0].findings.length) throw new Error(`a complete bake must report nothing: ${JSON.stringify(r.domains[0].findings)}`);

    // A foreign model is exclusion from the directory, not a warning.
    CATALOG.embedding_model = "some-other-model";
    if (!has(await lint("https://ok.test/q/v1", { rows: false }), "embedded with some-other-model")) {
        throw new Error("a foreign model must be reported as blocking");
    }
    CATALOG.embedding_model = NETWORK_MODEL;

    // No role_map, and no door out.
    MANIFEST = { name: "films", shards: [{ file: "shard-0000-films.ndjson" }] };
    r = await lint("https://ok.test/q/v1", { rows: false });
    if (!has(r, "no role_map")) throw new Error("a sniffed bundle must be told it is being guessed at");
    if (!has(r, "nowhere to go")) throw new Error("a corpus with no link, action or launch is a dead end and must say so");

    // …but a publisher who ships files a reader can play where they stand owes
    // nobody a link, and the rule has to read the ROWS to tell the two apart:
    // both of these declare a media role and only one of them carries it.
    MANIFEST = { name: "films", shards: [{ file: "shard-0000-films.ndjson" }],
                 role_map: { title: "name", text: ["desc"], media: "url" } };
    ROWS = [{ track_id: "a", owner: "0x1", fields: { name: "A", desc: "d", url: "https://x.test/a.mp4", mime: "video/mp4" } }];
    if (has(await lint("https://ok.test/q/v1"), "nowhere to go")) throw new Error("a corpus of playable files is not a dead end — the stage plays it in place");
    ROWS = [{ track_id: "a", owner: "0x1", fields: { name: "A", desc: "d" } }];
    if (!has(await lint("https://ok.test/q/v1"), "nowhere to go")) throw new Error("…but declaring a media role the rows do not carry is exactly a dead end");

    // The one only rows can catch: a price on data already given away.
    MANIFEST = {
        name: "films", shards: [{ file: "shard-0000-films.ndjson" }],
        role_map: { title: "name", text: ["desc"] },
        presentation: { externalUrl: { video: "https://x.test/{id}" } },
        paywall: { free: ["name"], locked: ["url", "path"], price: "50000", asset: "USDC", resourceId: "0xabc" },
    };
    // The wire form: a row's own fields live under `fields`, which is exactly why
    // a lint has to read a real shard rather than trust the manifest.
    ROWS = [
        { track_id: "a", owner: "0x1", fields: { name: "A", desc: "d", url: "https://x.test/a" } },
        { track_id: "b", owner: "0x1", fields: { name: "B", desc: "d", url: "https://x.test/b" } },
    ];
    r = await lint("https://ok.test/q/v1");
    if (!has(r, "the free shard ships anyway")) throw new Error("a paywall that lies must be caught — this is the bug that shipped here");
    const lie = r.domains[0].findings.find((f) => f.what.includes("ships anyway"));
    if (!lie.why.includes("url") || lie.why.includes("path")) throw new Error(`name the fields actually given away, not the whole list: ${lie.why}`);
    if (!has(r, "no vectors on the sampled rows")) throw new Error("a shard with no vectors must be caught before a reader finds it by accident");

    // A text role that is present, declared, and useless — the defect that cost
    // two buying agents their confidence in a corpus that was fine underneath.
    MANIFEST = { name: "films", shards: [{ file: "s0.ndjson" }], role_map: { title: "name", text: ["blurb"] },
                 presentation: { externalUrl: { video: "https://x.test/{id}" } } };
    ROWS = [
        { track_id: "a", owner: "0x1", v: "AQID", fields: { name: "S01E01.mp4", blurb: "S01E01.mp4" } },
        { track_id: "b", owner: "0x1", v: "AQID", fields: { name: "S01E02.mp4", blurb: "S01E02.mp4" } },
        { track_id: "c", owner: "0x1", v: "AQID", fields: { name: "S01E03.mp4", blurb: "S01E03.mp4" } },
    ];
    r = await lint("https://ok.test/q/v1");
    if (!has(r, "the text role is the title")) throw new Error("a text role that only repeats the title must be caught — nobody can search it");

    // …and real prose is not flagged.
    ROWS = ROWS.map((x, i) => ({ ...x, fields: { ...x.fields, blurb: `a distinct sentence about episode ${i} and what happens in it` } }));
    r = await lint("https://ok.test/q/v1");
    if (has(r, "the text role is the title")) throw new Error("real prose must not be flagged");

    // A text role sold whole, with no sample: rankable, unreadable, unbuyable.
    // This is archive-transcripts as it actually shipped.
    MANIFEST = { name: "subs", shards: [{ file: "s0.ndjson" }], role_map: { title: "name", text: ["text"] },
                 presentation: { externalUrl: { subtitles: "https://x.test/{id}" } },
                 paywall: { free: ["title"], locked: ["text"], price: "50000", resourceId: "0xabc" } };
    ROWS = [{ track_id: "a", owner: "0x1", v: "AQID", fields: { name: "S01E01.mp4" } },
            { track_id: "b", owner: "0x1", v: "AQID", fields: { name: "S01E02.mp4" } }];
    r = await lint("https://ok.test/q/v1");
    if (!has(r, "the whole text role is behind the paywall")) throw new Error("a corpus you can rank but cannot read one line of must be caught");
    if (has(r, "the text role is the title")) throw new Error("a locked text role is not a filename bug — the advice for the two is opposite");
    if (has(r, "the free shard ships anyway")) throw new Error("the derived search text must not be mistaken for a field the shard carries");

    // …and with a sample it is a working paid corpus, not a defect. `row-47` is
    // one the bake's hash actually picks, so its paid text is not a leak.
    MANIFEST.paywall.sample = { rate: 0.01, count: 211 };
    ROWS = [{ track_id: "row-47", owner: "0x1", v: "AQID", fields: { name: "a.mp4", text: "a line of dialogue" } },
            { track_id: "row-0", owner: "0x1", v: "AQID", fields: { name: "b.mp4" } }];
    r = await lint("https://ok.test/q/v1");
    if (has(r, "behind the paywall")) throw new Error("a sampled paid corpus must not block");
    if (!has(r, "211 rows free to read")) throw new Error("the reader must be told how much it can read before paying");
    if (has(r, "ships anyway")) throw new Error("a row inside the free slice carrying its paid text is the sample working, not a leak");

    // A seller who put paid text on a row the hash does NOT pick is either
    // leaking or choosing its own shop window. Both are the same finding.
    ROWS[1].fields.text = "a line the hash did not pick";
    r = await lint("https://ok.test/q/v1");
    if (!has(r, "ships anyway")) throw new Error("paid text outside the declared slice must be caught");
    if (!r.domains[0].findings.find((f) => f.what.includes("ships anyway")).why.includes("1 of 2")) throw new Error("say how many rows leaked, not just which fields");

    if (!format(r).includes("films")) throw new Error("the report must name the domain");
    console.log("lint.js self-check ok — unreachable reported not thrown, missing coverage is blocking, a complete bake is silent, "
        + "foreign model excluded, sniffed shape flagged, a dead end judged on the rows rather than the declaration, a text role that is really the filename caught, "
        + "a paywall naming fields the free shard ships, and a text role sold whole with no free sample");
}
