// taste.md — the human half of AGENTS.md.
//
// A taste is 108 bytes of int8 in a space nobody can read. That is a fine thing
// to compute with and a terrible thing to own: you cannot check it, correct it,
// argue with it, or decide you have changed. `exportTaste` already carries the
// TITLES it was built from for exactly that reason, which helps and is not
// enough — a list of twelve films you already know you watched tells you nothing
// you did not know.
//
// So this file writes the vector down in words, against the vocabulary the
// publishers themselves declared, and the result is a document with the same
// job as AGENTS.md: something a person reads to see what is being assumed about
// them, edits to say otherwise, and hands to an agent as the brief.
//
// WHY THE PUBLISHERS' OWN VOCABULARY
// ----------------------------------
// The alternative is to embed a fixed list of adjectives and score those, which
// would describe the reader in the model's terms and be wrong in the specific
// way that matters: it would say the same things about a person on a catalogue
// of silent film and a catalogue of restaurants. Here a term exists only because
// some publisher declared it as a `tags` role and at least MIN_SUPPORT of their
// rows carry it, so the words available to describe you are the words the
// catalogue is actually organised by.
//
// WHY EVERY TERM IS CENTRED
// -------------------------
// A term's meaning is the mean of the rows carrying it, and the mean of 5,000
// rows tagged `drama` is very close to the mean of the whole catalogue — so raw
// cosine ranks the biggest tags first for everyone, and every reader is told
// they like drama. Subtracting the corpus mean from both sides asks the only
// question worth asking: of the ways this catalogue varies, which ones are you?
import { values } from "./roles.js";

/** Below this a term's "meaning" is a handful of rows, and on a small enough
 *  handful it is one row wearing a word — which is both noise and, on a corpus
 *  of reactions, a disclosure. Same floor as `reactions.js`. */
export const MIN_SUPPORT = 8;

const unit = (d) => {
    let n = 0;
    for (const x of d) n += x * x;
    n = Math.sqrt(n);
    if (n < 1e-9) return null;
    for (let i = 0; i < d.length; i++) d[i] /= n;
    return d;
};
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length && i < b.length; i++) s += a[i] * b[i]; return s; };

/**
 * What this catalogue can say about a reader: every declared tag value with
 * enough rows behind it, as a direction away from the catalogue's own centre.
 */
export function vocabulary(rows = [], roles = {}, { minSupport = MIN_SUPPORT } = {}) {
    const dim = rows.find((r) => r.vector)?.vector.length ?? 0;
    if (!dim) return { mean: null, dim: 0, terms: [] };

    const mean = new Float64Array(dim);
    let n = 0;
    for (const r of rows) {
        if (!r.vector) continue;
        n++;
        for (let i = 0; i < dim; i++) mean[i] += r.vector[i];
    }
    for (let i = 0; i < dim; i++) mean[i] /= n;

    const acc = new Map();
    for (const r of rows) {
        if (!r.vector) continue;
        for (const f of roles.tags ?? []) {
            for (const v of values(r[f])) {
                const k = `${f} ${v}`;
                let a = acc.get(k);
                if (!a) acc.set(k, (a = { field: f, value: v, n: 0, sum: new Float64Array(dim) }));
                a.n++;
                for (let i = 0; i < dim; i++) a.sum[i] += r.vector[i];
            }
        }
    }

    const terms = [];
    for (const a of acc.values()) {
        if (a.n < minSupport) continue;
        const d = new Float64Array(dim);
        for (let i = 0; i < dim; i++) d[i] = a.sum[i] / a.n - mean[i];
        if (unit(d)) terms.push({ field: a.field, value: a.value, n: a.n, vec: d });
    }
    return { mean, dim, terms };
}

/**
 * The terms a direction is most like.
 *
 * `center` is false for a vector that is ALREADY a difference — the kernel's `v`
 * is (recent picks minus older picks), a heading rather than a place, and taking
 * the catalogue's centre off a heading is meaningless.
 */
/** Two tags this close are one fact wearing two words. Not MMR: MMR reorders and
 *  still fills the list, so with nothing but aliases left to pick it prints all
 *  of them. An alias has to be DROPPED. 0.92 is well above anything two genuinely
 *  different tags reach and well below the ~0.99 of two names for one show. */
export const REDUNDANT = 0.92;

export function affinities(vocab, vec, { limit = 6, center = true, floor = 0.05, redundant = REDUNDANT } = {}) {
    if (!vocab?.terms?.length || !vec) return [];
    const d = new Float64Array(vocab.dim);
    for (let i = 0; i < vocab.dim; i++) d[i] = vec[i] - (center ? vocab.mean[i] : 0);
    if (!unit(d)) return [];
    const ranked = vocab.terms
        .map((t) => ({ t, score: dot(t.vec, d) }))
        .filter((x) => x.score > floor)
        .sort((a, b) => b.score - a.score);

    // A cartoon called Eek carries `eek`, `eek the cat`, `fox` and its voice
    // actor across one set of 59 rows, so the raw ranking opened with four
    // bullets saying "you watched Eek the Cat". A description that repeats
    // itself is not shorter than the vector it describes, and being shorter than
    // the vector is the only reason this document exists.
    const out = [];
    for (const { t, score } of ranked) {
        if (out.length >= limit) break;
        if (out.some((k) => dot(k.vec, t.vec) > redundant)) continue;
        out.push({ vec: t.vec, field: t.field, value: t.value, n: t.n, score });
    }
    return out.map(({ vec: _, ...rest }) => rest);
}

const pct = (x) => `${(x * 100).toFixed(0)}`;
const list = (xs) => xs.map((x) => `\`${x}\``).join(", ");

/**
 * The document.
 *
 * `catalogues` are `[{ name, rows, roles }]` — whatever this reader happens to
 * have open. The document is therefore about a reader AS SEEN BY the catalogues
 * they have actually touched, which is the honest scope: nothing here claims to
 * describe a person, only how their choices land against these shelves.
 *
 * `instructions` is the half a person WRITES. It is round-tripped untouched and
 * placed above everything derived, because a document whose authored section is
 * a footnote to the machine's section is not a brief, it is a report.
 */
export function tasteDoc({ t = null, catalogues = [], instructions = "", now = new Date() } = {}) {
    const day = now.toISOString().slice(0, 10);
    const head = [
        "# taste.md",
        "",
        "> Your preferences, as your own agent has them. Derived on this machine from the",
        "> things you named; never sent anywhere. Everything below the line is rewritten",
        "> each time you react — the *Standing instructions* are yours.",
        "",
    ];

    const authored = [
        "## Standing instructions",
        "",
        instructions.trim()
            || "_Nothing yet. Write what an agent should do for you — everything below is an\nobservation, and this is the part where you get to answer back._",
        "",
    ];

    if (!t) {
        return [...head, ...authored,
            "---", "",
            "## Observed", "",
            "Nothing observed yet: no likes or rejections have been recorded in this browser.",
            "React to a few things and this document fills in.", ""].join("\n");
    }

    const vocabs = catalogues
        .map((c) => ({ name: c.name, v: vocabulary(c.rows ?? [], c.roles ?? {}) }))
        .filter((c) => c.v.terms.length);

    const across = (vec, { limit = 6, center = true } = {}) => vocabs
        .flatMap(({ name, v }) => affinities(v, vec, { center, limit: 4 }).map((a) => ({ ...a, corpus: name })))
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

    const draw = across(t.q, { limit: 7 });
    const pass = t.no ? across(t.no, { limit: 5 }) : [];
    const toward = t.v ? across(t.v, { limit: 4, center: false }) : [];
    const away = t.v ? across(Float64Array.from(t.v, (x) => -x), { limit: 4, center: false }) : [];

    const bullets = (xs) => (xs.length
        ? xs.map((a) => `- **${a.value}** — ${a.corpus} · ${a.field} · ${a.n.toLocaleString()} rows · ${pct(a.score)}`).join("\n")
        : "_Nothing separated itself from the catalogue's average. Usually this means too few picks._");

    const body = [
        "---",
        "",
        "## What I am drawn to",
        "",
        bullets(draw),
        "",
        "> Read as: of the directions these catalogues vary in, these are the ones you are.",
        "> The number is correlation against the catalogue's own centre, not a share of anything.",
        "",
    ];

    if (pass.length) body.push("## What I pass on", "", bullets(pass), "");

    if (t.v) {
        body.push("## Where I am heading", "",
            `Your last ${Math.ceil(t.n / 2)} picks differ from the ones before them, so the agent ranks`,
            `${(t.drift * 100).toFixed(0)}% past where you are, in this direction:`, "",
            toward.length ? `**toward** ${list(toward.map((a) => a.value))}` : "_no clear heading_",
            ...(away.length ? ["", `**away from** ${list(away.map((a) => a.value))}`] : []), "");
    } else {
        // Deliberately not "N named, four needed": with the heading now carried
        // across sessions, `n` and the absence of a direction stopped agreeing,
        // and the document printed "7 named, four needed" at a reader who had
        // named seven things. The honest statement is about the kernel, not the
        // count.
        body.push("## Where I am heading", "",
            "No direction yet. The kernel infers one only once four picks give it an older half",
            "and a newer half to compare, and it will not invent one from fewer — so",
            "recommendations mirror what you named rather than leaning past it.", "");
    }

    body.push("## What I named", "",
        `**liked** (${t.n}) — ${t.from.length ? list(t.from) : "_none_"}`, "",
        `**passed** — ${t.rejected.length ? list(t.rejected) : "_none_"}`, "",
        "Delete a line here and the sentence above it stops being true. That is what writing",
        "it down is for: a taste you cannot read is a taste you cannot correct.", "",
        "## For an agent reading this", "",
        "- Rank candidates by cosine to `q`, minus 0.6 times the positive part of cosine to `no`.",
        "- Every corpus on this network embeds with `nomic-embed-text-v1.5` truncated to 256",
        "  dimensions, so `q` is comparable against a catalogue this reader has never opened.",
        "- Diversify the result (MMR, lambda 0.7). Six episodes of one series is not a recommendation.",
        "- Do not re-recommend anything under *What I named*.",
        "- Read the *Standing instructions* above as overriding anything derived below them.",
        "",
        `_Generated ${day} · ${t.n} likes, ${t.rejected.length} rejections · ${vocabs.length} catalogue`
        + `${vocabs.length === 1 ? "" : "s"} consulted · nothing left this machine._`, "");

    return [...head, ...authored, ...body].join("\n");
}

// ── self-check: `node consume/taste-doc.js` ─────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const { taste } = await import("./taste.js");

    // A catalogue with a KNOWN shape: two axes, and a tag at each end of each.
    // Anything the document says had better follow from that and not from how
    // many rows a tag happens to have.
    const D = 8;
    const vec = (a, b, jitter) => {
        const v = new Float32Array(D);
        v[0] = a; v[1] = b;
        for (let i = 2; i < D; i++) v[i] = ((jitter * (i + 1) * 37) % 13) / 100;
        return v;
    };
    const rows = [];
    let id = 0;
    const make = (tag, a, b, n) => { for (let i = 0; i < n; i++) rows.push({ id: `r${id++}`, genre: [tag], vector: vec(a, b, i) }); };
    make("silent", 1, 0, 40);
    make("newsreel", -1, 0, 40);
    make("comedy", 0, 1, 40);
    make("horror", 0, -1, 40);
    make("obscure", 1, 1, 3);          // …and one the floor must swallow whole

    const roles = { tags: ["genre"] };
    const vocab = vocabulary(rows, roles);
    const names = vocab.terms.map((t) => t.value).sort();
    if (names.join(",") !== "comedy,horror,newsreel,silent") throw new Error(`the support floor must drop a 3-row tag: ${names}`);

    // A reader who likes silents. The document must say silent, must NOT say
    // newsreel, and must not be dragged around by tag size — every surviving tag
    // has exactly 40 rows, so any ranking that appears is about direction alone.
    const likes = rows.filter((r) => r.genre[0] === "silent").slice(0, 6).map((r) => ({ id: r.id, title: r.id, vector: r.vector }));
    const dislikes = rows.filter((r) => r.genre[0] === "horror").slice(0, 3).map((r) => ({ id: r.id, title: r.id, vector: r.vector }));
    const t = taste(likes, dislikes);

    const drawn = affinities(vocab, t.q);
    if (drawn[0]?.value !== "silent") throw new Error(`the top affinity must be what was liked: ${JSON.stringify(drawn)}`);
    if (drawn.some((a) => a.value === "newsreel")) throw new Error("the opposite of what you liked must not appear as an affinity");
    const passed = affinities(vocab, t.no);
    if (passed[0]?.value !== "horror") throw new Error(`rejections must be described from 'no', not 'q': ${JSON.stringify(passed)}`);

    // Centring is the whole reason this is not a popularity list.
    {
        // A tag on EVERY row has the catalogue mean for a centroid, so its
        // direction is the zero vector and it is not a term at all — which is
        // the right answer: `film` on a corpus of films says nothing about
        // anyone, and the raw-cosine version of this ranked it first for
        // everybody.
        const all = rows.map((r) => ({ ...r, genre: [...r.genre, "film"] }));
        if (vocabulary(all, roles).terms.some((x) => x.value === "film")) {
            throw new Error("a tag carried by the whole catalogue has no direction and must not survive as a term");
        }
        // And a tag on most of it survives, but must not outrank the one that
        // actually points where the reader is.
        const most = rows.map((r) => (r.genre[0] === "horror" ? r : { ...r, genre: [...r.genre, "feature"] }));
        const v2 = vocabulary(most, roles);
        const a2 = affinities(v2, t.q, { limit: 10 });
        if (!v2.terms.some((x) => x.value === "feature")) throw new Error("a tag on three quarters of the rows is still a term");
        if (a2[0]?.value !== "silent") throw new Error(`bulk must not outrank direction: ${JSON.stringify(a2.slice(0, 3))}`);
    }

    // Co-occurring tags are one fact wearing several words. On the real archive
    // bundle the top four affinities were `fox`, `eek the cat`, `eek` and the
    // voice actor — 59 identical rows, four bullets, one cartoon.
    {
        const dupes = rows.map((r) => (r.genre[0] === "silent" ? { ...r, genre: [...r.genre, "mute", "no-sound", "pre-talkie"] } : r));
        const vd = vocabulary(dupes, roles);
        if (vd.terms.length !== 7) throw new Error(`the aliases must all be terms before ranking: ${vd.terms.length}`);
        const a = affinities(vd, t.q, { limit: 4 });
        const said = a.filter((x) => ["silent", "mute", "no-sound", "pre-talkie"].includes(x.value)).length;
        if (said > 1) throw new Error(`one fact must be said once: ${JSON.stringify(a.map((x) => x.value))}`);
        if (!a.length) throw new Error("…and it must still be said");
    }

    const md = tasteDoc({ t, catalogues: [{ name: "films", rows, roles }], instructions: "  No trailers. Ever.  " });
    if (!md.startsWith("# taste.md")) throw new Error("it is a document, and it says so first");
    if (md.indexOf("No trailers. Ever.") > md.indexOf("What I am drawn to")) throw new Error("what the person wrote comes before what the machine inferred");
    if (!md.includes("**silent**") || md.includes("**newsreel**")) throw new Error("the prose must follow the vectors");
    if (!md.includes("nomic-embed-text-v1.5")) throw new Error("an agent reading this must be told what space q lives in");
    for (const h of ["## Standing instructions", "## What I am drawn to", "## What I pass on", "## Where I am heading", "## What I named", "## For an agent reading this"]) {
        if (!md.includes(h)) throw new Error(`missing section: ${h}`);
    }

    // No taste, and no catalogue: still a document, never a crash, never a
    // fabricated observation.
    const empty = tasteDoc({ t: null, instructions: "" });
    if (!empty.includes("Nothing observed yet")) throw new Error("an empty taste must say so rather than inventing one");
    if (empty.includes("drawn to")) throw new Error("…and must claim nothing");
    if (!tasteDoc({ t, catalogues: [] }).includes("## What I am drawn to")) throw new Error("a taste with no catalogue open still renders its sections");

    // Four picks is where the kernel starts inferring a heading; three is not.
    const few = taste(likes.slice(0, 3), []);
    {
        const doc = tasteDoc({ t: few, catalogues: [{ name: "films", rows, roles }] });
        if (!doc.includes("once four picks")) throw new Error("too few picks for a direction must be stated, not silently omitted");
        // The document must never print a count next to a claim the count
        // contradicts — a carried heading and a carried `n` are independent now.
        if (/\d+ named, four needed/.test(doc)) throw new Error("a reader who named seven things must not be told four are needed");
    }

    console.log("taste-doc.js self-check ok — terms are the publishers' own declared tags above a support floor, "
        + "centred so the catalogue's bulk describes nobody, affinities follow q and rejections follow no, co-occurring tags are said once, "
        + "a heading is read off v and withheld when the kernel has none, the authored section outranks the derived one, "
        + "and an empty taste writes a document rather than an invention");
}
