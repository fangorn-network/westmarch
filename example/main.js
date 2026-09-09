// A corpus, five WebMCP verbs, and a window onto what the agent is doing.
//
// There is no player and no storefront here on purpose. The page's job is to
// show that @fangorn/westmarch + `document.modelContext` is a complete agent
// backend with no server of its own: the 42,215-row archive.org bundle streams
// into the tab, the tools run on it in the tab, and the query never leaves.
//
// So the UI is telemetry. Left: what loaded, and what the corpus turns out to
// contain (the agent's `describe`, rendered). Right: every tool call as it
// happens — arguments, latency, result size — because watching an agent work
// out a corpus it has never seen is the thing worth looking at.
import { configure, domainManifests, loadShard, setView, trimView, watchShard } from "@fangorn/westmarch/shard";
import { findCorpora, sourcesFromRegistry } from "@fangorn/westmarch/directory";
import { follow, merge, session } from "@fangorn/westmarch/corpora";
import { diversify } from "@fangorn/westmarch/rank";
import { bars, rankedList, record, shapeOf, stage, stageItems, uiResource } from "@fangorn/westmarch/ui";
import { exportTaste, importTaste, recommend, taste, withProvenance } from "@fangorn/westmarch/taste";
import { tasteDoc } from "@fangorn/westmarch/taste-doc";
import { actionsOf, collections, gatesOf, linkOf, priceLabel, rolesFrom, subtitleOf, textOf, titleOf, typeOf, values } from "@fangorn/westmarch/roles";
import { EMBED_MODEL, embedQuery, warmEmbedder } from "@fangorn/westmarch/embed";
import { seedTaste, steamLibrary, summarize as steamSummary } from "@fangorn/westmarch/steam";
import { FREE, LOCKED, reactionCorpus } from "@fangorn/westmarch/reactions";
import { MIN_COHORT, SLOTS, contribute, keypair, statistics } from "@fangorn/westmarch/cohort";
import { brief, browse, describe, facet, getRow, neighbors, search } from "./tools.js";

// The view: `serve-embeddings.js` in the sond3r repo, or any quickbeam view.
//   node scripts/serve-embeddings.js archive-videos-test-2.embeddings.ndjson
const Q = new URLSearchParams(location.search);
// The demo network: four independent publishers, proxied same-origin by vite.
// A bare URL used to boot onto an empty view with no directory, which is a page
// that cannot tell you what it is — the first thing a person sees has to be a
// working example, not a red `load failed`.
// Films first, and the order is load-bearing now that arriving PLAYS: boot
// streams SOURCES[0] and presents whatever is open, so whichever corpus is named
// here decides what a person sees in their first ten seconds. `games` was first
// while the arrival state was a list of titles, where it cost nothing; it has no
// media on any row, so as an opening queue it is twelve Wikipedia summaries.
// The archive bundle is 20 MB and paints as it streams, which is the right
// trade for the one screen that has to make the case by itself.
const DEMO = ["/archive-films", "/games", "/archive-transcripts", "/places"];
// Every corpus this page can reach. A registry namespace resolves to exactly
// this list (see directory.js `sourcesFromRegistry`); passing it directly means
// the directory works from a pasted URL, a local file, or a chain-published
// registry with no code change.
let SOURCES = (Q.get("sources") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
if (!SOURCES.length) SOURCES = DEMO;
const VIEW = Q.get("view") ?? SOURCES[0];
// …or `?registry=<view>`, a quickbeam view holding the `apps:` namespace. Same
// list either way — the registry is a baked domain like any other, so discovery
// of publishers is a shard read, not an API. This is the difference between a
// page that knows about the corpora someone typed into its URL and one that
// finds what has been registered on chain since it was written.
const REGISTRY = Q.get("registry") ?? "";
let PUBLISHERS = [];
async function discover() {
    if (!REGISTRY) return;
    try {
        PUBLISHERS = await sourcesFromRegistry(REGISTRY);
        // Objects, not strings: the directory carries publisher name and owner
        // through to every listing, so an agent can say WHOSE corpus it opened.
        SOURCES = [...PUBLISHERS, ...SOURCES];
    } catch (e) {
        console.warn(`registry ${REGISTRY} unreadable —`, e);
        $("dirMeta").textContent = `registry unreadable: ${e.message}`;
    }
}
configure({
    resolveView: () => VIEW,
    // Not a field list. The prose a query matches is whatever THIS bundle's
    // publisher declared as its text role, and `roles` is rebuilt from the
    // manifests the moment they land — before any row is parsed, so the first
    // row through toRow already has the right text.
    // Per view, not global. Two corpora declare different text roles, and the
    // second one loaded would otherwise be parsed with the first one's — which
    // is not an error, it is search quietly matching nothing.
    onManifests: (ms, view) => {
        const c = slot(view);
        c.roles = rolesFrom(ms);
        c.name = ms[0]?.name ?? c.name;
    },
    rowText: (f, view) => textOf(f, slot(view).roles),
});

const $ = (id) => document.getElementById(id);
const num = (n) => n.toLocaleString();

// ── state ───────────────────────────────────────────────────────────────────
//
// A map of corpora, not one corpus, and that single change is what makes a
// cross-publisher question answerable at all. The page used to hold exactly one:
// open-corpus called resetShard(), so opening the games bundle threw the films
// away and "which of these games matches the films I liked" was two separate
// answers a person had to join by hand.
//
// Nothing in the library had to change to allow it — shard.js already caches
// rows and manifests keyed by view. What was singular was this page's idea of
// "the" corpus, plus the two configure() hooks, which now say which view they
// are running for.
const S = session({ blankRoles: () => rolesFrom([], []) });
const { slot, loaded, at, span } = S;
const CORPORA = S.map;
const calls = []; // newest first, capped — this is a window, not a log file
let open = null;  // the collection the person is looking at, or null for all
let known = [];   // every corpus the directory can see, ranked if a query was typed
let ranked = false; // …and whether it actually was
// The taste, and the rows it was built from. Deliberately NOT reset by
// open-corpus: carrying it across corpora is the entire point — it is a vector
// in a space every publisher shares, not a profile scoped to one of them.
let liked = [], disliked = [];

// The LOG, which is a different object from the taste and has to be.
//
// `liked`/`disliked` are the kernel's inputs, and they COLLAPSE: a restored
// session folds a whole previous visit into one synthetic entry carrying the old
// `q`, which is exactly right for a half-life and destroys the evidence. But the
// evidence is the thing with economic value — `publish/reactions.js` sells a log,
// `publish/cohort.js` answers a publisher's question by counting one, and neither
// can run on a vector that has forgotten what it was built from.
//
// So every reaction is also appended here, whole: which row, in which corpus,
// which way, and when. This is the file that would be a surveillance record if
// anyone but the reader held it. Nobody does — it is in this tab, and the two
// verbs that let it leave (`share-reactions`, `answer-question`) are the only
// ones on the page that say out loud what they disclose before they do it.
let reactions = [];

// The Steam file, if one has been dropped on the page this session.
//
// Held in a variable and never written anywhere: it is a list of everything the
// person has played, and the argument this page makes is that such a list can be
// used without being stored or sent. Storing it "for convenience" would be the
// first small betrayal of exactly the claim the verb is here to demonstrate.
let droppedVdf = "";

const REACTIONS_KEY = "westmarch.reactions";
/** Enough to answer a cohort question and price a corpus; not a lifetime. */
const REACTION_CAP = 2000;

function noteReaction(row, corpus, reaction, title) {
    if (!row?.vector) return;
    reactions.push({ id: row.id, corpus, title, reaction, at: Date.now(),
                     vector: row.vector });
    if (reactions.length > REACTION_CAP) reactions = reactions.slice(-REACTION_CAP);
    saveReactions();
}

function saveReactions() {
    try {
        // Vectors are the bulk and they are recoverable from the corpus by id,
        // so the stored log keeps the facts and drops the floats. A reader who
        // comes back to a corpus that is gone has lost the ability to SELL the
        // log, which is the correct failure — the reactions were about rows that
        // no longer exist.
        localStorage.setItem(REACTIONS_KEY, JSON.stringify(
            reactions.map(({ vector, ...rest }) => rest)));
    } catch { /* private window, or over quota — the log is not worth a crash */ }
}

function restoreReactions() {
    try {
        const saved = JSON.parse(localStorage.getItem(REACTIONS_KEY) || "[]");
        reactions = Array.isArray(saved) ? saved : [];
    } catch { reactions = []; }
}

/** Re-attach vectors to a restored log from whatever corpora are open now.
 *  A reaction whose row cannot be found keeps its facts and stays out of
 *  anything that needs a vector — it is history, not signal. */
function rehydrate() {
    let found = 0;
    for (const r of reactions) {
        if (r.vector) { found++; continue; }
        for (const c of loaded()) {
            const row = c.rows.find((x) => x.id === r.id);
            if (row?.vector) { r.vector = row.vector; found++; break; }
        }
    }
    return found;
}

// …and it survives the tab. `exportTaste` already produces a few hundred bytes
// of base64 int8 in the shared embedding space, which is the whole portable
// artefact — no ids, no corpus, nothing that needs a publisher to still be up.
//
// Restored as a LIKE rather than as state, so the half-life in `taste()` does
// the right thing on its own: what you picked today outweighs what you picked in
// March, and nothing has to decide when to forget. This is the only sense in
// which the page "learns" — it changes what you are shown, never how the page
// looks. An interface that recolours itself by topic is a page you cannot
// recognise twice.
// Sets: the one thing an agent can MAKE here.
//
// Every other verb reads. An agent that has just worked out which eight things
// go together has nowhere to put the answer except back into the chat, where it
// dies — so "build me a playlist to go with this game" was a question the tool
// surface could answer and then immediately forget.
//
// A set stores the `brief()` of each row, not a pointer to it. A saved playlist
// has to render tomorrow without re-downloading 21,000 rows from a publisher who
// may be offline, and an ordered list of titles someone curated is worth more
// than the corpus it came from. It is also, deliberately, the shape a publisher
// bakes: rows with an order and a name is what a collection IS on this network.
const SETS_KEY = "westmarch.sets";
const readSets = () => { try { return JSON.parse(localStorage.getItem(SETS_KEY) || "{}"); } catch { return {}; } };
const SETS = readSets();
const saveSets = () => { try { localStorage.setItem(SETS_KEY, JSON.stringify(SETS)); } catch { /* private window */ } };

const TASTE_KEY = "westmarch.taste";
// What the last visit's export said about itself. `restoreTaste` folds a whole
// previous session into ONE like carrying the old `q` — which is what lets the
// half-life work without anyone deciding when to forget — and the titles would
// go with it. They are the only part of a taste a person can check, so they are
// carried across the collapse rather than recomputed from what survived it.
let carried = null;

/** The taste as it should be reported: the kernel's vectors, the session's real
 *  provenance. Every reader of the taste goes through here, or the two disagree
 *  about how many things you have named. */
const mine = () => withProvenance(taste(liked, disliked), { carried, likes: liked, dislikes: disliked });

function saveTaste() {
    const t = mine();
    try { localStorage.setItem(TASTE_KEY, t ? JSON.stringify(exportTaste(t)) : ""); } catch { /* private window */ }
    // …and the link to the mirror carries the count. A nav item that never
    // changes is one nobody clicks twice; one that ticks up as you react is the
    // only signal on this page that something is being kept about you at all.
    const n = (t?.n ?? 0) + (t?.rejected?.length ?? 0);
    const el = $("navCount");
    if (el) el.textContent = n ? String(n) : "";
}
function restoreTaste() {
    let t = null;
    try { t = importTaste(JSON.parse(localStorage.getItem(TASTE_KEY) || "null")); } catch { return null; }
    if (!t?.q) return null;
    carried = { from: t.from ?? [], rejected: t.rejected ?? [], n: t.n ?? 0 };
    liked.push({ id: "(remembered)", title: `what you liked before · ${t.n ?? 0} picks`, vector: t.q });
    if (t.no) disliked.push({ id: "(remembered-no)", title: "what you passed on before", vector: t.no });
    return t;
}

// ── the directory: what is out there, for a person ──────────────────────────
//
// The page used to show only the corpus it had open, which meant a human could
// not see that anything else existed — the agent could route and the person
// could not. Same data either way: `find-corpora` and this panel read the same
// catalogs, so what an agent is told and what a person is shown cannot drift.
async function survey(query = "") {
    if (!SOURCES.length) return paintDirectory();
    $("dirMeta").textContent = query ? "ranking…" : "reading catalogs…";
    try {
        const r = await findCorpora(query, { sources: SOURCES, embed: embedQuery, model: EMBED_MODEL, limit: 50 });
        known = r.corpora;
        ranked = r.ranked;
        const bits = [`${r.searched} corpora`];
        if (r.ranked) bits.push(`${r.relevant} about this question · nothing downloaded to find out`);
        // Say what is missing and why, rather than showing a short list that
        // looks complete. A publisher being down is not the same as not existing.
        if (r.unreachable?.length) bits.push(`${r.unreachable.length} unreachable`);
        if (r.mismatched?.length) bits.push(`${r.mismatched.length} other model`);
        if (r.ranked === false && r.why) bits.push(`unranked (${r.why})`);
        $("dirMeta").textContent = bits.join(" · ");
    } catch (e) {
        $("dirMeta").textContent = `directory failed: ${e.message}`;
    }
    paintDirectory();
}

function paintDirectory() {
    $("directory").innerHTML = known.map((c) => {
        // Three states now, not two: not loaded, loaded, and loaded-and-focused.
        // Several corpora can be open at once, so "open" can no longer mean "the
        // one you are looking at".
        const held = CORPORA.get(c.view)?.rows.length ? true : false;
        const on = held && c.view === S.focus;
        const price = c.paywall
            ? `${(Number(c.paywall.price) / 1e6).toFixed(2)} ${c.paywall.asset} · ${c.paywall.locked} fields locked`
            : "everything free";
        // Three states, and conflating any two of them misleads. No question was
        // asked (show nothing); asked, and this corpus published no coverage so
        // it CANNOT be ranked; asked and scored. "Unrankable" on a corpus nobody
        // asked about is a lie about the corpus.
        const aff = !ranked ? ""
            : c.affinity == null
                ? `<span class="dim">no coverage published — cannot be ranked</span>`
                : `<span class="bar" style="width:70px"><i style="width:${Math.round(Math.max(0, c.affinity) * 100)}%"></i></span> ${c.affinity.toFixed(3)}`
                  + `<span class="why">${c.relevant ? "about this" : "not about this"}</span>`;
        // Below the floor is drawn back, not hidden. The number alone is not
        // readable — 0.52 looks like a match until you see that everything else
        // scored 0.50 — and at a thousand publishers the only useful thing the
        // panel can say is which handful clear their own query's spread.
        const miss = ranked && c.affinity != null && !c.relevant ? " miss" : "";
        // Two shelves that are one thing, said so. The subtitle domain and the
        // film domain are baked separately and priced separately, and the panel
        // listed them as unrelated publishers — which is the opposite of why the
        // graph holds them together. Only knowable once the manifest has landed,
        // so it appears on open rather than being guessed at from a catalog.
        const ref = CORPORA.get(c.view)?.roles?.refers;
        const into = ref ? `<div class="meta"><span class="why">an index into ${esc(ref.corpus)} — a hit here plays there</span></div>` : "";
        return `<div class="corpus${on ? " on" : held ? " held" : ""}${miss}" data-view="${esc(c.view)}">
            <div class="head"><b>${esc(c.domain)}</b>${on ? '<span class="dim">focused</span>'
                : held ? `<button data-open="${esc(c.view)}">focus</button>`
                : `<button data-open="${esc(c.view)}">open</button>`}</div>
            <div class="dim">${esc(c.description || "no description")}</div>
            <div class="meta">${num(c.rows)} rows · ${(c.bytes / 1e6).toFixed(1)} MB · ${c.entityTypes.join(" ") || "—"} · ${price}</div>
            ${into}
            ${aff ? `<div class="meta">${aff}</div>` : ""}
          </div>`;
    }).join("") || "<div class=dim>no corpora configured — pass ?sources=&lt;url,url&gt;</div>";
    for (const b of $("directory").querySelectorAll("button[data-open]")) {
        b.onclick = async () => { await openCorpus(b.dataset.open); };
    }

    // …and the same list as one line above the answer. A person needs to know
    // that other publishers exist and which ones this question reached; they do
    // not need affinity bars to know it. The bars are under the hood.
    $("sources").innerHTML = known.map((c) => {
        const held = !!CORPORA.get(c.view)?.rows.length;
        const hot = ranked && c.relevant;
        const ref = CORPORA.get(c.view)?.roles?.refers;
        return `<button class="chip${hot ? " hot" : held ? " held" : ""}" data-open="${esc(c.view)}"
                 title="${esc(c.description || c.domain)}${ref ? ` — an index into ${esc(ref.corpus)}` : ""}">${esc(c.domain)}${ref ? ` → ${esc(ref.corpus)}` : ""}</button>`;
    }).join("") || "<span class=dim>no publishers configured</span>";
    for (const b of $("sources").querySelectorAll("button[data-open]")) {
        b.onclick = async () => {
            await openCorpus(b.dataset.open);
            const c = CORPORA.get(trimView(b.dataset.open));
            // Opening a publisher PLAYS it. This used to list the collection and
            // offer a link to the app that owns it; in this bundle that link was
            // `http://localhost:5173`, which is nobody's television. A queue is
            // what "open" should have meant all along — and when there is neither
            // a question nor a taste to build one from, the listing is still the
            // honest floor.
            const q = $("dirQuery").value.trim();
            const played = await call("present", { corpus: c?.name, query: q || undefined, limit: 12 });
            if (played.error || played.out?.error) {
                const { view } = await call("browse-collection", { corpus: c?.name });
                render(view, { list: true });
            } else {
                render(played.view, { stage: true });
            }
            // …and the door to the app that owns it, for a publisher who has one.
            const go = c?.roles?.launch && launchUrl(c.roles.launch, { q });
            $("launch").hidden = !go;
            if (go) { $("launch").href = go; $("launch").textContent = `open ${c.name} →`; }
        };
    }
}

/** Load one corpus and focus it. Shared by the button and the agent's verb, so a
 *  person clicking and an agent calling cannot end up in different states.
 *
 *  ADDITIVE. It used to resetShard() and drop whatever was open, which is what
 *  made every cross-corpus question unanswerable. Re-opening something already
 *  held just refocuses it — shard.js caches by view, so no bytes move. */
async function openCorpus(view) {
    view = trimView(view);
    setView(view);
    S.focus = view;
    open = null;
    // NOT `rows.length`. A shard paints partials as it streams, so a second
    // caller arriving mid-download saw a few thousand of 20,986 rows and
    // concluded the corpus was open. Everything downstream then ran against a
    // fraction of it with no indication — a join that resolved 6 of 48, a facet
    // that counted a tenth of the values, an agent told 20,986 rows exist and
    // handed the first 3,000. `load` is now idempotent per view and returns the
    // in-flight promise, so "open" means finished for every caller.
    if (inflight.has(view) || !CORPORA.get(view)?.rows.length) await load(view);
    paintDirectory();
    paint();
}

// ── loading, painted as it streams ──────────────────────────────────────────
//
// One load per view, shared. Two callers wanting the same corpus at the same
// moment — the boot present following a reference, and `ask` opening what the
// directory ranked — must await the SAME download and both see all of it.
const inflight = new Map();
function load(view = trimView(VIEW)) {
    view = trimView(view);
    const already = inflight.get(view);
    if (already) return already;
    const p = stream(view).finally(() => inflight.delete(view));
    inflight.set(view, p);
    return p;
}

async function stream(view) {
    const c = slot(view);
    c.stats = { shards: 0, ms: 0, started: performance.now() };
    // The view actually open, not the one the page booted with — open-corpus
    // switches it, and a header naming the boot view is a header that lies about
    // what you are looking at.
    $("view").textContent = view;
    $("status").textContent = `streaming from ${view}…`;
    try {
        c.rows = await loadShard(view, (partial) => {
            c.rows = partial;
            // A declared bundle was already resolved by onManifests. A sniffed
            // one is widened as rows arrive, because sniffing needs a sample.
            if (!c.roles.declared) c.roles = rolesFrom(domainManifests(view), partial);
            c.stats.shards++;
            c.stats.ms = Math.round(performance.now() - c.stats.started);
            if (S.focus === view) paint();
        });
    } catch (e) {
        $("status").textContent = `load failed: ${e.message}`;
        $("status").className = "bad";
        return c;
    }
    c.stats.ms = Math.round(performance.now() - c.stats.started);
    const ms = domainManifests(view);
    c.roles = rolesFrom(ms, c.rows);
    c.name = ms[0]?.name ?? c.name ?? view;
    if (S.focus !== view) return c;
    $("status").textContent = `${num(c.rows.length)} things from ${loaded().length} publisher${loaded().length === 1 ? "" : "s"}, in this tab`;
    $("status").className = "good";
    // The facet picker is the corpus's own vocabulary, not a hardcoded list —
    // `year`/`series`/`subject` mean nothing to a bundle of local businesses.
    const opts = [...new Set([...c.roles.tags, ...c.roles.subtitle, ...c.roles.measures, ...c.roles.spatial, ...c.roles.fields])]
        .filter((f) => c.rows.some((r) => r[f] != null && r[f] !== ""));
    $("facetField").innerHTML = opts.map((f) => `<option>${esc(f)}</option>`).join("");
    paint();
    return c;
}

// ── the corpus panel: the agent's own `describe`, rendered ──────────────────
function paint() {
    const cur = S.focus && CORPORA.get(S.focus);
    if (!cur) return;
    const { rows, roles, stats } = cur;
    const d = describe(rows);
    $("rows").textContent = num(d.rows);
    $("vecs").textContent = `${num(d.withVectors)} × ${d.vectorDim}d`;
    $("shards").textContent = `${stats.shards} shard${stats.shards === 1 ? "" : "s"} / ${stats.ms}ms`;
    $("view").textContent = cur.name && cur.name !== cur.view ? `${cur.name} — ${cur.view}` : cur.view;
    $("owners").textContent = d.owners.map((o) => `${o.slice(0, 8)}…`).join(" ") || "—";
    $("focusMeta").textContent = `${cur.name ?? cur.view} · ${loaded().length} of ${known.length || SOURCES.length} held in this tab`;
    // Say whether the publisher declared their shape or we sniffed it. A page
    // that silently guesses is a page you cannot trust when it guesses wrong.
    $("shape").textContent = roles.declared
        ? `declared · title=${roles.title[0]} text=${roles.text.join("+") || "—"}`
        : `sniffed · title=${roles.title[0] ?? "—"} text=${roles.text.join("+") || "—"}`;
    $("shape").className = roles.declared ? "good" : "dim";

    // What this view withholds. Named fields, never "some data may be missing":
    // an agent decides whether to spend on the strength of knowing exactly what
    // it would get, and vagueness here is how a purchase becomes a refund.
    const gates = gatesOf(roles);
    $("gate").textContent = gates.length
        ? gates.map((g) => (g.unpublished
            ? `${g.locked.length} fields declared paid — payload not published yet`
            : `${g.locked.length} fields locked · ${priceLabel(g)} · ${g.locked.slice(0, 4).join(" ")}${g.locked.length > 4 ? " …" : ""}`)).join("  |  ")
        : "";
    $("gate").className = gates.length ? (gates[0].unpublished ? "dim" : "bad") : "dim";
    // ponytail: no entity-type stat cell. The collections row below IS that,
    // with the publisher's own words, and a cell reading "—" next to a row
    // listing three collections is a contradiction rather than a summary.

    // Field coverage as a bar per field. This is the picture a schema cannot
    // give you: `series` on 61% of rows is why faceting on it means something
    // and faceting on `episode` means less.
    $("fields").innerHTML = d.fields.map((f) => `
        <div class="field">
          <span class="k">${esc(f.name)}</span>
          <span class="bar"><i style="width:${f.pct}%"></i></span>
          <span class="v">${f.pct}%</span>
        </div>`).join("");

    // ── the collections, as the publisher named them ────────────────────────
    //
    // This is the whole difference between a telemetry readout and somebody's
    // storefront, and none of it is written for a dataset: `entity_types` says
    // there are 654 Events and 263 Businesses, and `presentation.types` says an
    // Event is a 🎫 and what to call one of them. A bundle that declared none of
    // it still groups — by raw type name, with no icon, which is honest.
    const cols = collections(roles, rows);
    $("collections").innerHTML = cols.map((c) => `
        <button class="col${open === c.type ? " on" : ""}" data-type="${esc(c.type)}"
                style="${c.accent ? `--accent:${esc(c.accent)}` : ""}">
          <b>${c.icon ? `${esc(c.icon)} ` : ""}${num(c.count)}</b>
          <span>${esc(c.plural)}</span>
        </button>`).join("") || "<div class=dim>this bundle declares no collections</div>";
    for (const b of $("collections").querySelectorAll("button")) {
        b.onclick = async () => {
            open = open === b.dataset.type ? null : b.dataset.type;
            paint();
            const { view } = await call("browse-collection", { type: open ?? undefined, corpus: cur.name, limit: 30 });
            render(view);
        };
    }

    // ponytail: no row list here any more. It was a hand-written second
    // renderer of exactly what `rankedList` draws, which meant the page and the
    // agent's host could disagree about the same rows. Clicking a collection now
    // calls browse-collection and shows ITS view — one renderer, one answer.

    // One live facet, so the page shows something true about the corpus without
    // an agent connected. ponytail: a fixed field, not a picker. The picker is
    // the agent — that is the point of the page.
    const f = facet(rows, $("facetField").value || roles.tags[0] || roles.fields[0] || "entityType",
                    { limit: 12, ...(open ? { where: { entityType: open } } : {}) });
    $("facet").innerHTML = f.top.map((t) => `
        <div class="field">
          <span class="k">${esc(t.value)}</span>
          <span class="bar"><i style="width:${Math.round((100 * t.count) / (f.top[0]?.count || 1))}%"></i></span>
          <span class="v">${num(t.count)}</span>
        </div>`).join("") || "<div class=dim>nothing yet</div>";
    $("facetMeta").textContent = `${num(f.distinct)} distinct · ${num(f.missing)} missing`;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ── the telemetry panel: every tool call, as it happens ─────────────────────
function logCall(name, args, ms, result, error) {
    calls.unshift({ name, args, ms, error, at: new Date().toLocaleTimeString(), size: error ? 0 : JSON.stringify(result).length });
    calls.length = Math.min(calls.length, 40);
    $("calls").innerHTML = calls.map((c) => `
        <div class="call${c.error ? " bad" : ""}">
          <div class="head"><b>${esc(c.name)}</b><span class="dim">${c.at} · ${c.ms}ms · ${c.error ? "error" : `${num(c.size)}B`}</span></div>
          <div class="args">${esc(JSON.stringify(c.args))}</div>
          ${c.error ? `<div class="args">${esc(c.error)}</div>` : ""}
        </div>`).join("");
    $("callCount").textContent = calls.length ? `${calls.length} call${calls.length === 1 ? "" : "s"}` : "waiting for an agent";
}

// ── presenting ──────────────────────────────────────────────────────────────
//
// The index used to end at a link. `presentation.launch` in the archive bundle
// still reads `http://localhost:5173`, which is the honest state of that idea:
// the app on the other side was going to own the player, the queue and the
// person, and there is no reason for it to. Every app that could exist would
// re-implement one content type's player over the same rows and the same taste.
//
// So the surface is here, and it is assembled the same way everything else in
// this page is assembled — from what the publisher declared. `ui.js:shapeOf`
// reads a `mime` and a `media` role; nothing on this side of the boundary knows
// what a film is.
//
// The other axis is the taste, and the split is deliberate:
//
//   the QUESTION chooses what is in the queue     — semantic search fills a pool
//   the TASTE chooses what comes first            — the pool is ordered by it
//
// which is what makes a like cheap. Reordering the pool costs no embedding, no
// network and no re-query, so the queue can move under a film that is playing.
// That is the entire mechanism behind the one thing this page is for: watching
// your own preferences act on something, immediately, in a surface you can see.
const POOL_FACTOR = 4;
let POOL = [];                                     // [{ row, roles, corpus, score }]
let LAST = { picks: [], limit: 12, heading: "", note: "" };
let FOLLOWED = { n: 0, of: 0, into: "" };

/** Fill the pool. Rows, not briefs — `brief()` resolves the publisher's LINK
 *  (`presentation.externalUrl`, a details page) and a player needs their FILE,
 *  which is a different field on the same row. */
async function fillPool({ query, corpus, limit }) {
    const cs = span(corpus ?? "*");
    const want = Math.max(limit * POOL_FACTOR, 24);
    const out = [];
    if (query) {
        let qv = null;
        try { qv = await embedQuery(query); }
        catch (e) { console.warn("embed failed, pooling on word matches —", e); }
        for (const c of cs) {
            const byId = new Map(c.rows.map((r) => [r.id, r]));
            for (const h of search(c.rows, query, c.roles, { qv, limit: want })) {
                const row = byId.get(h.id);
                if (row) out.push({ row, roles: c.roles, corpus: c.name, score: h.score });
            }
        }
    } else {
        const t = mine();
        for (const c of cs) {
            if (t) {
                for (const h of recommend(c.rows, t, { limit: want })) {
                    out.push({ row: h.row, roles: c.roles, corpus: c.name, score: h.score });
                }
                continue;
            }
            // The cold start, which is the state every new reader arrives in and
            // the one the page used to answer with an empty box and an
            // instruction to type. There is no query to rank against and no
            // taste to rank by, so the useful thing is not "the top of the
            // corpus" — it is the WIDEST set of different things in it. MMR with
            // every score held equal degenerates to exactly that: each pick is
            // whatever is least like everything already picked.
            //
            // Subsampled deterministically, and the stride matters: `diversify`
            // only considers its own top `limit * 6`, so handing it 2,000 rows
            // would have spread over the first 2,880 rows of the shard and
            // called that the catalogue. Striding to exactly that many walks the
            // whole thing instead.
            const vecs = c.rows.filter((r) => r.vector);
            const step = Math.max(1, Math.ceil(vecs.length / (want * 6)));
            const seed = vecs.filter((_, i) => i % step === 0);
            for (const h of diversify(seed.map((row) => ({ row, s: 1 })), { limit: want, lambda: 0.05 })) {
                out.push({ row: h.row, roles: c.roles, corpus: c.name, score: 0, cold: true });
            }
        }
    }
    // One sort across publishers, not a normalisation: every corpus scored the
    // same query vector with raw cosine, so the numbers are already comparable.
    const ranked = out.sort((a, b) => b.score - a.score).slice(0, want);

    // …and then follow what the publishers declared. A corpus whose rows point
    // into another one is only half an answer until the other is open, so the
    // referenced corpus is OPENED here rather than the reference being dropped:
    // matching a line of dialogue and then showing the reader a locked subtitle
    // row is the failure this whole mechanism exists to prevent. One fetch, once
    // — shard.js caches by view, so a second question costs nothing.
    for (const name of new Set(ranked.map((p) => p.roles?.refers?.corpus).filter(Boolean))) {
        if (loaded().some((c) => c.name === name)) continue;
        // `known` is the RAW directory listing, where the url is `view`. The
        // `find-corpora` verb renames it to `open` on the way out for an agent,
        // and reading the verb's name off the raw row silently found nothing —
        // so the reference was never followed and the queue stayed full of
        // subtitle rows with no film behind them.
        const hit = known.find((k) => (k.domain ?? k.name) === name);
        const view = hit?.view ?? hit?.open;
        if (view) { try { await openCorpus(view); } catch (e) { console.warn(`could not open ${name} to follow a reference —`, e); } }
    }
    POOL = follow(ranked, loaded(), {
        // The timecode, when its publisher gives it away. `archive-transcripts`
        // sells `start`, so today most passages resolve to a film rather than to
        // a moment in one; `archive-dialogue` is baked free and will resolve to
        // the second.
        at: (r) => (Number.isFinite(Number(r?.start)) ? Number(r.start) : null),
    });
    // Said out loud, because it is the answer to "why am I being shown a film for
    // a line I typed" — and because when it is 2 of 12 rather than 12 of 12,
    // something is wrong and nobody would otherwise know.
    FOLLOWED = { of: POOL.length, n: POOL.filter((p) => p.via).length,
                 into: [...new Set(POOL.filter((p) => p.via).map((p) => p.corpus))].join(", ") };
    POOL = POOL.map((p) => (p.via
        // The words that matched, if they are free to read. `textOf` already
        // returns "" for a role the publisher locked, so a paid line is absent
        // rather than half-quoted.
        ? { ...p, via: { ...p.via, line: textOf(p.via.row, p.via.roles ?? {}) || undefined } }
        : p));
    return cs;
}

/** The pool in taste order — the only thing a like has to recompute. */
function order(limit = LAST.limit) {
    const t = mine();
    const named = new Set([...liked, ...disliked].map((l) => l.id));
    const pool = POOL.filter((p) => !named.has(p.row.id));
    if (!t) return pool.slice(0, limit).map((p) => ({ ...p,
        why: p.cold ? "a spread of what is here — react to a few and this list starts moving"
                    : `${p.score.toFixed(3)} · matched your question` }));
    const byId = new Map(pool.map((p) => [p.row.id, p]));
    return recommend(pool.map((p) => p.row), t, { limit })
        .map((h) => { const p = byId.get(h.row.id); return p && { ...p, why: `${h.score.toFixed(3)} · your taste` }; })
        .filter(Boolean);
}

// ── the verbs ──────────────────────────────────────────────────────────
//
// Every one is timed and logged before it returns, so the panel on the right is
// the true record of what the agent did — not a summary the agent wrote.
// The JSON an agent reads, and — when the verb produced a ranked list — a view a
// host can render beside it (MCP Apps / mcp-ui). `resource` is a standard MCP
// content block, so a host that has never heard of `ui://` shows the text and
// nothing breaks. `?ui=off` drops the second block for a host that is unhappy
// with it, and for measuring how much the views cost on the wire.
const UI = Q.get("ui") !== "off";
const text = (v, view) => ({
    content: [
        { type: "text", text: typeof v === "string" ? v : JSON.stringify(v, null, 1) },
        ...(UI && view ? [uiResource(view.html, view.name)] : []),
    ],
});

// Every verb that reads rows takes this. Adding it in the wrapper rather than
// on each tool is not tidiness — it means a verb cannot be added later that
// silently only ever answers about the focused corpus.
const CORPUS_ARG = {
    type: "string",
    description: "Which open corpus, by the name find-corpora returned (e.g. \"games\"). Defaults to the last one opened. Pass \"*\" to span EVERY open corpus at once — that is how a question crosses publishers.",
};

// Every verb by name, so the PAGE can call them too. The point is not
// convenience: a person pressing enter and an agent calling the tool must run
// the same code, or the demo drifts from the product. There is one execution
// path below and both go through it — including the telemetry, which is why
// typing a question fills the right-hand column with the agent's own calls.
const VERBS = new Map();

async function call(name, args = {}) {
    const def = VERBS.get(name);
    if (!def) throw new Error(`no verb ${name}`);
    const t0 = performance.now();
    try {
        // "0 rows" and "still streaming" are different answers and an agent
        // acts differently on each. Saying nothing is what makes an agent
        // conclude the corpus is empty and stop.
        if (def.spans !== false && !loaded().length) {
            const c = S.focus && CORPORA.get(S.focus);
            throw new Error(c
                ? `corpus still loading (${c.stats.shards} shards so far) — retry, or call find-corpora`
                : "no corpus open — call find-corpora, then open-corpus");
        }
        const out = await def.run(args);
        logCall(name, args, Math.round(performance.now() - t0), out, null);
        // The view is derived from what the verb already returned — it is
        // a second rendering of one answer, never a second query. If it
        // could disagree with the JSON it would be worse than nothing.
        //
        // And it is decoration: a renderer that throws must cost the
        // agent the picture, never the answer.
        let view = null;
        if (UI && def.view) {
            try { view = { name, html: def.view(out, args) }; }
            catch (e) { console.warn(`${name}: view failed, returning JSON only —`, e); }
        }
        return { out, view };
    } catch (e) {
        logCall(name, args, Math.round(performance.now() - t0), null, e.message);
        return { out: `error: ${e.message}`, view: null, error: e.message };
    }
}

let toolCount = 0;
function register(mc) {
    const tool = (def) => (toolCount++, VERBS.set(def.name, def), mc.registerTool({
        name: def.name,
        description: def.description,
        inputSchema: def.spans === false ? def.inputSchema : {
            ...def.inputSchema,
            properties: { ...def.inputSchema.properties, corpus: CORPUS_ARG },
        },
        async execute(args = {}) {
            const { out, view } = await call(def.name, args);
            return text(out, view);
        },
    }));
    const str = (description) => ({ type: "string", description });
    const int = (description) => ({ type: "number", description });

    tool({
        spans: false,
        name: "find-corpora",
        description: "Search FOR data, before searching IN it. Ranks every corpus this page knows about against a question — without downloading any of them — and reports what each is about, how big it is, and what unlocking it costs. Use this when the answer is not in the corpus currently open, or when you do not know which corpus to open. Then open-corpus to load one.",
        inputSchema: {
            type: "object",
            properties: {
                query: str("What you are looking for, in natural language. Omit to just list what exists."),
                limit: int("Max corpora to return (default 10)"),
            },
        },
        view: (out) => rankedList({
            heading: out.query ? `corpora for “${out.query}”` : "corpora available",
            note: out.note ?? `${out.searched ?? 0} searched · ${out.ranked ? "ranked by published coverage, nothing downloaded" : "unranked"}`,
            hits: (out.corpora ?? []).map((c) => ({
                title: c.domain, subtitle: c.publisher ?? undefined,
                tags: [...(c.collections ?? []), c.free ? "free" : c.price].filter(Boolean),
                score: c.affinity ?? undefined,
                url: undefined,
            })),
        }),
        run: async ({ query = "", limit = 10 }) => {
            if (!SOURCES.length) {
                return { note: "No directory configured. Pass ?sources=<viewUrl,viewUrl> — or a registry namespace, which resolves to the same list." };
            }
            const r = await findCorpora(query, {
                sources: SOURCES, embed: embedQuery, model: EMBED_MODEL, limit,
            });
            // The panel follows the agent: what it was told is what the person sees.
            known = r.corpora;
            ranked = r.ranked;
            $("dirMeta").textContent = `${r.searched} corpora · ranked for "${query}"`;
            paintDirectory();
            return {
                ...r,
                // Ranked off ~4KB of k-means centroids per corpus that the bake
                // already publishes. No shard is fetched, and the question is
                // embedded in this tab — the directory learns neither.
                how: "ranked against each corpus's published coverage centroids; nothing downloaded, nothing disclosed",
                corpora: r.corpora.map((c) => ({
                    domain: c.domain, publisher: c.publisher, description: c.description,
                    affinity: c.affinity == null ? null : Number(c.affinity.toFixed(4)),
                    rows: c.rows, megabytes: Number((c.bytes / 1e6).toFixed(1)),
                    collections: c.entityTypes,
                    ...(c.paywall ? { price: `${(Number(c.paywall.price) / 1e6).toFixed(2)} ${c.paywall.asset}`, lockedFields: c.paywall.locked, buyable: c.paywall.buyable } : { free: true }),
                    // Cleared this question's own floor. Open these and stop —
                    // the affinity number alone cannot be read across queries.
                    relevant: c.relevant ?? null,
                    open: c.view,
                })),
            };
        },
    });

    tool({
        spans: false,
        name: "open-corpus",
        description: "Load one of the corpora find-corpora returned. This downloads its free index into this tab; searching it afterwards is local and private. Corpora ACCUMULATE — opening a second does not close the first, and every other verb then accepts corpus:\"*\" to span them all. Open each one a cross-domain question needs, then ask once.",
        inputSchema: { type: "object", properties: { view: str("The `open` URL from a find-corpora result") }, required: ["view"] },
        run: async ({ view }) => {
            if (!/^https?:\/\//.test(view) && !view.startsWith("/")) throw new Error(`not a view url: ${view}`);
            // A pointer someone else published is the one thing this page
            // navigates to that it did not configure. Same gate apps.js applies.
            await openCorpus(view);
            const c = at();
            return {
                opened: c.name, view: c.view, rows: c.rows.length,
                shape: c.roles.declared ? "declared" : "sniffed",
                collections: collections(c.roles, c.rows).map((x) => `${x.plural} ${x.count}`),
                nowOpen: loaded().map((x) => ({ corpus: x.name, rows: x.rows.length })),
                note: loaded().length > 1 ? 'All of these stay open. Pass corpus:"*" to search or rank across them in one call.' : undefined,
            };
        },
    });

    tool({
        name: "describe-corpus",
        description: "What this corpus contains: how many rows, how many carry search vectors, who published them, which fields are present on what fraction of rows, and the publisher's own declaration of which field is the title, the subtitle, the tags and the searchable prose. Call this first — nothing else here assumes a fixed schema, so this is where the field names come from.",
        inputSchema: { type: "object", properties: {} },
        run: ({ corpus }) => {
            const out = span(corpus).map(({ name, rows, roles }) => ({
                corpus: name, ...describe(rows),
                shape: { declared: roles.declared, title: roles.title, subtitle: roles.subtitle, text: roles.text, tags: roles.tags, measures: roles.measures, entityTypes: roles.entityTypes },
            }));
            return out.length === 1 ? out[0] : { corpora: out };
        },
    });

    tool({
        name: "search-corpus",
        description: "Semantic search over every row, ranked in this tab. Falls back to word matching for rows with no vector, and says which mode each hit used. With corpus:\"*\" it searches every open corpus on ONE query vector and returns a single merged ranking — the same question put to several publishers at once, each hit labelled with where it came from.",
        inputSchema: {
            type: "object",
            properties: {
                query: str("What to look for, in natural language"),
                limit: int("Max hits (default 10)"),
                fields: { type: "array", items: { type: "string" }, description: "Extra fields to show per hit, on top of the title, subtitle and tags this corpus declares. Names come from describe-corpus." },
                where: { type: "object", description: "Narrow to rows matching these fields FIRST, then rank what is left, e.g. {\"year\":1966}. This is how \"like X but only Y\" is one call — the ranking floor is measured inside the filter, so a narrow slice still separates good matches from the rest of that slice." },
            },
            required: ["query"],
        },
        // Rendered from the roles of the corpus that produced the hits — the
        // spanning case has several, so the extras come from the focused one and
        // each hit carries its own corpus chip.
        view: (out, { corpus, query }) => {
            const hits = Array.isArray(out) ? out : (out.hits?.hits ?? out.hits ?? []);
            const cs = span(corpus);
            return rankedList({
                // From the ARGUMENTS, not the result: a single-corpus search
                // returns a bare array with no `query` on it, and the heading
                // read `search “”` for every one of them.
                heading: `search “${query}”`,
                note: `${hits.length} hits · ${cs.map((c) => c.name).join(", ")}`,
                // `brief()` already resolved the publisher's own link into `url`.
                hits, roles: cs[0]?.roles,
            });
        },
        run: async ({ query, limit = 10, fields, corpus, where }) => {
            // A failed embed is a degraded search, not a failed one — lexical still
            // answers. But the REASON must survive: a silent catch here is how
            // "semantic search is worse than grep" becomes an afternoon, and the
            // agent reading `mode: "lexical"` on every hit has no way to ask why.
            let qv = null, why = null;
            try { qv = await embedQuery(query); }
            catch (e) { why = e?.message ?? String(e); console.warn("embed failed, falling back to lexical —", e); }
            // One query vector, every corpus. Raw cosine against the same vector
            // is comparable across bundles — same model, same question — so the
            // merge is a sort, not a normalisation. Each corpus still applies its
            // OWN z-floor first, which is why a corpus that knows nothing about
            // the question contributes nothing rather than its least-bad rows.
            const cs = span(corpus);
            const hits = merge(cs.map((c) => ({ name: c.name, hits: search(c.rows, query, c.roles, { qv, limit, fields, where }) })), { limit });
            const out = cs.length > 1 ? { query, searched: cs.map((c) => c.name), hits } : hits;
            return why ? { degraded: `embedder unavailable (${why}) — these hits are word matches, not semantic`, hits: out } : out;
        },
    });

    tool({
        name: "facet-field",
        description: "Count the values of one field. The verb for questions about the shape of the corpus rather than its contents — how many rows per category, per place, per type. Field names come from describe-corpus; `where` narrows to rows matching other fields first, case-insensitively.",
        inputSchema: {
            type: "object",
            properties: {
                field: str("Field to count. Use a name from describe-corpus — this corpus's fields are its own, not a fixed set."),
                limit: int("How many values to return (default 20)"),
                where: { type: "object", description: "Only count rows whose fields match these values, e.g. {\"entityType\":\"Event\"}. Values come from a previous facet-field call." },
            },
            required: ["field"],
        },
        view: (out, { field, where }) => {
            // Spanning sums the same value across publishers — "how much horror
            // is on this whole network" is one bar, not one per corpus.
            let top = out.top;
            if (!top) {
                const m = new Map();
                for (const b of out.byCorpus ?? []) for (const t of b.top ?? []) m.set(t.value, (m.get(t.value) ?? 0) + t.count);
                top = [...m].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
            }
            return bars({
                heading: field,
                note: out.top ? `${out.distinct} distinct · ${out.missing} rows have none`
                    : `summed across ${(out.byCorpus ?? []).map((b) => b.corpus).join(", ")}`
                    + (where ? ` · where ${JSON.stringify(where)}` : ""),
                items: top.map((t) => ({ label: t.value, count: t.count })),
            });
        },
        run: ({ field, limit = 20, where, corpus }) => {
            const cs = span(corpus);
            if (cs.length === 1) return facet(cs[0].rows, field, { limit, where });
            return { byCorpus: cs.map((c) => ({ corpus: c.name, ...facet(c.rows, field, { limit, where }) })) };
        },
    });

    tool({
        name: "browse-collection",
        description: "List what is here, with no query. Called with no arguments it names the collections this corpus declares and their sizes; with a `type` it lists that collection's rows. The first call to make on an unfamiliar corpus — search needs a query and similar-rows needs a row you already found.",
        inputSchema: {
            type: "object",
            properties: {
                type: str("A collection name from a previous call, or from describe-corpus. Omit to list every collection."),
                where: { type: "object", description: "Only rows whose fields match these values, e.g. {\"locality\":\"Eagle River, WI\"}" },
                sort: str("Field to order by — a measure from describe-corpus. Rows lacking it come last."),
                desc: { type: "boolean", description: "Highest first (default true)" },
                limit: int("Rows per page (default 20)"),
                offset: int("Rows to skip, for paging (default 0)"),
                fields: { type: "array", items: { type: "string" }, description: "Extra fields per row, beyond title/subtitle/tags." },
            },
        },
        view: (out, a) => {
            const cs = span(a.corpus);
            const rows = out.rows ?? (out.byCorpus ?? []).flatMap((b) => (b.rows ?? []).map((r) => ({ corpus: b.corpus, ...r })));
            return rankedList({
                heading: a.type ? `${a.type} in ${cs.map((c) => c.name).join(", ")}` : `collections in ${cs.map((c) => c.name).join(", ")}`,
                note: out.collections ? out.collections.map((c) => `${c.plural ?? c.type} ${c.count}`).join(" · ")
                    : `${out.total ?? rows.length} rows${a.where ? ` where ${JSON.stringify(a.where)}` : ""}`,
                hits: rows, roles: cs[0]?.roles,
            });
        },
        run: (a) => {
            const cs = span(a.corpus);
            // The page follows the agent. Watching a browse land on the left while
            // the call lands on the right is the point of having both.
            if (a.type && cs.length === 1 && cs[0].view === S.focus) { open = a.type; paint(); }
            if (cs.length === 1) return browse(cs[0].rows, cs[0].roles, a);
            return { byCorpus: cs.map((c) => ({ corpus: c.name, ...browse(c.rows, c.roles, a) })) };
        },
    });

    tool({
        name: "unlock-info",
        description: "What this corpus withholds from the free index, and what unlocking it costs. Every row and every search vector is already here — search results are complete and correctly ranked. What is missing is a named set of FIELDS per row. Call this before deciding a result is unusable, and before offering to spend.",
        inputSchema: { type: "object", properties: {} },
        run: ({ corpus }) => {
            const cs = span(corpus);
            if (cs.length > 1) return { byCorpus: cs.map((c) => ({ corpus: c.name, gates: gatesOf(c.roles).map((g) => ({ domain: g.domain, price: priceLabel(g), lockedFields: g.locked })) })) };
            const { roles } = cs[0];
            const gates = gatesOf(roles);
            if (!gates.length) {
                return { gated: false, note: "Nothing is withheld — every field of every row is in the shard you already have." };
            }
            return {
                gated: true,
                // x402f, the same rails sond3r settles file purchases on: pay the
                // owner + join the resource's Semaphore group, prove membership,
                // and the access worker releases the DEK for the sealed payload.
                // Deliberately NOT executed here: WebMCP has no consent step, so an
                // agent-callable purchase would be an agent-callable wallet.
                settlement: "x402f (EIP-3009 transferWithAuthorization + Semaphore membership proof)",
                offers: gates.map((g) => ({
                    domain: g.domain,
                    price: priceLabel(g), priceBaseUnits: g.price, asset: g.asset,
                    lockedFields: g.locked,
                    freeFields: g.free,
                    payloadBytes: g.files.reduce((n, f) => n + (f.bytes ?? 0), 0),
                    rowsCovered: g.files.reduce((n, f) => n + (f.count ?? 0), 0),
                    ...(g.unpublished
                        ? { buyable: false, why: "declared and priced, but the payload has not been sealed and uploaded yet" }
                        : { buyable: true, resourceId: g.resourceId, workerUrl: g.workerUrl }),
                })),
                howToBuy: "A person presses the buy button. Nothing here spends money.",
            };
        },
    });

    tool({
        name: "note-taste",
        description: "Tell the page you liked or disliked a row, by id. Builds a taste vector from what you name. Because every corpus on this network is embedded by the same model, that vector KEEPS WORKING after you open a different corpus from a different publisher — films to games, with no shared ids, schema or agreement of any kind. Newest signals count most.",
        inputSchema: {
            type: "object",
            properties: {
                like: { type: "array", items: { type: "string" }, description: "Row ids (or titles) you liked" },
                dislike: { type: "array", items: { type: "string" }, description: "Row ids (or titles) you did not" },
                reset: { type: "boolean", description: "Forget the taste built so far" },
            },
        },
        run: ({ like = [], dislike = [], reset = false, corpus }) => {
            if (reset) { liked = []; disliked = []; saveTaste(); return { taste: null, note: "forgotten" }; }
            // Search every open corpus by default. An agent that liked a film and
            // then opened the games bundle should not have to remember which one
            // an id came from — the taste crosses corpora, so naming rows should
            // too. `corpus` narrows it when two bundles share a title.
            const cs = span(corpus ?? "*");
            const find = (id) => {
                for (const c of cs) {
                    const r = c.rows.find((x) => x.id === id) ?? c.rows.find((x) => titleOf(x, c.roles) === id);
                    if (r) return { r, roles: c.roles, corpus: c.name };
                }
                return null;
            };
            const miss = [];
            for (const [ids, into, kind] of [[like, liked, "like"], [dislike, disliked, "skip"]]) {
                for (const id of ids) {
                    const hit = find(id);
                    if (!hit?.r?.vector) { miss.push(id); continue; }
                    const title = titleOf(hit.r, hit.roles);
                    into.push({ id: hit.r.id, title, vector: hit.r.vector });
                    // The kernel gets the vector; the log gets the event. See the
                    // note on `reactions` — a taste that has collapsed across a
                    // reload cannot answer a publisher's question, and this is
                    // the only place a reaction is ever created.
                    noteReaction(hit.r, hit.corpus, kind, title);
                }
            }
            const t = mine();
            saveTaste();   // it outlives the tab, or it is not a taste
            return {
                liked: liked.length, disliked: disliked.length,
                remembered: true,
                ...(miss.length ? { notFound: miss } : {}),
                builtFrom: t?.from ?? [],
                heading: t?.v ? "moving — recent picks differ from earlier ones, so recommendations lean ahead of them"
                              : "settled — too few picks to infer a direction, so recommendations mirror what you named",
            };
        },
    });

    tool({
        name: "recommend",
        description: "Rank a corpus by the taste built with note-taste. The useful call is to build a taste in ONE corpus and rank a completely different one — the ranking still works, because the two share an embedding space and nothing else. With corpus:\"*\" it ranks every open corpus into a single list, so one taste answers \"what should I read, watch and play\" in one call.",
        inputSchema: {
            type: "object",
            properties: {
                limit: int("How many (default 10)"),
                fields: { type: "array", items: { type: "string" }, description: "Extra fields per row" },
            },
        },
        view: (out, { corpus }) => rankedList({
            heading: "recommended for your taste",
            note: out.error ? out.error : `from ${(out.tasteFrom ?? []).join(", ")} · in ${(out.inCorpus ?? []).join(", ")}`,
            hits: out.results ?? [], roles: span(corpus)[0]?.roles,
        }),
        run: ({ limit = 10, fields, corpus }) => {
            const t = mine();
            if (!t) return { error: "no taste yet — call note-taste with some rows you liked" };
            // Exclude by id AND by title: a taste built in another corpus shares
            // no ids with this one, but a remake can share a name, and handing
            // someone back the thing they just named is the oldest failure here.
            const names = new Set([...liked, ...disliked].map((l) => l.title));
            const ids = new Set([...liked, ...disliked].map((l) => l.id));
            const cs = span(corpus);
            const hits = merge(cs.map((c) => ({
                name: c.name,
                hits: recommend(c.rows, t, { limit, exclude: ids })
                    .filter((h) => !names.has(titleOf(h.row, c.roles)))
                    .map((h) => ({ ...brief(h.row, c.roles, fields), score: h.score })),
            })), { limit });
            return {
                tasteFrom: t.from, rejected: t.rejected,
                inCorpus: cs.map((c) => c.name),
                results: hits,
            };
        },
    });

    tool({
        name: "present",
        description: "Play the answer instead of listing it. Fills a queue from a question (or, with no question, from the taste alone), orders it by the taste, and returns a surface that PLAYS the first item — a video, an audio track, an image, a place or a reader, chosen from the row's own mime and the publisher's media role rather than from which corpus it came out of. Likes and skips inside it re-order the queue in place, so the queue moves while something is playing. Call this when the person wants to consume the answer rather than read about it.",
        inputSchema: {
            type: "object",
            properties: {
                query: str("What the queue should be about, in natural language. Omit it to let the taste choose everything."),
                limit: int("How many to queue (default 12)"),
            },
        },
        // Derived from what `run` just computed, never a second query — the pool
        // and the ordering are already in `LAST`. This is the one verb whose view
        // is the product rather than a picture of it.
        view: () => stage(LAST),
        run: async ({ query, limit = 12, corpus }) => {
            const cs = await fillPool({ query, corpus, limit });
            LAST = {
                limit,
                picks: order(limit),
                heading: query ? `“${query}”` : "chosen for you",
                note: `${POOL.length} candidates from ${cs.map((c) => c.name).join(", ")} · `
                    + (mine() ? "ordered by your taste"
                       : query ? "no taste yet — ordered by the question alone"
                       : "no taste yet — spread as widely across these catalogues as the vectors allow")
                    + (FOLLOWED.n ? ` · ${FOLLOWED.n} of ${FOLLOWED.of} reached through a matched passage, playing in ${FOLLOWED.into}` : ""),
            };
            if (!LAST.picks.length) return { error: "nothing to queue", note: LAST.note };
            const [now] = LAST.picks;
            return {
                presenting: { ...brief(now.row, now.roles), corpus: now.corpus, shape: shapeOf(now.row, now.roles) },
                queue: LAST.picks.slice(1).map((p) => ({ title: titleOf(p.row, p.roles), corpus: p.corpus, shape: shapeOf(p.row, p.roles), why: p.why })),
                note: LAST.note,
            };
        },
    });

    tool({
        spans: false,
        name: "taste-doc",
        description: "The reader's taste as taste.md — the same object export-taste returns, written down in words. Says what they are drawn to, what they pass on and which way they are moving, in the vocabulary the open publishers declared with their own data, and carries the reader's own standing instructions above all of it. Read this before recommending anything: the standing instructions are authored by the person and override everything derived. Costs nothing and sends nothing.",
        inputSchema: { type: "object", properties: {} },
        run: () => {
            let instructions = "";
            try { instructions = localStorage.getItem("westmarch.instructions") ?? ""; } catch { /* private window */ }
            // Every corpus actually held, not the focused one: the document is
            // about a reader as seen by the shelves they have touched, and
            // narrowing it to one publisher would be the profile-shaped version
            // of the same idea.
            return {
                markdown: tasteDoc({ t: mine(), instructions,
                                     catalogues: loaded().map((c) => ({ name: c.name, rows: c.rows, roles: c.roles })) }),
                read: "/you.html",
            };
        },
    });

    tool({
        spans: false,
        name: "export-taste",
        description: "The taste as a portable object, a few hundred bytes. It names the rows it was built from, so a person can read and correct it. Hand it back with import-taste — in this tab, another tab, or another day.",
        inputSchema: { type: "object", properties: {} },
        run: () => {
            const t = mine();
            if (!t) return { error: "no taste yet" };
            const wire = exportTaste(t);
            return { taste: wire, bytes: JSON.stringify(wire).length,
                     note: "vectors are base64 int8 in the same space every corpus on this network uses" };
        },
    });

    tool({
        name: "seed-taste",
        description: "Start from what someone has ACTUALLY played, instead of from nothing. Reads a Steam localconfig.vdf — the file Steam already wrote to their own disk, holding playtime and last-played per game — and turns it into a taste against the open corpus. No API key, no login, no request to Valve: the file is parsed in this tab and goes nowhere. Call it after the games corpus is open. The cold-start problem, solved by a file the person already has.",
        inputSchema: {
            type: "object",
            properties: {
                vdf: str("The contents of localconfig.vdf. Omit if the person has already dropped the file on the page."),
                apply: { type: "boolean", description: "Fold the result into the taste (default true). False previews what it WOULD do without changing anything." },
            },
        },
        run: async ({ vdf = "", apply = true, corpus }) => {
            const text = vdf || droppedVdf;
            if (!text) {
                return { error: "no Steam file yet",
                         where: "Steam ▸ userdata ▸ <account id> ▸ config ▸ localconfig.vdf, inside the Steam install folder",
                         how: "drop it on this page, or pass its contents as `vdf`" };
            }
            const lib = steamLibrary(text);
            if (!lib.length) return { error: "that file parsed, but held no games with playtime — is it localconfig.vdf?" };

            const cs = span(corpus ?? "*");
            // One seed per open corpus, because appid only matches the corpus
            // that declares it — and then the taste built from the games ranks
            // every OTHER corpus too, which is the point of the whole network.
            const seeds = cs.map((c) => ({ c, seed: seedTaste(lib, c.rows, { title: (r) => titleOf(r, c.roles) }) }))
                            .filter(({ seed }) => seed.likes.length || seed.dislikes.length);
            if (!seeds.length) {
                return { error: `none of the ${lib.length} games in that library are in the open corpora`,
                         opened: cs.map((c) => c.name),
                         note: "open a Steam corpus first — appid is what these rows are matched on" };
            }
            const { c, seed } = seeds.sort((a, b) => b.seed.likes.length - a.seed.likes.length)[0];

            if (apply) {
                for (const l of seed.likes) {
                    liked.push({ id: l.id, title: l.title, vector: l.vector });
                    noteReaction({ id: l.id, vector: l.vector }, c.name, "like", l.title);
                }
                for (const d of seed.dislikes) {
                    disliked.push({ id: d.id, title: d.title, vector: d.vector });
                    noteReaction({ id: d.id, vector: d.vector }, c.name, "skip", d.title);
                }
                saveTaste();
            }
            const t = apply ? mine() : null;
            return {
                corpus: c.name,
                library: lib.length,
                summary: steamSummary(seed),
                hours: seed.hours,
                // Named, because a taste a person cannot read is one they cannot
                // correct — and this one was built from a file, not from choices
                // they made in front of the page.
                liked: seed.likes.slice(-12).map((l) => l.title),
                bouncedOff: seed.dislikes.slice(-8).map((d) => d.title),
                unmatched: seed.unmatched.length,
                applied: apply,
                ...(t ? { builtFrom: t.from, heading: t.v ? "moving" : "settled" } : {}),
                privacy: "parsed in this tab. Valve was not asked and cannot know this happened.",
            };
        },
    });

    tool({
        name: "share-reactions",
        description: "Turn what you reacted to into a corpus someone can BUY — and show, before anything is published, exactly which columns a buyer gets and which the free index discloses. This is the other side of the trade: a platform would take this stream for free, and here the publishers whose rows produced it are paid out of the sale. Call it to see the disclosure; it does not publish anything by itself.",
        inputSchema: {
            type: "object",
            properties: {
                publisher: str("The address that gets paid. Omit to see the disclosure as a draft."),
                price: str("Price in base units (default 250000 = 0.25 USDC)"),
                name: str("What to call the corpus"),
            },
        },
        run: ({ publisher, price = "250000", name = "reactions" }) => {
            const n = rehydrate();
            const usable = reactions.filter((r) => r.vector?.length);
            if (!usable.length) {
                return { error: "nothing to share yet — react to some rows first",
                         logged: reactions.length,
                         ...(reactions.length ? { note: `${reactions.length} reactions are in the log but their rows are not open, so their vectors cannot be recovered` } : {}) };
            }
            // A draft address so the disclosure can be inspected without a
            // wallet. Seeing what you would be selling is the reason to call
            // this verb; needing a key first would put the answer behind the
            // decision it is supposed to inform.
            const draft = !publisher;
            const corpus = reactionCorpus(usable, {
                publisher: publisher ?? `0x${"0".repeat(40)}`, name, price,
            });
            return {
                draft,
                ...(draft ? { warning: "no publisher address — this is a preview, not a publishable corpus" } : {}),
                reactions: usable.length,
                rehydrated: n,
                corpora: [...new Set(usable.map((r) => r.corpus))],
                free: FREE,
                paid: LOCKED,
                disclosure: "The free index carries coverage centroids, which corpus, and the month — the SHAPE of your attention. Which game, what it was called, and whether you liked it are the paid columns. No reaction ships a vector: a reaction's vector is a copy of a row anyone can download free, so publishing it would hand over the paid column for nothing.",
                manifest: corpus.manifest,
                price,
            };
        },
    });

    tool({
        name: "answer-question",
        description: "Answer a publisher's question about your reactions WITHOUT handing over your reactions. Evaluates the question against the local log and returns a masked share — your real answer plus values that cancel when the whole cohort is summed, so the publisher learns the total and nobody learns you. Refuses to emit a share for a cohort too small to hide in, which is the only thing standing between an aggregate and an interview.",
        inputSchema: {
            type: "object",
            properties: {
                question: str("What the publisher is asking about, in natural language — it is embedded locally and matched against what you reacted to."),
                peers: { type: "array", items: { type: "string" }, description: "Hex public keys of the OTHER readers in this round." },
                round: int("The round number, so masks differ between rounds (default 0)"),
                inCorpus: str("Only count reactions in this corpus"),
            },
        },
        run: async ({ question = "", peers = [], round = 0, inCorpus }) => {
            rehydrate();
            const usable = reactions.filter((r) => r.vector?.length);
            const near = question ? await embedQuery(question) : null;
            const stats = statistics(usable, { near, corpus: inCorpus });
            const counts = Object.fromEntries(SLOTS.map((s, i) => [s, Number(stats[i])]));

            // Always report what YOUR answer is — it is your data, and the
            // reader deciding whether to join a round needs to know what they
            // would be contributing. (Named `answer`, not `mine`: the module's
            // `mine()` is the taste accessor and shadowing it here would be a
            // trap for the next verb added below.)
            const answer = { question: question || "(everything)", ...counts,
                             ofLogged: usable.length };

            if (peers.length + 1 < MIN_COHORT) {
                return {
                    ...answer,
                    share: null,
                    refused: `a cohort of ${peers.length + 1} is an interview, not an aggregate`,
                    why: `Masks cancel only across the whole cohort. Below ${MIN_COHORT} readers a "total" is close enough to one person's answer to name them, so no share is emitted — the round fails and nobody is paid, which is the correct failure.`,
                };
            }
            const me = await keypair();
            const raw = peers.map((p) => Uint8Array.from(p.replace(/^0x/, "").match(/../g).map((b) => parseInt(b, 16))));
            const share = await contribute(stats, me, raw, round);
            return {
                ...answer,
                publicKey: me.id,
                share: share.map(String),
                note: "This share is uniform over the ring until every other reader's is added to it. The publisher sees the total; your row of it is noise.",
            };
        },
    });

    tool({
        name: "collect",
        description: "Make something. Keeps a NAMED, ORDERED set of rows — a playlist, a watchlist, a shortlist, an itinerary — drawn from any open corpus, and it survives the tab. This is the verb that turns an answer into an artefact: work out what goes together with search-corpus, similar-rows or recommend, then put the ids here. Call with no arguments to list the sets that already exist, with just a name to read one back.",
        inputSchema: {
            type: "object",
            properties: {
                name: str("The set's name, e.g. \"Frostpunk playlist\". Omit to list every set."),
                add: { type: "array", items: { type: "string" }, description: "Row ids (or titles) to append, in the order you want them. Ids may come from DIFFERENT corpora in one call." },
                remove: { type: "array", items: { type: "string" }, description: "Row ids to take out" },
                note: str("What this set is for, in a sentence. Shown above it."),
                drop: { type: "boolean", description: "Delete the whole set" },
            },
        },
        view: (out) => (out.items
            ? rankedList({ heading: out.name, note: out.note || `${out.items.length} in order · kept in this browser`, hits: out.items })
            : bars({ heading: "your sets", note: "made here, kept here", items: (out.sets ?? []).map((x) => ({ label: x.name, count: x.items })) })),
        run: ({ name, add = [], remove = [], note, drop = false, corpus }) => {
            if (!name) {
                return { sets: Object.values(SETS).map((x) => ({ name: x.name, note: x.note, items: x.items.length })),
                         note: Object.keys(SETS).length ? "Pass a name to read one back." : "None yet. Pass a name and some ids to make one." };
            }
            if (drop) { delete SETS[name]; saveSets(); paintSets(); return { dropped: name }; }
            const set = (SETS[name] ??= { name, note: "", items: [] });
            if (note != null) set.note = note;

            // Ids can come from anywhere open — the whole point is a set that
            // crosses publishers, so a game and the films that go with it sit in
            // one list with no schema between them.
            const cs = span(corpus ?? "*");
            const miss = [];
            for (const id of add) {
                let hit = null;
                for (const c of cs) {
                    const r = c.rows.find((x) => x.id === id) ?? c.rows.find((x) => titleOf(x, c.roles) === id);
                    if (r) { hit = { corpus: c.name, ...brief(r, c.roles) }; break; }
                }
                if (!hit) { miss.push(id); continue; }
                if (set.items.some((x) => x.id === hit.id && x.corpus === hit.corpus)) continue;   // order is meaning; no duplicates
                set.items.push(hit);
            }
            const gone = new Set(remove);
            set.items = set.items.filter((x) => !gone.has(x.id) && !gone.has(x.title));
            saveSets();
            paintSets();
            return {
                name: set.name, note: set.note, items: set.items,
                ...(miss.length ? { notFound: miss, hint: "ids must come from a corpus that is open — call open-corpus first" } : {}),
                from: [...new Set(set.items.map((x) => x.corpus).filter(Boolean))],
            };
        },
    });

    tool({
        name: "get-row",
        description: "One row, whole, by the id a search or facet returned. The only verb that returns every field.",
        inputSchema: { type: "object", properties: { id: str("Row id, name or path") }, required: ["id"] },
        // The whole JIT argument in one function call. Nothing here knows what a
        // game or a restaurant is: `record` reads the publisher's role_map and
        // lays out a hero image, a stat row, prose and a field list only where
        // that publisher declared one. A row from a bundle that declared nothing
        // still renders — as a title and its fields, which is what it is.
        view: (out, { corpus }) => {
            if (typeof out === "string") throw new Error(out);   // a miss is text, not a card
            const { corpus: from, ...row } = out;
            const cs = span(corpus ?? "*");
            const c = cs.find((x) => x.name === from) ?? cs[0];
            const g = gatesOf(c.roles)[0];
            return record({
                row, roles: c.roles, corpus: cs.length > 1 ? c.name : null,
                // What you can DO with it, per this publisher's declaration: a
                // player, a store link, a map. `record` renders them; nothing in
                // either file knows what archive.org or Steam is.
                actions: actionsOf(row, c.roles),
                heading: `${c.name} · laid out from this publisher's role_map`,
                // Named, not hidden. A card with fields missing and no sign of it
                // is how a person concludes the data is bad rather than unpaid.
                locked: g && !g.unpublished ? g.locked : [],
                price: g && !g.unpublished ? priceLabel(g) : "",
                back: true,
            });
        },
        run: ({ id, corpus }) => {
            for (const c of span(corpus ?? "*")) {
                const r = getRow(c.rows, id, c.roles);
                if (r) return span(corpus ?? "*").length > 1 ? { corpus: c.name, ...r } : r;
            }
            return `no row ${id} in ${span(corpus ?? "*").map((c) => c.name).join(", ")}`;
        },
    });

    tool({
        name: "similar-rows",
        description: "Rows nearest a given row by vector — 'more like this' with no query to write. Use it to explore a corpus whose vocabulary you don't know yet.",
        inputSchema: {
            type: "object",
            properties: { id: str("Row id to start from"), limit: int("Max neighbours (default 10)"), fields: { type: "array", items: { type: "string" } } },
            required: ["id"],
        },
        view: (out, { corpus }) => rankedList({
            heading: `more like ${out.seed?.title ?? out.of?.title ?? "that"}`,
            note: out.seed ? `seed from ${out.seed.corpus} · ranked across ${span(corpus).map((c) => c.name).join(", ")}` : "",
            hits: out.results ?? out.near ?? [], roles: span(corpus)[0]?.roles,
        }),
        run: ({ id, limit = 10, fields, corpus }) => {
            // The row can live in one corpus and its neighbours in another — that
            // is the interesting case, not an edge one. Find it wherever it is,
            // then look for neighbours wherever we were asked to.
            const home = span("*").find((c) => getRow(c.rows, id, c.roles));
            if (!home) throw new Error(`no row ${id} in any open corpus`);
            const cs = span(corpus);
            if (cs.length === 1 && cs[0] === home) return neighbors(home.rows, id, home.roles, { limit, fields });
            const seed = home.rows.find((r) => r.id === id) ?? home.rows.find((r) => titleOf(r, home.roles) === id);
            if (!seed?.vector) throw new Error(`row ${id} has no vector — cannot compare it across corpora`);
            const t = { q: seed.vector, no: null };
            return {
                seed: { corpus: home.name, title: titleOf(seed, home.roles) },
                results: merge(cs.map((c) => ({
                    name: c.name,
                    hits: recommend(c.rows, t, { limit, exclude: new Set([id]) })
                        .map((h) => ({ ...brief(h.row, c.roles, fields), score: Number(h.score.toFixed(4)) })),
                })), { limit }),
            };
        },
    });
}

/** The sets, as chips. What an agent made is the one thing on this page a person
 *  will come back for, so it is not under the hood. */
function paintSets() {
    const names = Object.keys(SETS);
    $("sets").innerHTML = names.length
        ? `<span class="dim">yours:</span>` + names.map((n) =>
            `<button class="chip made" data-set="${esc(n)}">${esc(n)} <span class="dim">${SETS[n].items.length}</span></button>`).join("")
        : "";
    for (const b of $("sets").querySelectorAll("button[data-set]")) {
        b.onclick = async () => { const { view } = await call("collect", { name: b.dataset.set }); render(view, { list: true }); };
    }
}

// ── asking, from the page ───────────────────────────────────────────────────
//
// The box used to only re-rank the directory, so typing a question and pressing
// enter looked like nothing happened — the page could show you WHERE an answer
// lived and never fetch one. A person has no other way in: every actual answer
// here is a tool call, and without an agent attached there was no caller.
//
// So the page becomes the caller. This is the same three-step an agent runs, in
// order, through the same `call()`: rank the publishers, open the ones this
// question is actually about, then put the question to all of them at once.
async function ask(q) {
    q = q.trim();
    if (!q) return;
    $("dirQuery").value = q;
    const say = (t) => { $("answerMeta").textContent = t; };

    say("ranking publishers — nothing downloaded yet…");
    const { out: found, error } = await call("find-corpora", { query: q, limit: 10 });
    if (error) return say(`find-corpora failed: ${error}`);

    // Open what cleared this question's own floor. If nothing did — an unranked
    // directory, or no publisher has coverage baked — fall back to the top one
    // rather than silently searching only whatever happened to be open.
    const hits = (found.corpora ?? []);
    const want = hits.filter((c) => c.relevant).length ? hits.filter((c) => c.relevant) : hits.slice(0, 1);
    for (const c of want) {
        if (CORPORA.get(trimView(c.open))?.rows.length) continue;
        say(`opening ${c.domain} — ${c.rows.toLocaleString()} rows, ${c.megabytes} MB…`);
        await call("open-corpus", { view: c.open });
    }

    say(`asking ${loaded().map((c) => c.name).join(", ")}…`);
    // …and then PLAY it. The step used to end in a ranked list, which is an
    // answer about the answer: a person who asked for something to watch got a
    // table of titles and a link to an app that does not exist. `present` fills
    // the same pool from the same search and hands back a surface that starts.
    const { view, error: e2 } = await call("present", { query: q, corpus: "*", limit: 12 });
    if (e2) return say(`present failed: ${e2}`);
    say(`${want.length} of ${found.searched} publishers were about this · searched in this tab, nothing sent`);
    render(view, { stage: true });
}

/** Draw a verb's `ui://` view — in a sandboxed iframe, because that is how a
 *  host draws it. Rendering it any other way here would be a second renderer
 *  that could disagree with what an agent's host shows.
 *
 *  `list` marks a view worth coming back to, so drilling into a record is not a
 *  dead end. The record's `← results` button posts an intent; this is the state
 *  it needs and the only state the pane keeps. */
let lastList = null;
// Whether the pane is currently a stage. Only a stage can take a re-ranked queue
// — pushing one at a record view would be a message into a document that has no
// handler for it, and the ♥ on that view would then do nothing visible at all.
let staged = false;
// A host tells its views what it looks like. `ui.js` writes a light palette and
// swaps it under `prefers-color-scheme`, which is the browser's preference, not
// this page's — a dark app was rendering a white card. Appended after the view's
// own <style>, so the host wins without the view knowing anything about it.
const HOST_THEME = `<style>:root{color-scheme:dark;--fg:#c8d3de;--dim:#6b7986;--line:#232b35;--bg:#10151b;--accent:#4a9fd8}</style>`;
function render(view, { list = false, stage: isStage = false } = {}) {
    if (list) lastList = view;
    staged = isStage;
    $("answer").srcdoc = (view?.html ?? "<pre>no view</pre>") + HOST_THEME;
    $("launch").hidden = true;
}

/**
 * Where an app lives as a page of its own, with what this session learned.
 *
 * The embedded pane is right for browsing and wrong for using: a framed app's
 * `document.modelContext` is not the agent's — the agent sees the TOP document —
 * so hosting a real app costs it every tool that app registers. A player, a
 * wallet, a channel scheduler and seventeen verbs cannot live in someone else's
 * iframe, and pretending otherwise is how an index turns into a portal.
 *
 * So the shell hands over instead. `{taste}` is the coordination layer's whole
 * payload: a few hundred bytes of base64 int8 in the space every corpus on this
 * network shares, which is why the app can rank ITS rows by what you liked in
 * someone else's without either side having heard of the other.
 */
function launchUrl(tpl, { q = "" } = {}) {
    const t = mine();
    const fill = { taste: t ? JSON.stringify(exportTaste(t)) : "", q };
    const url = String(tpl).replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(fill[k] ?? ""));
    try {
        const u = new URL(url, location.href);
        return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
    } catch { return null; }
}

/** …and the host half. MCP Apps views talk back by posting a `tool` intent at
 *  their parent; a host is whatever turns that into a call. This page is one, so
 *  the `open` and `more like this` buttons inside the view are live — the same
 *  message an agent's host would receive, handled the same way.
 *
 *  The frame is sandboxed without allow-same-origin, so `e.origin` is "null" and
 *  worth nothing; identity comes from the source window being OUR frame, and the
 *  name having to be a verb we registered. Nothing else is honoured. */
addEventListener("message", async (e) => {
    if (e.source !== $("answer").contentWindow) return;
    const { type, payload } = e.data ?? {};
    if (type === "intent" && payload?.intent === "back") return render(lastList);
    if (type !== "tool" || !VERBS.has(payload?.toolName)) return;

    // A like or a skip from inside the stage. The taste moves, the pool is
    // re-ordered, and the new queue is posted BACK INTO the frame rather than
    // re-rendering it — re-rendering would replace the document and restart
    // whatever is playing. It is the only host→view message in the system and
    // this is the only reason it exists.
    if (staged && payload.toolName === "note-taste" && LAST.picks.length) {
        await call("note-taste", payload.params ?? {});
        LAST = { ...LAST, picks: order() };
        $("answer").contentWindow?.postMessage({ type: "queue", payload: { items: stageItems(LAST.picks) } }, "*");
        return;
    }

    const { out, view } = await call(payload.toolName, payload.params ?? {});
    // A verb with no view still answers — the JSON, monospaced, rather than a
    // blank pane. Every verb worth drilling into has one; this is the floor.
    render(view ?? { html: `<style>body{margin:0;padding:12px;background:#0b0b0d;color:#c8d3de;font:12px/1.5 ui-monospace,monospace}pre{white-space:pre-wrap}</style>`
        + `<pre>${esc(typeof out === "string" ? out : JSON.stringify(out, null, 1))}</pre>` },
        { list: type === "tool" && payload.toolName === "similar-rows" });
});

// ── boot ────────────────────────────────────────────────────────────────────
$("facetField").addEventListener("change", paint);

// Tools register BEFORE the corpus loads, not after. 42,215 rows take about
// twelve seconds to stream, and an agent that connects inside that window used
// to find a page with no tools at all — indistinguishable from a page that does
// not speak WebMCP. They exist immediately and answer honestly while empty;
// `rows` is read per call, never captured, so they pick up the corpus as it
// arrives without re-registering.
// Registered even when there is no host: the page calls these verbs itself, so
// a browser without WebMCP still gets a working page rather than a dead box.
const mc = document.modelContext;
register(mc?.registerTool ? mc : { registerTool() {} });
// Under the hood, not in the header. That an agent CAN drive this is worth
// saying once in prose; a live count of registered tools is a readout.
$("mcp").hidden = false;
$("mcp").textContent = mc?.registerTool
    ? `${toolCount} tools on document.modelContext`
    : `${toolCount} verbs — no document.modelContext, so no agent can call them (Chrome 150+ with --enable-features=WebMCP)`;
$("mcp").className = mc?.registerTool ? "good" : "bad";
$("hood").querySelector("summary").insertAdjacentElement("afterend", $("mcp"));

// Mark the boot view as the active one. `resolveView` alone leaves `_active`
// null, so before this the directory could not tell which corpus was already
// open and drew an "open" button next to the one you were looking at.
setView(VIEW);

// The boot view is the first corpus held, and the one in focus. Everything the
// agent opens afterwards is added beside it, never in place of it.
S.focus = trimView(VIEW);

// The directory first: a person opening this page should see what exists before
// a single shard is downloaded. Registered publishers resolve before the survey,
// or the first listing would show only what the URL named.
await discover();
survey();
$("dirQuery").addEventListener("keydown", (e) => { if (e.key === "Enter") ask(e.target.value); });

// ── the clue ────────────────────────────────────────────────────────────────
//
// The one thing a person cannot discover by looking: the interface is the agent,
// and these are the shapes of question the tools were built to answer. Clicking
// copies the sentence for the agent AND ranks the publishers here, so the same
// click shows both halves — what you would ask, and what the page does with it.
//
// ponytail: three hardcoded sentences, not generated from the open corpora.
// Generate them when the demo network stops being four fixed publishers.
const PROMPTS = [
    "surviving a frozen wasteland",
    "being trapped somewhere cold with people you cannot trust",
    "somewhere outdoors to go this weekend",
];
$("prompts").innerHTML = PROMPTS.map((p, i) => `<button class="chip" data-i="${i}">${esc(p)}</button>`).join("");
for (const b of $("prompts").querySelectorAll("button")) {
    b.onclick = async () => {
        const q = PROMPTS[b.dataset.i];
        try { await navigator.clipboard.writeText(q); b.textContent = "copied — paste it to your agent"; }
        catch { b.textContent = q; }   // clipboard denied: the text is still on screen to read
        setTimeout(() => { b.textContent = q; }, 2000);
        ask(q);
    };
}

await load(S.focus);
// A publish into the watched namespace drops the cache; re-read rather than
// leaving the page showing a corpus that has moved on. Every corpus held, not
// just the focused one — a stale bundle in the background is a wrong answer to
// a corpus:"*" question, and nothing on screen would show it.
watchShard(() => { for (const c of CORPORA.keys()) load(c); });
// What the pane opens with, and the only place the page behaves differently on
// your second visit: with a remembered taste it opens on what you would like,
// not on what happens to be in the corpus. An empty pane is the paralysis the
// scaffolding argument is about; a generic one is nearly as bad.
paintSets();
restoreReactions();

// Dropping a Steam config on the page seeds the taste from real playtime.
//
// A drop target rather than a file picker because there is nothing to choose
// between — one file does this — and because the gesture is the explanation: you
// hand the page a file, the page answers, and nothing in between touches a
// network. `seed-taste` is the verb; this is the only way a browser can get the
// bytes to it, since a tab cannot read the Steam folder on its own.
for (const ev of ["dragover", "drop"]) {
    document.addEventListener(ev, (e) => {
        e.preventDefault();
        if (ev !== "drop") return;
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            droppedVdf = String(reader.result ?? "");
            const { view, out } = await call("seed-taste", { corpus: "*" });
            $("answerMeta").textContent = out?.error
                ? `${out.error} — ${out.where ?? ""}`
                : `${out.summary} · read in this tab, nothing sent`;
            if (!out?.error) render((await call("recommend", { corpus: "*", limit: 12 })).view, { list: true });
            else if (view) render(view, { list: true });
        };
        reader.readAsText(file);
    });
}

const remembered = restoreTaste();
saveTaste();   // paints the nav count for a taste restored from a previous visit
(async () => {
    // Arriving PLAYS. It used to render a list — a table of titles and a box
    // asking you to type — which is a page about a catalogue rather than a page
    // that does anything, and it is the single reason none of this read as
    // agentic to a person who had not been told what it was. There is nothing to
    // type on arrival now: with a remembered taste the queue is already yours,
    // and without one it is the widest spread these publishers hold.
    const { view, error } = await call("present", { corpus: "*", limit: 12 });
    if (!lastList) {
        if (error) render((await call("browse-collection", {})).view, { list: true });
        else render(view, { stage: true });
    }
    if (remembered && !error) {
        const n = remembered.from?.length ?? 0;
        $("answerMeta").textContent = `picking up where you left off — ${n} thing${n === 1 ? "" : "s"} you liked, `
            + `remembered in this browser only. Ask anything to start over.`;
    }
})();

// The embedder is a 131MB download on first visit; warm it now so the agent's
// first search isn't the thing that waits for it.
warmEmbedder?.();
