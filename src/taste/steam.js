// Your Steam library as a taste, without asking Steam.
//
// WHY THIS FILE IS NOT AN API CLIENT
// ----------------------------------
// The obvious way to seed a game recommender is Steam's Web API: issue a key,
// call GetOwnedGames, receive the library. It works, and it means the first
// thing this product does — before it has recommended anything — is tell Valve
// that you asked. For a recommender whose entire argument is that your taste
// stays yours, that is the wrong first move.
//
// Steam already wrote your playtime to your own disk. `localconfig.vdf`, in the
// Steam install under `userdata/<accountid>/config/`, holds one entry per app
// you have launched with `Playtime` in minutes and `LastPlayed` as a unix
// timestamp. It is on the machine of everyone who has Steam installed, it needs
// no key, no login and no network, and reading it is not a request anybody can
// log.
//
// So the consumer path is a file the reader hands over, parsed where it is
// handed over — in the tab, in this module, going nowhere. In a browser that is
// a drop target; in Node it is a path. Same parser, same mapping, and the
// deployment story is "you already have this file" rather than "create an API
// key".
//
// WHAT PLAYTIME IS ALLOWED TO MEAN
// --------------------------------
// `taste.js` takes likes and dislikes, weights them by RECENCY on a half-life,
// and infers a heading from the order. It does not take weights, and this file
// does not add any: playtime decides MEMBERSHIP, `LastPlayed` decides order.
// Sorting by hours instead would tell the kernel that a game you adored in 2021
// is where you are now, which is the one thing the half-life exists to deny.
//
// The three-way split is the part that has to be defensible, because a wrong
// dislike actively steers recommendations away from things you would like —
// `taste.js` applies GAMMA 0.6 to rejections, which is deliberately strong:
//
//   played a lot        → a like. You kept coming back.
//   launched, bounced   → a dislike. You tried it and stopped, which is the
//                         only negative signal a library actually contains.
//   never launched      → NEITHER. An unplayed game in a library is a sale, a
//                         bundle or a backlog, and reading it as a rejection
//                         would punish you for things you have not got to yet.
//
// That last distinction is why `lastPlayed` is checked separately from
// `playtime` rather than folded into one threshold.

/** Minutes of play at or above which a game counts as a like. Two hours is the
 *  refund window: past it you made a decision to keep playing. */
export const LIKE_MINUTES = 120;

/** Minutes below which a LAUNCHED game counts as a bounce. Twenty minutes is
 *  about a tutorial — long enough that "I never actually opened it" is not the
 *  explanation, short enough that "I kept playing" is not either. */
export const BOUNCE_MINUTES = 20;

// ── VDF ─────────────────────────────────────────────────────────────────────
// Valve's KeyValues: `"key" "value"` pairs and `"key" { … }` blocks, tab
// indented, with `//` line comments. A few hundred bytes of parser, and no
// dependency — the alternative is a package that reads a file format that has
// not changed since 2003.

/**
 * VDF text → a nested plain object. Duplicate keys: last wins.
 *
 * Values keep their string form. Everything in this file that wants a number
 * coerces at the point of use, because a VDF holds `"0"` and `""` for the same
 * idea and a parser that guessed would hide that from the caller.
 */
export function parseVdf(text) {
    const s = String(text ?? "");
    let i = 0;

    const skip = () => {
        for (;;) {
            while (i < s.length && /\s/.test(s[i])) i++;
            if (s[i] === "/" && s[i + 1] === "/") {
                while (i < s.length && s[i] !== "\n") i++;
            } else return;
        }
    };

    // A token is either a quoted string (with backslash escapes) or a bare run.
    const token = () => {
        skip();
        if (i >= s.length) return null;
        const c = s[i];
        if (c === "{" || c === "}") { i++; return c; }
        if (c === '"') {
            i++;
            let out = "";
            while (i < s.length && s[i] !== '"') {
                if (s[i] === "\\" && i + 1 < s.length) { out += s[++i]; i++; }
                else out += s[i++];
            }
            i++;                                    // closing quote
            return { str: out };
        }
        let out = "";
        while (i < s.length && !/[\s{}"]/.test(s[i])) out += s[i++];
        return out ? { str: out } : null;
    };

    const block = () => {
        const obj = {};
        for (;;) {
            const k = token();
            if (k === null || k === "}") return obj;
            if (k === "{") continue;                // stray brace — tolerate
            const v = token();
            if (v === null) return obj;
            obj[k.str] = v === "{" ? block() : (typeof v === "object" ? v.str : "");
        }
    };

    const root = {};
    for (;;) {
        const k = token();
        if (k === null) break;
        if (k === "}" || k === "{") continue;
        const v = token();
        if (v === null) break;
        root[k.str] = v === "{" ? block() : (typeof v === "object" ? v.str : "");
    }
    return root;
}

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/**
 * Find the `apps` map anywhere in a parsed config, by SHAPE rather than by path.
 *
 * The documented location is UserLocalConfigStore ▸ Software ▸ Valve ▸ Steam ▸
 * apps, but the casing of those segments is not stable across Steam versions
 * (`valve` and `Valve` both occur in the wild, in the same install), and a
 * hardcoded path that silently misses returns an empty library rather than an
 * error. So: walk the tree, and take any object whose children are numeric keys
 * carrying a Playtime or LastPlayed. Nothing else in the file looks like that.
 */
function findApps(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 8) return null;
    let best = null;
    for (const [key, val] of Object.entries(node)) {
        if (!val || typeof val !== "object") continue;
        if (key.toLowerCase() === "apps") {
            const hit = Object.entries(val).filter(
                ([k, v]) => /^\d+$/.test(k) && v && typeof v === "object" &&
                    ("Playtime" in v || "LastPlayed" in v));
            // Prefer the richest such block — `sharedconfig.vdf` has an `apps`
            // holding only tags, and an install with two of them should not be
            // decided by key order.
            if (hit.length && (!best || hit.length > best.length)) best = hit;
        }
        const deeper = findApps(val, depth + 1);
        if (deeper && (!best || deeper.length > best.length)) best = deeper;
    }
    return best;
}

/**
 * `localconfig.vdf` text → the library, oldest-played first.
 *
 * Oldest first because that is the order `taste.js` wants: it weights by
 * position with the newest LAST, so handing it this array directly makes the
 * half-life mean what it says. Entries Steam has recorded but never timestamped
 * sort to the front, where they carry the least weight — which is also where
 * something you have never launched belongs.
 */
export function steamLibrary(vdfText) {
    const apps = findApps(parseVdf(vdfText)) ?? [];
    return apps
        .map(([appid, v]) => ({
            appid: Number(appid),
            // Steam splits time across `Playtime` and `PlaytimeDisconnected`
            // (offline sessions). Only counting the first understates anyone
            // who plays on a laptop.
            playtime: num(v.Playtime) + num(v.PlaytimeDisconnected),
            lastPlayed: num(v.LastPlayed),
        }))
        .filter((g) => g.appid > 0)
        .sort((a, b) => a.lastPlayed - b.lastPlayed);
}

/** How a single library entry is read. Exported so a caller can show the
 *  reader why a game landed where it did, and so the thresholds are testable
 *  without building a whole taste. */
export function verdictFor({ playtime = 0, lastPlayed = 0 } = {}) {
    if (playtime >= LIKE_MINUTES) return "like";
    if (lastPlayed > 0 && playtime < BOUNCE_MINUTES) return "bounce";
    return "neither";
}

const defaultTitle = (r) => r?.name ?? r?.title ?? r?.id ?? "";

/**
 * A library plus a corpus → the `{likes, dislikes}` `taste()` takes.
 *
 * Rows are matched on `appid`, which is the games corpus's declared identity
 * field, coerced because a shard may carry it as a number or a string. A row's
 * vector is copied straight off the row — nothing is embedded, so this is
 * instant and works with no model loaded.
 *
 * Returns the unmatched appids too. A library is always bigger than any corpus
 * (DLC, delisted games, tools, and whatever the crawl has not reached yet), and
 * a seed that silently dropped half of someone's hours would be indistinguishable
 * from one that worked.
 */
export function seedTaste(library, rows, { title = defaultTitle } = {}) {
    const byId = new Map();
    for (const r of rows ?? []) {
        const a = Number(r?.appid);
        if (Number.isFinite(a) && a > 0 && !byId.has(a)) byId.set(a, r);
    }

    const likes = [], dislikes = [], unmatched = [];
    let played = 0;
    for (const g of library ?? []) {
        const row = byId.get(g.appid);
        if (!row) { unmatched.push(g); continue; }
        if (g.playtime > 0) played += g.playtime;
        const entry = { id: row.id ?? `steam:app:${g.appid}`, title: title(row),
                        vector: row.vector, appid: g.appid, playtime: g.playtime,
                        lastPlayed: g.lastPlayed };
        const v = verdictFor(g);
        if (v === "like" && row.vector) likes.push(entry);
        else if (v === "bounce" && row.vector) dislikes.push(entry);
    }
    return {
        likes, dislikes, unmatched,
        matched: library ? library.length - unmatched.length : 0,
        hours: Math.round(played / 60),
    };
}

/** A one-line account of what a seed actually used, for the reader who is
 *  about to be recommended things because of it. */
export const summarize = (seed) =>
    `${seed.matched} of ${seed.matched + seed.unmatched.length} games matched the corpus · ` +
    `${seed.hours} hours · ${seed.likes.length} liked, ${seed.dislikes.length} bounced off`;

// ── self-check: `node src/taste/steam.js` ─────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/steam.js")) {
    // A localconfig.vdf, cut down but structurally exact — including the mixed
    // casing of the Valve/valve segment that defeats a hardcoded path.
    const VDF = `
"UserLocalConfigStore"
{
	"Software"
	{
		"valve"
		{
			"Steam"
			{
				"apps"
				{
					"730"
					{
						"LastPlayed"		"1788064199"
						"Playtime"		"4240"
					}
					"381210"
					{
						"LastPlayed"		"1787000000"
						"Playtime"		"47500"
						"PlaytimeDisconnected"		"280"
					}
					"570"
					{
						"LastPlayed"		"1525632471"
						"Playtime"		"6"
					}
					"12345"
					{
						"Playtime"		"0"
					}
					"999999"
					{
						"LastPlayed"		"1600000000"
						"Playtime"		"3000"
					}
				}
			}
		}
	}
}`;

    const lib = steamLibrary(VDF);
    if (lib.length !== 5) throw new Error(`five apps, got ${lib.length}`);
    // Oldest first — the order taste.js weights by position expects.
    if (lib[lib.length - 1].appid !== 730) throw new Error("newest-played must sort LAST");
    if (lib[0].appid !== 12345) throw new Error("an entry with no LastPlayed sorts first, where it counts least");
    const dbd = lib.find((g) => g.appid === 381210);
    if (dbd.playtime !== 47500 + 280) throw new Error("offline playtime must count — it is the same hours");

    // The three-way split, which is the only judgement this file makes.
    if (verdictFor({ playtime: 4240, lastPlayed: 1 }) !== "like") throw new Error("70 hours is a like");
    if (verdictFor({ playtime: 6, lastPlayed: 1 }) !== "bounce") throw new Error("launched and quit at 6 minutes is a bounce");
    if (verdictFor({ playtime: 0, lastPlayed: 0 }) !== "neither") throw new Error("never launched is NOT a rejection");
    if (verdictFor({ playtime: 60, lastPlayed: 1 }) !== "neither") throw new Error("an hour is neither — it is ambiguous and must stay so");

    // Mapping onto a corpus.
    const row = (appid, name, vector) => ({ id: `steam:app:${appid}`, appid, name, vector: Float32Array.from(vector) });
    const rows = [row(730, "Counter-Strike 2", [1, 0]), row(381210, "Dead by Daylight", [0.9, 0.1]),
                  row(570, "Dota 2", [0, 1]), row(12345, "Unplayed Thing", [0, 1])];

    const seed = seedTaste(lib, rows);
    if (seed.likes.map((l) => l.appid).join() !== "381210,730") throw new Error(`likes wrong / mis-ordered: ${seed.likes.map((l) => l.appid)}`);
    if (seed.dislikes.length !== 1 || seed.dislikes[0].appid !== 570) throw new Error("the bounce must be the only dislike");
    if (seed.likes.some((l) => l.appid === 12345) || seed.dislikes.some((d) => d.appid === 12345))
        throw new Error("an unplayed game must not enter the taste at all");
    if (seed.matched !== 4 || seed.unmatched[0].appid !== 999999)
        throw new Error("a library game absent from the corpus must be reported, not silently dropped");
    if (seed.hours !== Math.round((4240 + 47780 + 6) / 60)) throw new Error(`hours wrong: ${seed.hours}`);

    // A shard may carry appid as a string; a seed that missed on that would
    // match nothing and look exactly like a library with no games in the corpus.
    const strRows = rows.map((r) => ({ ...r, appid: String(r.appid) }));
    if (seedTaste(lib, strRows).likes.length !== 2) throw new Error("appid must match across string/number");

    // A row with no vector cannot enter a taste — it would be a like the kernel
    // cannot average.
    if (seedTaste(lib, [{ id: "x", appid: 730, name: "no vector" }]).likes.length)
        throw new Error("a vectorless row must not become a like");

    // …and the whole point: this seed drives taste.js unchanged.
    const { taste, recommend } = await import("./taste.js");
    const t = taste(seed.likes, seed.dislikes);
    if (!t) throw new Error("a real library must produce a taste");
    const pool = [row(1, "another shooter", [0.95, 0.05]), row(2, "another moba", [0.05, 0.95])];
    if (recommend(pool, t)[0].row.name !== "another shooter")
        throw new Error("a taste seeded from Steam must rank an unseen pool by it");

    // Degenerate inputs return nothing rather than throwing — this parser is
    // pointed at a file a stranger dropped on a page.
    if (steamLibrary("").length || steamLibrary("garbage {{{").length) throw new Error("junk must parse to an empty library, not throw");
    if (seedTaste([], rows).likes.length || seedTaste(null, null).matched !== 0) throw new Error("an empty library is an empty seed");
    if (parseVdf('"a" "b" // trailing comment\n').a !== "b") throw new Error("comments must be skipped");
    if (parseVdf('"a" "say \\"hi\\""').a !== 'say "hi"') throw new Error("escaped quotes must survive");

    console.log(`steam.js self-check ok — VDF parsed by shape not path, offline hours counted, ` +
                `newest-played sorts last for the half-life, unplayed is not a rejection, ` +
                `${summarize(seed)}`);
}
