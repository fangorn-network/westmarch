// What a row means, when nobody wrote code for this dataset.
//
// A generic reader has one hard problem: it has rows, and no idea which field is
// the title. Hardcode `name` and it works on one corpus and returns `undefined`
// on the next — which is exactly what happened the first time the probe was
// pointed at a second bundle.
//
// The answer is already baked. A quickbeam domain manifest carries `role_map`
// (which field is the title, the subtitle, the tags, the prose to search, the
// measures, the location, the link) and `presentation` (an icon, an accent and a
// singular/plural name per entity type, plus per-type external URL templates).
// The publisher declared all of it when they shaped the graph. This file reads
// that declaration, merges it across the domains a view fuses, and falls back to
// sniffing when a domain was baked before role_map existed.
//
// So: a page written against these roles renders any bundle. That is the whole
// point of the file — it is the difference between a demo and a storefront.

/**
 * A field's values, as a list.
 *
 * Bundles are ragged about this in a way that matters: the SAME field arrives as
 * a real array on one row, as `"['Sitcom', 'Comedy']"` on the next, and as
 * `"Documentary,History"` on a third — all three are in one shard here. A reader
 * that passes them through unchanged hands an agent two different shapes for one
 * field and it filters on the wrong one.
 *
 * A comma with NO space after it is the signature of a machine-joined list.
 * Prose keeps its space ("Wilson, Michael G.") and must stay one value.
 *
 * ponytail: a sniff, not a parser. A value it misreads becomes a odd-looking
 * bucket, never a wrong answer to a filter — matching is on whole values.
 */
const BRACKETED = /^\s*[[(].*[\])]\s*$/;
const JOINED = /,(?! )/;
export function values(v) {
    if (Array.isArray(v)) return v.map((x) => String(x));
    const s = String(v ?? "");
    const inner = BRACKETED.test(s) ? s.trim().slice(1, -1) : JOINED.test(s) ? s : null;
    if (inner === null) return s === "" ? [] : [s];
    return inner.split(",").map((x) => x.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

/** Fields worth sniffing for, in order, when a domain declares no role_map. */
const GUESS = {
    title: ["title", "name", "label", "headline", "path"],
    subtitle: ["subtitle", "primaryType", "entityType", "kind", "series", "creator"],
    text: ["text", "desc", "description", "summary", "body", "abstract"],
};
const first = (fields, candidates) => candidates.find((c) => fields.has(c)) ?? null;
const arr = (v) => (Array.isArray(v) ? v.filter(Boolean) : v ? [v] : []);

/**
 * Merge a view's domain manifests into one presentation contract.
 *
 * A view fuses several publishers' domains and they need not agree — one may
 * call its title `title` and another `name`. Merging rather than picking the
 * first is what lets a fused view render both: `title` becomes an ordered list
 * of candidates and `titleOf` takes whichever a given row actually has.
 *
 * `sample` is any rows already downloaded; it is only consulted for a domain
 * that declared nothing, and an empty sample is fine — the guesses below are
 * ordered by how commonly they mean what they say.
 */
export function rolesFrom(manifests = [], sample = []) {
    const seen = new Set();
    for (const r of sample) for (const k of Object.keys(r)) seen.add(k);

    const title = [], subtitle = [], tags = [], text = [], measures = [], spatial = [], media = [], temporal = [], facets = [];
    const labels = {}, types = {}, fieldLabels = {}, externalUrl = {}, actions = {};
    let launch = null, refers = null;
    const entityTypes = [];
    const gates = [];
    let identity = null;

    const push = (into, v) => { for (const x of arr(v)) if (x && !into.includes(x)) into.push(x); };

    for (const m of manifests) {
        const rm = m?.role_map ?? {};
        push(title, rm.title); push(subtitle, rm.subtitle); push(tags, rm.tags);
        push(text, rm.text); push(measures, rm.measures); push(spatial, rm.spatial); push(media, rm.media); push(temporal, rm.temporal);
        identity ??= rm.identity ?? null;
        // Where a row in THIS corpus points, in someone else's.
        //
        // The 21,131 subtitle rows in the archive bundle each carry the `path`
        // of the film they were transcribed from, and every one of them resolves
        // — a total foreign key across two separately baked, separately priced
        // domains. Without this the consumer shows them as two unrelated
        // shelves, which loses the entire reason the graph holds them together:
        // you search what was SAID and arrive at what was FILMED.
        //
        // Declared, never sniffed. Testing whether one corpus's values happen to
        // be a subset of another's would join two publishers who never agreed to
        // be joined, on a collision.
        if (rm.refers?.field && rm.refers?.corpus && rm.refers?.to) refers ??= { ...rm.refers };
        Object.assign(labels, rm.labels ?? {});
        for (const f of arr(rm.fields)) seen.add(f);

        const pr = m?.presentation ?? {};
        Object.assign(types, pr.types ?? {});
        Object.assign(fieldLabels, pr.fieldLabels ?? {});
        Object.assign(externalUrl, pr.externalUrl ?? {});
        Object.assign(actions, pr.actions ?? {});
        // The fields a reader narrows by first (a town, a genre): the app's to name.
        push(facets, pr.facets);
        // The app's own interface, if it ships one. A url, not markup: it is a
        // separate document with a separate origin, which is the only way a
        // stranger's UI can be run at all.
        // Where the app lives as a page of its own. An index that CONTAINS every
        // app is a portal; one that points at them is a directory — and the
        // choice is forced, not aesthetic: a framed document's modelContext is
        // not the agent's, so hosting a real app deletes every tool it
        // registers. The useful thing an index can do is hand over what it
        // learned and get out of the way. `{taste}` and `{q}` fill at launch.
        launch ??= pr.launch ?? null;
        for (const t of arr(m?.entity_types)) entityTypes.push(t);
        if (m?.paywall) gates.push({ domain: m.name ?? null, ...m.paywall });
    }

    // Only where the manifests said nothing at all. A domain that declared a
    // title must never be second-guessed by a sniff.
    //
    // Fields the sample actually has come first; the rest of the guess list
    // follows. That tail matters more than it looks: sniffing needs a sample,
    // and the one caller who needs roles EARLIEST — `rowText`, which runs per
    // row during parsing — has no sample yet by definition. With the tail, an
    // empty sample still yields usable candidates and `pick` takes whichever the
    // row turns out to have; without it, every row parsed with empty text and
    // lexical search silently matched nothing.
    const guess = (into, candidates) => {
        if (into.length) return;
        push(into, candidates.filter((c) => seen.has(c)));
        push(into, candidates);
    };
    guess(title, GUESS.title);
    guess(subtitle, GUESS.subtitle);
    guess(text, GUESS.text);

    return {
        title, subtitle, tags, text, measures, spatial, media, temporal, facets, identity,
        labels, types, fieldLabels, externalUrl, actions, launch, refers, entityTypes,
        // What this view sells, if anything. A list because a fused view can pull
        // domains from several publishers and they price independently.
        gates,
        // Every field any domain mentions, plus everything the sample carried.
        // This is what a facet picker offers.
        fields: [...seen].sort(),
        // True when at least one domain actually declared its shape, so a caller
        // can say "sniffed" rather than implying the publisher chose this.
        declared: manifests.some((m) => m?.role_map),
    };
}

/**
 * Which collection a row belongs to.
 *
 * `entityType` is quickbeam's own convention — both bundles here carry it, and
 * the manifest's `entity_types` counts are keyed by it — so this is the one
 * field name the format actually fixes. `kind` is the older spelling and is
 * still on-chain in sond3r's vertices, hence the fallback.
 */
export const typeOf = (row) => {
    const t = row?.entityType ?? row?.kind;
    return t == null || t === "" ? null : String(t);
};

/**
 * English plural, for a type whose publisher declared none.
 *
 * ponytail: four rules. It exists because appending a bare "s" produced
 * "subtitless" on a real bundle, which reads as a bug in the page rather than a
 * missing declaration. A publisher who cares about the word declares `plural`
 * in `presentation.types` and none of this runs.
 */
export function pluralize(word) {
    const w = String(word);
    // Already ends in s: assume it is already plural and leave it. Bundles name
    // types like `subtitles` and `series`, and both "subtitless" and
    // "subtitleses" read as a bug in the page. A genuine singular ending in s
    // ("bus") comes out wrong, which is what declaring `plural` is for.
    if (/s$/i.test(w)) return w;
    if (/(x|z|ch|sh)$/i.test(w)) return `${w}es`;
    if (/[^aeiou]y$/i.test(w)) return `${w.slice(0, -1)}ies`;
    return `${w}s`;
}

/**
 * A collection, as the publisher wants it shown: its icon, accent, and the word
 * for one of them and many. `count` comes from the manifest where it was baked
 * and from the rows otherwise — a fused view has manifest counts for some
 * domains and not others, and a browse column that said "—" for half of them
 * would be worse than counting.
 *
 * Everything is optional. A bundle that declared no presentation still browses;
 * it just does so with the raw type name and no icon, which is honest.
 */
export function collections(roles, rows = []) {
    const counted = new Map();
    for (const t of roles.entityTypes) counted.set(t.type, (counted.get(t.type) ?? 0) + (t.count ?? 0));
    if (!counted.size) for (const r of rows) { const t = typeOf(r); if (t) counted.set(t, (counted.get(t) ?? 0) + 1); }
    return [...counted]
        .map(([type, count]) => {
            const p = roles.types[type] ?? {};
            return {
                type, count,
                icon: p.icon ?? null, accent: p.accent ?? null,
                singular: p.singular ?? type,
                plural: p.plural ?? pluralize(p.singular ?? type),
            };
        })
        .sort((a, b) => b.count - a.count);
}

/**
 * What a paid domain is withholding, and what it costs.
 *
 * The shard a reader downloaded is a free INDEX: every row is present, every
 * vector is present, so search and ranking are complete and private. What is
 * absent is a named set of fields. That distinction is the whole offer, and a
 * client that blurs it — "some results may be incomplete" — makes the purchase
 * unjudgeable. Name the fields.
 *
 * `unpublished` marks a gate whose payload has not been sealed and uploaded yet:
 * declared, priced, and nothing to buy. That is a different state from "not yet
 * paid for" and a reader must not offer to sell it.
 */
export function gatesOf(roles) {
    return (roles.gates ?? []).map((g) => ({
        domain: g.domain ?? null,
        locked: [...(g.locked ?? [])],
        free: [...(g.free ?? [])],
        price: String(g.price ?? "0"),
        asset: g.asset ?? "USDC",
        resourceId: g.resourceId ?? null,
        workerUrl: g.workerUrl ?? null,
        files: (g.files ?? []).map((f) => ({ file: f.file, count: f.count, bytes: f.bytes })),
        unpublished: !g.resourceId,
    }));
}

/** Is this field withheld from the free tier anywhere in this view? */
export const isLocked = (field, roles) =>
    (roles.gates ?? []).some((g) => (g.locked ?? []).includes(field));

/** Is this row part of the corpus's free sample — the deterministic slice a
 *  paywalled bake hands over whole so a buyer can read before paying?
 *
 *  The bake picks it by hashing the row's own id (quickbeam `paywall.in_sample`),
 *  which is what stops a seller putting its best rows in the shop window. That
 *  only holds if someone CHECKS, and the check is this function: anyone can
 *  recompute which rows should be free and see whether the shard agrees. */
export async function inSample(trackId, rate) {
    if (!(rate > 0)) return false;
    if (rate >= 1) return true;
    const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(trackId)));
    return new DataView(d).getUint32(0) < rate * 2 ** 32;
}

/** Price in whole USDC, for display. Base units are 6-decimal on every network
 *  this settles on; a bare "50000" on a buy button is not a price anyone reads. */
export const priceLabel = (g) =>
    `${(Number(g.price ?? 0) / 1e6).toFixed(g.price % 1000 ? 6 : 2)} ${g.asset ?? "USDC"}`;

/** The first of `candidates` this row actually has. A fused view is why this
 *  takes a list and not a name. */
export const pick = (row, candidates = []) => {
    for (const c of candidates) {
        const v = row?.[c];
        if (v != null && v !== "") return v;
    }
    return null;
};

export const titleOf = (row, roles) => String(pick(row, roles.title) ?? row?.id ?? "untitled");
export const subtitleOf = (row, roles) => { const v = pick(row, roles.subtitle); return v == null ? null : String(v); };

/** The prose a lexical query should match. Every declared text field joined,
 *  not just the first — `text` and `editorialSummary` are both prose and a
 *  query can legitimately hit either. Falls back to the title so a row with no
 *  declared prose is still findable by name. */
export function textOf(row, roles) {
    const parts = roles.text.map((f) => row?.[f]).filter((v) => v != null && v !== "");
    if (parts.length) return parts.join(" ");
    // A LOCKED text role has no text, and the title is not a stand-in for it.
    // This fallback is what let two buying agents rank 21,131 subtitle rows by
    // filename and never learn the dialogue was behind the gate — one bought
    // blind, the other read it as a worthless corpus. Empty is the honest answer:
    // it says "nothing to match here", which is true, instead of quietly
    // substituting a filename that matches nothing anyone would ask.
    if (roles.text.some((f) => isLocked(f, roles))) return "";
    const t = pick(row, roles.title);
    return t ? String(t) : "";
}

/** A compact preview: title, subtitle, and the declared tags/measures. What a
 *  tool result should carry so fifty hits don't spend a whole context window. */
export const BRIEF_CHARS = 160;
/** Tag lists in the wild are not short: this bundle's `categories` runs to fifty
 *  entries per row, so four hits came back as four kilobytes of "Establishment",
 *  "Point Of Interest", "Store". A preview that costs that much is not a preview.
 *  The first few carry the meaning; `get-row` has the rest. */
export const BRIEF_ITEMS = 6;

export function briefOf(row, roles, extra = []) {
    const out = { id: row.id, title: titleOf(row, roles) };
    const sub = subtitleOf(row, roles);
    if (sub) out.subtitle = sub;
    for (const f of [...roles.tags, ...roles.measures, ...extra]) {
        const v = row[f];
        if (v == null || v === "") continue;
        // Tags are normalized to a list whatever shape the shard held them in;
        // measures and everything else pass through as the scalar they are.
        const list = roles.tags.includes(f) ? values(v) : null;
        if (list) {
            out[f] = list.length > BRIEF_ITEMS ? [...list.slice(0, BRIEF_ITEMS), `…+${list.length - BRIEF_ITEMS} more`] : list;
        } else {
            out[f] = typeof v === "string" && v.length > BRIEF_CHARS ? `${v.slice(0, BRIEF_CHARS)}…` : v;
        }
    }
    return out;
}

/** The publisher's own link for this row, from `presentation.externalUrl` —
 *  `{"Business": "{googleMapsUri}"}` keyed by entity type. Null when the type
 *  has no template or the row is missing the field it names. */
export function linkOf(row, roles) {
    const tpl = roles.externalUrl?.[typeOf(row)];
    if (!tpl) return null;
    let missing = false;
    const url = String(tpl).replace(/\{(\w+)\}/g, (_, f) => {
        const v = row?.[f];
        if (v == null || v === "") { missing = true; return ""; }
        return String(v);
    });
    return missing ? null : url;
}

/**
 * What you can DO with this row, as its publisher declared it.
 *
 * `presentation.actions` is `{ <entityType>: [{ kind, label, href }] }`, where
 * `href` is a `{field}` template like `externalUrl`. `kind` says what the thing
 * IS — "video", "audio", "image" get a player, anything else gets a link — so a
 * renderer never has to sniff a file extension or know what archive.org is.
 *
 * The interesting case is a template that names a field THIS TIER DOES NOT HAVE.
 * A film's playable url is exactly what the paywall withholds, so the action
 * comes back with `locked` naming the fields that are missing and why. That is
 * a player with a price on it rather than a broken <video> or, worse, no sign
 * that a player was ever on offer.
 */
export function actionsOf(row, roles) {
    const defs = roles?.actions?.[typeOf(row)] ?? [];
    return defs.map((a) => {
        const locked = [], missing = [];
        const href = String(a.href ?? "").replace(/\{(\w+)\}/g, (_, f) => {
            const v = row?.[f];
            if (v != null && v !== "") return String(v);
            (isLocked(f, roles) ? locked : missing).push(f);
            return "";
        });
        return { kind: a.kind ?? "link", label: a.label ?? a.kind ?? "open", href, locked, missing };
    // An action whose template names a field this bundle simply never had is not
    // a paywall, it is a bad declaration — drop it rather than show a dead
    // button. Locked ones stay: those are on offer.
    }).filter((a) => a.locked.length || !a.missing.length);
}

// ── self-check: `node consume/roles.js` ─────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/roles.js")) {
    // The real places manifest's shape.
    const places = {
        role_map: {
            identity: "placeId", title: "title", subtitle: "primaryType", spatial: "locality",
            media: "googleMapsUri", tags: ["categories"], measures: ["rating", "userRatingCount"],
            temporal: null, relations: [], text: ["text", "editorialSummary"],
            labels: { title: "Title" }, fields: ["address", "phone", "website"],
        },
        presentation: {
            types: { Business: { icon: "🏪", singular: "Place" } },
            externalUrl: { Business: "{googleMapsUri}", Event: "{ticketUrl}" },
        },
        entity_types: [{ type: "Event", count: 654 }, { type: "Business", count: 263 }],
    };
    const row = {
        id: "r1", entityType: "Business", title: "Cira's Red, White & Brew Bar",
        primaryType: "Bar & Grill", text: "Bar & Grill in Saint Germain, WI.",
        editorialSummary: "", categories: "['Bar', 'Restaurant']", rating: "4.7",
        userRatingCount: "293", googleMapsUri: "https://maps.google.com/?cid=140971",
    };

    let r = rolesFrom([places], [row]);
    if (!r.declared) throw new Error("a manifest with a role_map is declared, not sniffed");
    if (titleOf(row, r) !== "Cira's Red, White & Brew Bar") throw new Error("declared title lost");
    if (subtitleOf(row, r) !== "Bar & Grill") throw new Error("declared subtitle lost");
    if (textOf(row, r) !== "Bar & Grill in Saint Germain, WI.") throw new Error("empty declared text fields must be skipped, not joined as blanks");
    // A declared reference into another publisher's corpus. All three parts or
    // none: a half-written join would silently point at nothing, and the caller
    // would show a matched subtitle with no film behind it.
    {
        const full = { field: "videoPath", corpus: "archive-films", to: "path" };
        const ref = rolesFrom([{ role_map: { identity: "videoPath", refers: full } }]).refers;
        if (ref?.corpus !== "archive-films" || ref.field !== "videoPath" || ref.to !== "path") throw new Error("a complete reference must survive the manifest");
        for (const drop of ["field", "corpus", "to"]) {
            const partial = { ...full }; delete partial[drop];
            if (rolesFrom([{ role_map: { refers: partial } }]).refers) throw new Error(`a reference missing '${drop}' must not be honoured`);
        }
        if (rolesFrom([{ role_map: { title: "name" } }]).refers !== null) throw new Error("a corpus that declared no reference has none — this is never sniffed");
    }

    if (linkOf(row, r) !== "https://maps.google.com/?cid=140971") throw new Error("presentation.externalUrl not applied");
    // A template naming a field the row lacks yields null, not a broken URL.
    if (linkOf({ ...row, entityType: "Event" }, r) !== null) throw new Error("a template with a missing field must be null, not a half-built link");
    if (!r.fields.includes("phone") || !r.fields.includes("website")) throw new Error("role_map.fields must reach the facet picker");
    if (r.types.Business.icon !== "🏪") throw new Error("presentation.types lost");
    // One field, three shapes, one output. All three of these are in one real
    // shard, and handing an agent two shapes for one field is how it filters on
    // the wrong one.
    for (const raw of [["Bar", "Restaurant"], "['Bar', 'Restaurant']", "Bar,Restaurant"]) {
        const got = briefOf({ ...row, categories: raw }, r).categories;
        if (!Array.isArray(got) || got.join() !== "Bar,Restaurant") throw new Error(`tags must normalize: ${JSON.stringify(raw)} → ${JSON.stringify(got)}`);
    }
    if (values("Wilson, Michael G.").length !== 1) throw new Error("a comma followed by a space is prose, not a list");
    if (values("").length !== 0) throw new Error("an empty value is no values, not one empty one");
    // A measure is a scalar and must not become a one-item list.
    if (Array.isArray(briefOf(row, r).rating)) throw new Error("a measure must stay scalar");

    // A fifty-entry tag list is truncated, and says it was — an agent must not
    // read six categories as the whole list.
    const many = briefOf({ ...row, categories: Array.from({ length: 50 }, (_, i) => `c${i}`) }, r);
    if (many.categories.length !== BRIEF_ITEMS + 1) throw new Error(`long tag lists must truncate: ${many.categories.length}`);
    if (!String(many.categories.at(-1)).includes("+44 more")) throw new Error("truncation must say how much it dropped");
    if (briefOf({ ...row, categories: ["a", "b"] }, r).categories.length !== 2) throw new Error("a short list must pass through whole");

    const b = briefOf(row, r);
    if (b.title !== row.title || b.rating !== "4.7" || !b.categories) throw new Error(`brief must carry declared tags + measures: ${JSON.stringify(b)}`);
    if ("googleMapsUri" in b) throw new Error("brief must not dump undeclared fields");

    // ── the paywall, as the manifest declares it ──
    const paid = rolesFrom([{ ...places, name: "places", paywall: {
        free: ["title", "primaryType"], locked: ["text", "phone"], price: "50000",
        asset: "USDC", resourceId: "0xdead", workerUrl: "https://w",
        files: [{ file: "locked-0000-abc.ndjson.gz", count: 917, bytes: 1234 }],
    } }]);
    let [g] = gatesOf(paid);
    if (g.locked.join() !== "text,phone") throw new Error("the locked field list must survive");
    if (g.unpublished) throw new Error("a gate with a resourceId is buyable");
    if (priceLabel(g) !== "0.05 USDC") throw new Error(`price must render as USDC, got ${priceLabel(g)}`);
    if (!isLocked("phone", paid) || isLocked("title", paid)) throw new Error("isLocked must read the manifest");
    // Declared but never sealed: priced, and nothing to sell. A reader must be
    // able to tell that apart from "you have not paid yet".
    [g] = gatesOf(rolesFrom([{ ...places, paywall: { locked: ["text"], price: "1" } }]));
    if (!g.unpublished) throw new Error("no resourceId means there is nothing to buy yet");
    // A view with no gate sells nothing, and says so by saying nothing.
    if (gatesOf(rolesFrom([places])).length) throw new Error("an ungated view must report no gates");
    if (isLocked("text", rolesFrom([places]))) throw new Error("nothing is locked in an ungated view");

    // The free sample, recomputed. Must agree with quickbeam's paywall.in_sample
    // byte for byte or the check that keeps a seller honest checks nothing —
    // these ids and their verdicts are pinned against that implementation.
    for (const [id, yes] of [["row-47", true], ["row-169", true], ["row-0", false], ["row-3", false], ["row-19", false]]) {
        if (await inSample(id, 0.01) !== yes) throw new Error(`inSample must match the bake: ${id}`);
    }
    if (await inSample("row-0", 0) !== false || await inSample("row-0", 1) !== true) throw new Error("rate 0 gives nothing away, rate 1 gives everything");
    let n = 0;
    for (let i = 0; i < 2000; i++) if (await inSample(`row-${i}`, 0.01)) n++;
    if (n !== 19) throw new Error(`the bake picks exactly 19 of these 2000 — got ${n}`);

    // A locked text role reads as EMPTY, never as the title. The title-as-text
    // fallback still stands for an ungated corpus that simply has no prose.
    const gatedText = rolesFrom([{ ...places, name: "places", role_map: { ...places.role_map, text: ["text"] },
        paywall: { free: ["title"], locked: ["text"], price: "1" } }]);
    if (textOf({ title: "Cira's Bar" }, gatedText) !== "") throw new Error("a locked text role must read empty, not as the title");
    if (textOf({ title: "Cira's Bar", text: "A bar." }, gatedText) !== "A bar.") throw new Error("a sampled row's real text must still win");
    if (textOf({ title: "Cira's Bar" }, rolesFrom([places])) !== "Cira's Bar") throw new Error("the title fallback still stands when nothing is gated");

    // ── collections: the publisher's own words for their own groups ──
    let cols = collections(rolesFrom([places]));
    if (cols.map((c) => c.type).join() !== "Event,Business") throw new Error(`collections must sort by count: ${cols.map((c) => c.type)}`);
    if (cols[1].icon !== "🏪" || cols[1].singular !== "Place") throw new Error("presentation.types must reach the collection");
    // A declared singular with no declared plural still reads correctly.
    if (cols[1].plural !== "Places") throw new Error(`plural must derive from the declared singular: ${cols[1].plural}`);
    // A type the publisher never described still browses — raw name, no icon.
    if (cols[0].singular !== "Event" || cols[0].icon !== "🎫" && cols[0].icon !== null) throw new Error("an undescribed type must still be a collection");
    // No manifest counts at all: fall back to counting rows, because "—" for half
    // a fused view's collections is worse than counting them.
    cols = collections(rolesFrom([{ role_map: { title: "title" } }]), [row, row, { id: "e", entityType: "Event" }]);
    if (cols[0].type !== "Business" || cols[0].count !== 2) throw new Error(`row counting fallback wrong: ${JSON.stringify(cols)}`);
    // The fallback plural. "subtitless" on a real bundle is what earned these
    // rules; anything harder is the publisher's job to declare.
    for (const [one, many] of [["subtitles", "subtitles"], ["series", "series"], ["video", "videos"],
                               ["folder", "folders"], ["box", "boxes"], ["category", "categories"], ["day", "days"]]) {
        if (pluralize(one) !== many) throw new Error(`pluralize(${one}) = ${pluralize(one)}, want ${many}`);
    }
    if (typeOf({ kind: "video" }) !== "video") throw new Error("the older `kind` spelling is still on-chain");
    if (typeOf({}) !== null) throw new Error("a typeless row must be null, not 'undefined'");

    // ── the archive bundle: no role_map at all, so sniff ──
    // serve-embeddings.js writes {name, model, dim, shards} and nothing else.
    const bare = { name: "videos", shards: [] };
    const vid = { id: "v1", name: "S01E02 - Overture.mp4", path: "classic_tv/Duet/S01E02.mp4", kind: "video", desc: "A forgotten Fox sitcom." };
    r = rolesFrom([bare], [vid]);
    if (r.declared) throw new Error("a manifest with no role_map must report itself as sniffed");
    if (titleOf(vid, r) !== "S01E02 - Overture.mp4") throw new Error(`sniff must prefer name over path: ${titleOf(vid, r)}`);
    if (r.title[0] !== "name") throw new Error("a field the sample HAS must outrank one it does not");
    if (subtitleOf(vid, r) !== "video") throw new Error("sniff must find a subtitle");
    if (!textOf(vid, r).includes("forgotten Fox")) throw new Error("sniff must find the prose");

    // A row with nothing to go on still gets a title rather than "undefined" —
    // which is exactly the bug this file exists to prevent.
    if (titleOf({ id: "x" }, rolesFrom([], [])) !== "x") throw new Error("a title must always fall back to the id");
    if (textOf({ id: "x" }, rolesFrom([], [])) !== "") throw new Error("no prose and no title must be empty, not 'undefined'");

    // ── no manifest AND no sample: the state rowText is called in ──
    // This is the case that broke silently. Roles derived with nothing at all
    // must still name candidates, because `pick` resolves them per row later.
    const blind = rolesFrom([], []);
    if (!blind.text.includes("desc") || !blind.title.includes("name")) throw new Error("a blind sniff must still offer candidates");
    if (textOf(vid, blind) !== "A forgotten Fox sitcom.") throw new Error("a row parsed before any sample must still get its prose");
    if (titleOf({ id: "z", title: "declared later" }, blind) !== "declared later") throw new Error("a blind sniff must resolve per row");

    // ── a fused view: two domains that disagree about their own field names ──
    // Merging rather than picking the first is what lets one page render both.
    r = rolesFrom([places, { role_map: { title: "name", text: ["body"] } }]);
    if (titleOf({ name: "a note" }, r) !== "a note") throw new Error("the second domain's title field must resolve too");
    if (titleOf(row, r) !== row.title) throw new Error("the first domain's title must still resolve");
    if (!r.text.includes("text") || !r.text.includes("body")) throw new Error("text fields must union across domains");
    // A declared shape is never second-guessed by a sniff, even a plausible one.
    if (r.title.includes("label")) throw new Error("a declared title must not be widened by guesses");

    // ── actions: what you can DO with a row, declared per entity type ───────
    {
        const films = rolesFrom([{
            name: "films",
            role_map: { identity: "identifier", title: "name", text: ["desc"] },
            paywall: { free: ["identifier", "name"], locked: ["path"], price: "50000", asset: "USDC" },
            presentation: { actions: { video: [
                { kind: "video", label: "Play", href: "https://cdn.test/{path}" },
                { kind: "link", label: "On archive.org", href: "https://archive.org/details/{identifier}" },
                { kind: "link", label: "Dead", href: "https://x.test/{nosuchfield}" },
            ] } },
        }]);
        const acts = actionsOf({ entityType: "video", identifier: "the-temp", name: "temp.mp4" }, films);
        if (acts.length !== 2) throw new Error(`a template naming a field the bundle never had must drop: ${JSON.stringify(acts)}`);
        const play = acts.find((a) => a.kind === "video");
        if (!play.locked.includes("path")) throw new Error("a player whose url is behind the paywall must say which field is locked");
        const link = acts.find((a) => a.kind === "link");
        if (link.href !== "https://archive.org/details/the-temp") throw new Error(`free fields must interpolate: ${link.href}`);
        if (link.locked.length) throw new Error("a fully resolved action is not locked");
        // …and once the payload is bought, the same declaration is a real player.
        const bought = actionsOf({ entityType: "video", identifier: "the-temp", name: "temp.mp4", path: "a/b.mp4" }, films);
        if (bought.find((a) => a.kind === "video").href !== "https://cdn.test/a/b.mp4") throw new Error("an unlocked player must resolve");
        // A bundle that declared no actions offers none, rather than throwing.
        if (actionsOf({ entityType: "video" }, rolesFrom([])).length) throw new Error("no declaration, no actions");
    }

    console.log("roles.js self-check ok — declared role_map wins, sniffed fallback, fused domains merge, external links, declared actions resolve and name their locked fields, a cross-corpus reference is honoured only when whole and never sniffed, title never undefined");
}
