// Taste as a portable object.
//
// Every corpus on this network is embedded by the same model into the same
// 256-d space. That is usually described as a compatibility requirement — the
// directory refuses to rank a corpus baked with a different model, because
// cosine between two models' vectors is noise. But it buys something nobody
// asked for and nothing else offers:
//
//   a taste learned in ONE publisher's corpus applies directly to ANOTHER'S.
//
// Not by matching ids — there are none in common. Not by a shared schema —
// there isn't one. A film and a video game have no field in common, no
// publisher in common, and no agreement of any kind beyond the embedding. Point
// a vector built from four films you liked at a corpus of games, and it ranks
// them, because both live in the same space.
//
// Every recommender that exists keeps its embedding private, which is precisely
// what makes taste non-portable: your taste is an asset of whoever holds the
// model. Here the model is public and the vectors are in files you already
// downloaded, so the taste is a ~350-byte object you own and can carry.
//
// The state is the session kernel from sond3r's src/geometry/kernel.js, cut to
// what is portable:
//
//   mu — recency-weighted mean of what you liked   (where you are)
//   v  — recent mean minus older mean              (where you're heading)
//   q  — mu nudged along v                         (the lookahead you rank with)
//   no — mean of what you rejected                 (where you are NOT going)

import { packVec, unpackVec } from "./embed.js";
import { cosine, diversify, norm } from "./rank.js";

const dim = (vs) => vs.reduce((n, v) => Math.max(n, v.length), 0);

function weightedMean(vs, weights) {
    const d = dim(vs);
    if (!d) return null;
    const out = new Float32Array(d);
    let wsum = 0;
    vs.forEach((v, i) => {
        const w = weights[i];
        wsum += w;
        for (let j = 0; j < v.length; j++) out[j] += v[j] * w;
    });
    if (!wsum) return null;
    for (let j = 0; j < d; j++) out[j] /= wsum;
    return out;
}

const unit = (v) => { if (!v) return null; const n = norm(v); const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = v[i] / n; return o; };

/** How fast older picks stop counting. 8 means the 8th-most-recent like carries
 *  half the weight of the newest — taste that never forgets is a taste you
 *  cannot steer, and the whole point of `v` is that it can move. */
export const HALF_LIFE = 8;

/**
 * Build a taste from what someone liked and rejected, newest LAST.
 *
 * `likes` and `dislikes` are `{ id, title, vector }`. Vectors come straight off
 * the rows — no re-embedding, so this costs nothing and works offline.
 *
 * `drift` is how far `q` leans past where you are toward where you are heading.
 * 0 ranks what you already like (a mirror); high overshoots into things you
 * have shown no sign of wanting. The default leans, and it is the knob the
 * product means when it says you own the algorithm.
 */
export function taste(likes = [], dislikes = [], { drift = 0.35 } = {}) {
    const seen = likes.filter((l) => l?.vector?.length);
    if (!seen.length) return null;
    const w = seen.map((_, i) => Math.pow(0.5, (seen.length - 1 - i) / HALF_LIFE));
    const mu = unit(weightedMean(seen.map((l) => l.vector), w));

    // Where it is heading: the recent half minus the older half. With too few
    // picks there is no "older half" and a direction would be invented from
    // nothing, so it stays null and `q` is just `mu`.
    let v = null;
    if (seen.length >= 4) {
        const cut = Math.floor(seen.length / 2);
        const recent = weightedMean(seen.slice(cut).map((l) => l.vector), w.slice(cut));
        const older = weightedMean(seen.slice(0, cut).map((l) => l.vector), w.slice(0, cut));
        if (recent && older) {
            const d = new Float32Array(recent.length);
            for (let i = 0; i < d.length; i++) d[i] = recent[i] - older[i];
            if (norm(d) > 1e-6) v = unit(d);
        }
    }

    const q = new Float32Array(mu.length);
    for (let i = 0; i < q.length; i++) q[i] = mu[i] + (v ? drift * v[i] : 0);

    const neg = dislikes.filter((d) => d?.vector?.length);
    const no = neg.length ? unit(weightedMean(neg.map((d) => d.vector), neg.map(() => 1))) : null;

    return {
        mu, v, q: unit(q), no, drift,
        from: seen.map((l) => l.title ?? l.id).slice(-12),
        rejected: neg.map((d) => d.title ?? d.id).slice(-12),
        n: seen.length,
    };
}

/** How hard a rejection pushes its neighbours away. 0.6, taken from sond3r's
 *  session kernel rather than picked here: a dislike is the only thing a person
 *  ever says explicitly, and it has to visibly beat a direction the kernel
 *  merely inferred, or pressing the button feels like it did nothing. Two
 *  different values across two surfaces would make the same rejection mean two
 *  different things. */
export const GAMMA = 0.6;

/**
 * Score a row against a taste. Attraction to `q`, minus repulsion from what was
 * rejected.
 *
 * The subtraction matters more than it looks: without it, "not that" is
 * unexpressible and a taste can only ever be refined toward things it already
 * matches. Clamped at zero, so a row on the far side of the space from a
 * rejection gets no bonus for it — being unlike something you disliked is not
 * evidence of anything.
 */
export const score = (row, t) => {
    if (!row?.vector || !t) return null;
    const r = { vector: row.vector, norm: row.norm ?? norm(row.vector) };
    const pos = cosine(r, t.q, norm(t.q));
    if (!t.no) return pos;
    return pos - GAMMA * Math.max(0, cosine(r, t.no, norm(t.no)));
};

/** The best `limit` rows for a taste. `exclude` drops rows the taste was built
 *  from — recommending someone the thing they just told you they liked is the
 *  oldest failure in the genre. */
export function recommend(rows, t, { limit = 10, exclude = new Set(), lambda = 0.7 } = {}) {
    if (!t) return [];
    const ranked = rows
        .filter((r) => r.vector && !exclude.has(r.id))
        .map((r) => ({ row: r, s: score(r, t) }))
        .sort((a, b) => b.s - a.s);
    // Not `.slice(limit)`. Taken by score alone this returned five episodes of
    // one series out of six — near-duplicates are adjacent in the space by
    // construction, so the top of any list is the same thing said repeatedly.
    // `lambda: 1` restores the pure ranking for a caller that wants it.
    return diversify(ranked, { limit, lambda })
        .map(({ row, s }) => ({ row, score: Number(s.toFixed(4)) }));
}

/**
 * A taste, small enough to paste.
 *
 * Vectors as base64 int8 — the same encoding the shards use — so the whole
 * object is a few hundred bytes and survives a chat message, a file, a URL. It
 * carries the TITLES it was built from as well, because a taste you cannot read
 * is a taste you cannot correct, and this is a thing a person is meant to own
 * rather than a profile held about them.
 */
export const exportTaste = (t) => t && ({
    v: 1, model: "nomic-256", drift: t.drift, n: t.n,
    q: packVec(Array.from(t.q)),
    mu: packVec(Array.from(t.mu)),
    // The heading, not just the position. `q` is `mu + drift·v`, so an export
    // that dropped `v` produced an object whose ranking still leaned on a
    // direction it then denied having — the next session was told "not enough
    // picks to infer a direction" while ranking by one. It is one more packed
    // vector; a taste that cannot say which way it is going is not worth the
    // saving.
    ...(t.v ? { d: packVec(Array.from(t.v)) } : {}),
    ...(t.no ? { no: packVec(Array.from(t.no)) } : {}),
    from: t.from, rejected: t.rejected,
});

export function importTaste(obj) {
    if (!obj?.q) return null;
    const q = unpackVec(obj.q), mu = unpackVec(obj.mu ?? obj.q);
    if (!q) return null;
    return { q, mu: mu ?? q, v: obj.d ? unpackVec(obj.d) : null, no: obj.no ? unpackVec(obj.no) : null,
             drift: obj.drift ?? 0.35, from: obj.from ?? [], rejected: obj.rejected ?? [], n: obj.n ?? 0 };
}

/** The id a restored session is folded into. A previous visit comes back as ONE
 *  like carrying the old `q`, which is what lets the half-life work without
 *  anyone deciding when to forget — but a collapse is not a deletion, and the
 *  titles are the only part of a taste a person can actually check. */
export const REMEMBERED = "(remembered";

/**
 * A taste that still knows what it was built from, across that collapse.
 *
 * Without this, `taste(likes)` recomputes `from` off the surviving array, so a
 * restored session reports `n: 1` and one synthetic title — and re-exporting
 * that writes the loss to disk. Every reload then forgets a little more, which
 * is the exact failure a document about your own preferences cannot have.
 *
 * `carried` is what the last export said about itself; `likes`/`dislikes` are
 * the entries named in THIS session. The vector is untouched — this restores
 * only the provenance the collapse dropped.
 */
export function withProvenance(t, { carried = null, likes = [], dislikes = [] } = {}) {
    if (!t) return t;
    const c = carried ?? { from: [], rejected: [], n: 0 };
    const own = (xs) => xs.filter((x) => !String(x?.id ?? "").startsWith(REMEMBERED)).map((x) => x.title ?? x.id);
    const mine = own(likes);
    return {
        ...t,
        // The restored session is one entry, so the kernel cannot compute a
        // direction from it and returns null. The direction it HAD is on the
        // carried object and is still the one baked into the carried `q`, so it
        // stands until this session has enough picks to compute its own.
        v: t.v ?? c.v ?? null,
        from: [...(c.from ?? []), ...mine].slice(-12),
        rejected: [...(c.rejected ?? []), ...own(dislikes)].slice(-12),
        n: (c.n ?? 0) + mine.length,
    };
}

// ── self-check: `node consume/taste.js` ─────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}`) {
    const R = (id, vector, title = id) => ({ id, title, vector: Float32Array.from(vector), norm: norm(vector) });
    // A toy 3-d space: x = "bleak", y = "comic", z = "documentary".
    const bleak = [1, 0, 0], comic = [0, 1, 0], doc = [0, 0, 1];
    const mix = (a, b, f) => a.map((x, i) => x * (1 - f) + b[i] * f);

    // Taste from three bleak things.
    let t = taste([R("a", bleak), R("b", mix(bleak, doc, 0.2)), R("c", mix(bleak, doc, 0.1))]);
    if (!t) throw new Error("three likes must make a taste");
    if (t.v !== null) throw new Error("under four picks there is no older half — direction must not be invented");
    if (cosine({ vector: t.q, norm: norm(t.q) }, Float32Array.from(bleak), 1) < 0.9) throw new Error("q must sit near what was liked");

    // Ranking a DIFFERENT pool with it — the whole point.
    const pool = [R("x", comic, "a comedy"), R("y", mix(bleak, doc, 0.15), "a bleak documentary"), R("z", doc, "a documentary")];
    if (recommend(pool, t)[0].row.title !== "a bleak documentary") throw new Error("taste must rank an unseen pool");

    // Drift: four picks moving from bleak toward comic must lean the lookahead
    // PAST where they are, or `v` is decoration.
    const moving = [R("1", bleak), R("2", mix(bleak, comic, 0.2)), R("3", mix(bleak, comic, 0.4)), R("4", mix(bleak, comic, 0.6))];
    t = taste(moving);
    if (t.v === null) throw new Error("four picks must yield a direction");
    const cq = cosine({ vector: t.q, norm: norm(t.q) }, Float32Array.from(comic), 1);
    const cm = cosine({ vector: t.mu, norm: norm(t.mu) }, Float32Array.from(comic), 1);
    if (!(cq > cm)) throw new Error(`q must lean further toward where it is heading than mu: ${cq} vs ${cm}`);
    // drift 0 is a mirror, not a lookahead.
    const still = taste(moving, [], { drift: 0 });
    if (cosine({ vector: still.q, norm: norm(still.q) }, still.mu, norm(still.mu)) < 0.999) throw new Error("drift 0 must be mu");

    // Rejection has to FLIP the answer, or "not that" is unexpressible. The
    // taste leans comic, so comic wins until it is rejected. (A taste sitting
    // exactly between the two options ties, and a tie proves nothing — which is
    // what the first version of this test accidentally measured.)
    const liked = [R("p", mix(bleak, comic, 0.7))];
    const opts = [R("m", bleak, "bleak"), R("n", comic, "comic")];
    if (recommend(opts, taste(liked))[0].row.title !== "comic") throw new Error("sanity: the taste leans comic");
    if (recommend(opts, taste(liked, [R("q", comic)]))[0].row.title !== "bleak") throw new Error("rejecting comic must flip the ranking to bleak");

    // Never recommend back what it was built from.
    const seenRow = R("a", bleak, "the one they liked");
    const rec = recommend([seenRow, R("other", mix(bleak, doc, 0.1), "similar")], taste([seenRow]), { exclude: new Set(["a"]) });
    if (rec.some((r) => r.row.id === "a")) throw new Error("must not recommend what the taste was built from");

    // Portability: export → import → same ranking. This is the object a person
    // carries between two publishers who share nothing but a model.
    t = taste(moving);
    const wire = exportTaste(t);
    const size = JSON.stringify(wire).length;
    const back = importTaste(wire);
    if (!back) throw new Error("a taste must survive the round trip");
    const A = recommend(pool, t).map((r) => r.row.id).join();
    const B = recommend(pool, back).map((r) => r.row.id).join();
    if (A !== B) throw new Error(`ranking changed across the wire: ${A} vs ${B}`);
    if (!wire.from.length) throw new Error("a taste must say what it was built from, or it cannot be corrected");
    if (!t.v) throw new Error("this fixture is meant to have a heading");
    if (!back.v) throw new Error("a heading must survive the wire — q leans on it, so an export without it lies");
    if (cosine({ vector: back.v, norm: norm(back.v) }, t.v, norm(t.v)) < 0.98) throw new Error("…and must survive it intact");
    if (importTaste({}) !== null || importTaste(null) !== null) throw new Error("a malformed taste must be null, not a crash");

    if (taste([]) !== null) throw new Error("no likes is no taste, not an empty one");
    if (recommend(pool, null).length) throw new Error("no taste recommends nothing");
    if (score({ vector: null }, t) !== null) throw new Error("a vectorless row scores null, not NaN");

    // A pool that is mostly one thing must not come back as one thing.
    //
    // Four near-identical rows clustered at 0°, one different row at 60°, and a
    // taste pointing at 30° so the cluster and the outlier score the SAME. By
    // relevance alone the cluster wins all three slots, which is the North of 60
    // failure exactly; MMR has to spend one of them on the outlier.
    {
        const at = (id, deg) => {
            const a = (deg * Math.PI) / 180;
            return { id, vector: [Math.cos(a), Math.sin(a)], norm: 1 };
        };
        const pool = [at("run1", 0), at("run2", 0.8), at("run3", 1.6), at("run4", 2.4), at("other", 60)];
        const tt = taste([{ id: "seed", ...at("seed", 30) }]);
        const pure = recommend(pool, tt, { limit: 3, lambda: 1 }).map((h) => h.row.id);
        if (pure.some((i) => i === "other")) throw new Error(`relevance alone must fill up with the run: ${pure}`);
        const mixed = recommend(pool, tt, { limit: 3 }).map((h) => h.row.id);
        if (!mixed.includes("other")) throw new Error(`MMR must spend a slot on something else: ${mixed}`);
        if (mixed[0] !== pure[0]) throw new Error(`the best match must still come first: ${mixed[0]} vs ${pure[0]}`);
    }

    // Provenance across the restore collapse. A session that comes back as one
    // synthetic like must not report itself as one pick, and re-exporting must
    // not write that loss to disk — a taste that forgets a little on every
    // reload is one nobody can check.
    {
        const first = taste([R("a", bleak, "The Golem"), R("b", comic, "Nosferatu"), R("c", doc, "Metropolis")], [R("z", doc, "Wrestling")]);
        const saved = exportTaste(first);
        if (saved.n !== 3 || saved.from.length !== 3) throw new Error("a fresh export carries what it was built from");

        // …the next visit, exactly as the page restores it.
        const back = importTaste(saved);
        const likes = [{ id: "(remembered)", title: `what you liked before · ${back.n} picks`, vector: back.q }];
        const dislikes = back.no ? [{ id: "(remembered-no)", title: "what you passed on before", vector: back.no }] : [];
        if (exportTaste(taste(likes, dislikes)).n !== 1) throw new Error("this is the loss the next assertion is about");

        const kept = exportTaste(withProvenance(taste(likes, dislikes), { carried: back, likes, dislikes }));
        if (kept.n !== 3) throw new Error(`a restored taste must not report itself as one pick: ${kept.n}`);
        if (!kept.from.includes("Nosferatu")) throw new Error("…and must still name what it was built from");
        if (kept.from.some((f) => f.startsWith("(remembered"))) throw new Error("the synthetic placeholder is not a title");
        if (!kept.rejected.includes("Wrestling")) throw new Error("rejections are provenance too");

        // …and a NEW pick this session lands beside the old ones, once.
        const more = [...likes, R("d", comic, "Sunrise")];
        const grown = exportTaste(withProvenance(taste(more, dislikes), { carried: back, likes: more, dislikes }));
        if (grown.n !== 4) throw new Error(`a new pick must count once: ${grown.n}`);
        if (grown.from.filter((f) => f === "Nosferatu").length !== 1) throw new Error("…and must not duplicate the carried ones");

        // A heading outlives the collapse too, and gives way to a fresh one.
        {
            const m4 = taste([R("p", bleak, "1"), R("q", mix(bleak, comic, .3), "2"), R("r", mix(bleak, comic, .6), "3"), R("s", comic, "4")]);
            const carried4 = importTaste(exportTaste(m4));
            const one = [{ id: "(remembered)", title: "before", vector: carried4.q }];
            const held = withProvenance(taste(one), { carried: carried4, likes: one });
            if (!held.v) throw new Error("a restored session must keep the heading its own q was built with");
            if (taste(one).v) throw new Error("…which the kernel alone cannot supply from one entry");
        }

        // Idempotent: reload twice, nothing drifts.
        const twice = exportTaste(withProvenance(taste(likes, dislikes), { carried: importTaste(kept), likes, dislikes }));
        if (twice.n !== 3 || twice.from.join() !== kept.from.join()) throw new Error("a second reload must change nothing");
    }

    console.log(`taste.js self-check ok — mu/v/q, drift leans forward, rejection steers, portable in ${size}B, ranks a pool it never saw, MMR keeps a run of near-duplicates from filling the list, provenance and heading survive the restore collapse and do not drift on reload`);
}
