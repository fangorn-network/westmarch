// The stock page every `westmarch ship` app deploys: a front page of what is coming up and
// what just happened, search, a page per record with its source document inline, and what
// the reader saved, kept on their device. All of it from the roles the app declared.
//
//   #/                 the feed (and "For you", once something is saved)
//   #/signals          things followed across records (the `thread` role), a card each
//   #/search/<query>   search
//   #/item/<key>       one record: its document, its meeting, what is like it
//   #/for-you          the taste kernel over what you saved (☆), with its four knobs
//   #/saved            liked items, exportable; the taste they make
//   #/history          this session's searches
import { configure, loadShard } from "../src/core/shard.js";
import { linkOf, rolesFrom, subtitleOf, textOf, titleOf, values } from "../src/core/roles.js";
import { getRow, neighbors, search, threads } from "../src/agent/tools.js";
import { KNOBS, discover } from "../src/taste/taste.js";
import { embedQuery } from "../src/core/embed.js";
import { registerAgent } from "./agent.js";
import { detail, facetField, occasions } from "./feed.js";
import { createStore, snapshot, toCSV, toMarkdown } from "./store.js";
import { createMap } from "./map.js";

const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids.flat(Infinity).filter((k) => k != null && k !== false)); return e; };
const clip = (s, n = 220) => (s.length > n ? `${s.slice(0, s.lastIndexOf(" ", n))} …` : s);
const day = (d) => (d ? new Date(`${String(d).slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" }) : "");

const ctx = { rows: [], roles: rolesFrom([]), queryVector: (q) => embedQuery(q).catch(() => null) };
let rolesReady;
const described = new Promise((ok) => { rolesReady = ok; });
configure({ onManifests: (ms) => { ctx.roles = rolesFrom(ms); rolesReady(); }, rowText: (f) => textOf(f, ctx.roles) });

const card = await fetch("./.well-known/agent-card.json").then((r) => r.json()).catch(() => ({}));
// Buy from the origin this page is on: a custom domain serves the same worker, and a reader
// whose network can't reach pages.dev (or the card's host) still can.
const offer = (card.capabilities?.extensions ?? []).map((x) => x.params?.paid).find(Boolean) ?? null;
const paid = offer && { ...offer, url: offer.url.replace(/^https?:\/\/[^/]+/, location.origin) };
// A dollar stablecoin is priced in dollars: readers see "$0.01", never the token.
const money = (n) => (/^USDC?$/i.test(paid?.symbol ?? "USDC") ? `$${n.toFixed(2)}` : `${n} ${paid.symbol}`);
const PRICE_N = paid ? Number(paid.price) / 10 ** (paid.decimals ?? 6) : 0, PRICE = paid ? money(PRICE_N) : "";
const NAME = card.name ?? "Fangorn app";
document.title = NAME;
if (paid) $("#accountlink").hidden = false;
$("#name").textContent = NAME;

// Links to the app's own pages (app.json site.nav), after Saved and History.
fetch("./nav.json").then((r) => r.json()).then((links) => $("nav").append(...links.map((l) => el("a", { href: l.href }, l.label)))).catch(() => {});
// A map, when the app ships one (map.json): regions to shade and search on. Pages answers a
// missing file with index.html, so only JSON counts.
const geo = await fetch("./map.json").then((r) => ((r.headers.get("content-type") ?? "").includes("json") ? r.json() : null)).catch(() => null);
if (geo) $("nav").prepend(el("a", { href: "#/map" }, "Map"));

const input = $("#q input");
input.disabled = false;
const SLUG = NAME.toLowerCase().replace(/\W+/g, "-");
const store = createStore({ local: globalThis.localStorage, session: globalThis.sessionStorage, app: SLUG });
ctx.session = () => store.bundle({ name: NAME, url: location.origin });
// The page draws as the shards arrive (a view can be tens of MB), rather than after the last.
const VIEW = new URL("view", location.href).href;
const total = await fetch(`${VIEW}/cdn/catalog`).then((r) => r.json()).then((c) => c.domains.reduce((n, d) => n + (d.count ?? 0), 0)).catch(() => 0);
let loaded = false, drawn = 0;
const loading = loadShard(VIEW, (rows) => {   // checked against the manifests' sha256, shard by shard
    ctx.rows = rows; reindex();
    if (Date.now() - drawn > 1500 && /^(#\/?(signals)?)?$/.test(location.hash)) { drawn = Date.now(); route(); }
});
await described;

// ── records ──
const R = ctx.roles;
if (R.thread) $("nav").prepend(el("a", { href: "#/signals" }, "Signals"));
const keyOf = (r) => String((R.identity && r[R.identity]) ?? r.id);
let byKey = new Map(), byId = new Map(), facet = null, places = [], threadIndex = null;
function reindex() {
    byKey = new Map(ctx.rows.map((r) => [keyOf(r), r]));
    byId = new Map(ctx.rows.map((r) => [r.id, r]));
    threadIndex = null;
    facet ??= facetField(ctx.rows, R);
    places = facet ? [...ctx.rows.reduce((m, r) => { const v = placeOf(r); if (v) m.set(v, (m.get(v) ?? 0) + 1); return m; }, new Map())].sort((a, b) => a[0].localeCompare(b[0])) : [];
    const n = ctx.rows.length.toLocaleString();
    input.placeholder = loaded && !ctx.rows.length ? "No records yet" : loaded ? `Search ${n} records${places.length > 1 ? ` in ${places.length} places` : ""}…`
        : `Loading ${n}${total ? ` of ${total.toLocaleString()}` : ""} records… (search what is here)`;
}
const placeOf = (r) => (facet ? values(r[facet] ?? "")[0] ?? "" : "");
const dateOf = (r) => String(r[R.temporal?.[0]] ?? "").slice(0, 10);
const docUrl = (r) => linkOf(r, R);
const snap = (r) => snapshot(r, { key: keyOf(r), title: titleOf(r, R), subtitle: subtitleOf(r, R), place: placeOf(r), date: dateOf(r), link: docUrl(r), detail: detail(r, R) });
// Minutes shout ("ORDINANCE 1-2-26: APPROVING REZONING REQUEST"): shown in sentence case,
// keeping short all-caps words, which are acronyms (TID, EMS, CTH).
const calm = (t) => (/[a-z]/.test(t) || !/[A-Z]{5}/.test(t) ? t
    : t.toLowerCase().replace(/\b[a-z]{1,3}\b/g, (w, at) => (/^(and|or|of|the|to|for|in|on|at|by|a|an|as|is|be|no|from)$/.test(w) ? w : w.toUpperCase()))
        .replace(/^\W*\w/, (c) => c.toUpperCase()).replace(/([.:;!?]\s+|\u2013\s+|-\s+)(\w)/g, (_, p, c) => p + c.toUpperCase()));
const titleText = (r) => calm(titleOf(r, R));
const itemHref = (r) => `#/item/${encodeURIComponent(keyOf(r))}`;

// Words of the query, marked where they appear. DOM nodes, never HTML: the text is a stranger's.
const marked = (text, terms) => {
    if (!terms.length) return [text];
    const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
    return String(text).split(re).map((part, i) => (i % 2 ? el("mark", {}, part) : part));
};

// ── taste: a star on every record (saved, or not), kept on this device ──
// A saved item is a like the taste is built from. Agents can still pass on items (`rate`).
// One entry point for the page and the `rate` tool, so a vote an agent casts shows here too.
const verdictOf = (k) => (store.isSaved(k) ? "like" : store.passed().some((p) => p.key === k) ? "dislike" : null);
ctx.rate = (id, verdict) => {
    if (!["like", "dislike", "clear"].includes(verdict)) return { error: "verdict is like, dislike or clear" };
    const r = byId.get(id) ?? byKey.get(String(id)) ?? byId.get(getRow(ctx.rows, id, R)?.id);
    if (!r) return { error: `no record ${id}` };
    const k = keyOf(r);
    store.unvote(k);
    if (verdict === "like") store.toggleSave(snap(r));
    if (verdict === "dislike") store.pass(snap(r));
    paintVotes(); counts();
    if (/^#\/for-you/.test(location.hash)) forYou();
    return { likes: store.saved().map((x) => x.title), dislikes: store.passed().map((x) => x.title) };
};
// Likes and dislikes as the kernel takes them: the loaded row when there is one, else the saved snapshot.
ctx.votes = () => {
    const live = (x) => { const r = byKey.get(x.id); return r ? { id: r.id, title: x.title, vector: r.vector } : x; };
    const { likes, dislikes } = store.votes();
    return { likes: likes.map(live).filter((x) => x.vector), dislikes: dislikes.map(live).filter((x) => x.vector) };
};
const votes = (r) => {
    const b = el("button", { type: "button", className: "vote star", title: "Save", ariaLabel: `Save: ${titleOf(r, R)}`,
        onclick: (e) => { e.preventDefault(); ctx.rate(r.id, verdictOf(keyOf(r)) === "like" ? "clear" : "like"); } });
    Object.assign(b.dataset, { key: keyOf(r), vote: "like" });
    return el("span", { className: "votes" }, b);
};
// aria-pressed carries the state; the glyph follows it (★ saved, ☆ not).
function paintVotes() {
    for (const b of document.querySelectorAll("button.vote[data-vote]")) {
        const on = verdictOf(b.dataset.key) === b.dataset.vote;
        b.setAttribute("aria-pressed", String(on)); b.textContent = on ? "★" : "☆"; b.title = on ? "Saved" : "Save";
    }
}

const row = (r, { terms = [], also = 0, meta = true } = {}) => {
    const d = detail(r, R);
    return el("li", { className: "row" },
        el("div", { className: "main" },
            el("a", { href: itemHref(r), className: "title" }, marked(titleText(r), terms)),
            meta ? el("small", {}, [placeOf(r), subtitleOf(r, R)].filter(Boolean).join(" · ")) : null,
            d ? el("p", { className: "detail" }, marked(clip(d), terms)) : null,
            also ? el("small", { className: "also" }, `and ${also} more record${also > 1 ? "s" : ""} of the same item`) : null,
            forSale(r) ? el("small", { className: "forsale" }, `Decision record · ${PRICE}`) : null),
        votes(r));
};

const forSale = (r) => paid && r.paid_sha256;

// ── threads: one matter (say) followed across meetings, from the `thread` role ──
const allThreads = () => {
    if (!threadIndex) {
        const all = R.thread ? threads(ctx.rows, R, { min: 1, limit: Infinity }).threads : [];
        threadIndex = { list: all.filter((t) => t.steps.length >= 2), byId: new Map(all.map((t) => [t.id, t])),
                        byHead: new Map(all.filter((t) => t.head).map((t) => [t.head.id, t])) };
    }
    return threadIndex;
};
const threadOf = (r) => (R.thread ? (r[R.thread] != null ? allThreads().byId.get(String(r[R.thread])) : allThreads().byHead.get(r.id)) : null);
// Where a step stands: its `outcome` (Quorum's minutes, Legistar's action), else its `status`
// (Legistar's) unless that names the agenda's state rather than the matter's. ponytail: field
// names by convention; declare a stage role if a second app needs others.
const NOT_A_STAGE = /agenda|consent|discussion|archiv|miscellan|presentation|published|^items/i;
const stageOf = (r) => (r?.outcome ?? (r?.status && !NOT_A_STAGE.test(r.status) ? r.status : null))?.trim().toLowerCase() || null;
// A thread stands where its latest step that says so does.
const threadStage = (t) => t.steps.map((s) => stageOf(byId.get(s.id))).findLast(Boolean) ?? null;
const meetingOf = (r) => (subtitleOf(r, R) ?? "").replace(/\s*·\s*\d{4}-\d\d-\d\d$/, "");
const shortDay = (d) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
const timeline = (t) => el("ol", { className: "steps" }, t.steps.map((s) => byId.get(s.id)).filter(Boolean).map((r) =>
    el("li", {}, el("time", { dateTime: dateOf(r) }, shortDay(dateOf(r))),
        el("span", {}, el("a", { href: itemHref(r) }, meetingOf(r) || titleText(r)), stageOf(r) ? ` · ${stageOf(r)}` : ""))));

// ── the place picker: one native select, whatever the number of places ──
let only = null;
const picker = () => (places.length > 1 ? el("label", { className: "picker" }, el("span", {}, `${facet ? facet[0].toUpperCase() + facet.slice(1) : "Place"}`),
    el("select", { id: "place", onchange: (e) => { only = e.target.value || null; route(); } },
        [[null, ctx.rows.length], ...places].map(([v, n]) =>
            el("option", { value: v ?? "", selected: v === only }, `${v ?? "All"} (${n.toLocaleString()})`)))) : null);

// The app's description, first clause up front and the rest a click away: the content starts
// above the fold, and an agent still reads the whole description off the card.
const about = (text) => {
    const cut = text.search(/[:.;]\s/);
    if (cut < 0 || cut > 160) return el("p", { className: "about" }, text);
    return el("details", { className: "about" }, el("summary", {}, text.slice(0, cut + 1).replace(/:$/, ".")), el("p", {}, text.slice(cut + 2)));
};
const inPlace = (r) => !only || placeOf(r) === only;

// ── views ──
const view = $("#view");
const show = (...kids) => { view.replaceChildren(...kids.flat().filter(Boolean)); paintVotes(); window.scrollTo(0, 0); };

function occasionCard(g) {
    const SHOW = 5, list = el("ul", {}, g.items.slice(0, SHOW).map((r) => row(r, { meta: false })));
    const more = g.items.length > SHOW ? el("button", { type: "button", className: "more",
        onclick: (e) => { list.append(...g.items.slice(SHOW).map((r) => row(r, { meta: false }))); e.target.remove(); } }, `${g.items.length - SHOW} more`) : null;
    return el("article", {}, el("header", {}, el("time", { dateTime: g.date }, day(g.date)),
        el("h3", {}, [g.place, g.label.replace(/\s*·\s*\d{4}-\d\d-\d\d$/, "")].filter(Boolean).join(" — "))), list, more);
}

let pastShown = 12;
// A card per thread: where it stands, its timeline, the record it links to, and the paid
// decision record of its latest step that has one, bought per card.
function signalCard(t) {
    const last = byId.get(t.steps.at(-1).id), head = t.head && byId.get(t.head.id);
    const sold = paid ? t.steps.map((s) => byId.get(s.id)).reverse().find((r) => r?.paid_sha256) : null;
    const d = detail(last, R);
    return el("article", { className: "signal" },
        el("div", { className: "meta" }, el("span", {}, placeOf(last)), head && subtitleOf(head, R) ? el("span", {}, subtitleOf(head, R)) : null,
            threadStage(t) ? el("span", { className: "stage" }, threadStage(t)) : null, el("time", { dateTime: t.date }, shortDay(t.date))),
        el("h3", {}, el("a", { href: itemHref(head ?? last), className: "title" }, calm(t.title))),
        d ? el("p", { className: "detail" }, clip(d)) : null,
        timeline(t),
        sold ? decision(sold) : null,
        el("div", { className: "acts" }, votes(head ?? last), t.url ? el("a", { href: t.url, target: "_blank", rel: "noopener", className: "act" }, "Official record ↗") : null));
}

let stageOnly = null, signalsShown = 30;
function signals() {
    const lastOf = (t) => byId.get(t.steps.at(-1).id);
    const { list } = allThreads();
    const stages = [...new Set(list.map(threadStage).filter(Boolean))].sort();
    const mine = list.filter((t) => inPlace(lastOf(t)) && (!stageOnly || threadStage(t) === stageOnly));
    show(el("h2", { className: "page" }, "Signals"),
        el("p", { className: "hint" }, "Decisions followed across meetings, from committee to council, the latest to move first. Each links to its official record."),
        el("div", { className: "chips" }, picker(), stages.length ? el("label", { className: "picker" }, el("span", {}, "Stage"),
            el("select", { onchange: (e) => { stageOnly = e.target.value || null; signalsShown = 30; signals(); } },
                [null, ...stages].map((s) => el("option", { value: s ?? "", selected: s === stageOnly }, s ?? "Any stage")))) : null),
        el("p", { className: "hint" }, `${mine.length.toLocaleString()} signal${mine.length === 1 ? "" : "s"}`),
        mine.length ? mine.slice(0, signalsShown).map(signalCard)
            : el("p", { className: "empty" }, loaded ? "Nothing followed across meetings here yet." : "Loading the records…"),
        mine.length > signalsShown ? el("button", { type: "button", className: "more", onclick: () => { signalsShown += 30; signals(); } }, "Show more") : null);
}

function feed() {
    // A thread's own record (a matter) is not an occasion: its steps are already in the feed.
    const heads = allThreads().byHead;
    const { upcoming, past } = occasions(heads.size ? ctx.rows.filter((r) => !heads.has(r.id)) : ctx.rows, R, { facet, only });
    const { likes, dislikes } = ctx.votes();
    const mine = discover(ctx.rows.filter(inPlace), likes, dislikes, { ...knobs, limit: 6 });
    const nSold = paid ? ctx.rows.filter((r) => r.paid_sha256 && inPlace(r)).length : 0;
    show(card.description ? about(card.description) : null, picker(),
        nSold ? el("p", { className: "callout" }, `${nSold.toLocaleString()} decisions${only ? ` in ${only}` : ""} come with a decision record: the vote, the money and who it goes to, and the organizations involved, read from the minutes, ${PRICE} each. `,
            el("a", { href: R.thread ? "#/signals" : "#/search/decision" }, "See them")) : null,
        mine.picks.length ? el("section", {}, el("h2", {}, "For you"), el("p", { className: "hint" }, `From the ${mine.taste.n} item${mine.taste.n > 1 ? "s" : ""} you liked. `, el("a", { href: "#/for-you" }, "Tune")),
            el("ul", { className: "list" }, mine.picks.map(({ row: r }) => row(r)))) : null,
        upcoming.length ? el("section", {}, el("h2", {}, "Coming up"), upcoming.slice(0, 8).map(occasionCard)) : null,
        past.length ? el("section", {}, el("h2", {}, "Recently"), past.slice(0, pastShown).map(occasionCard),
            past.length > pastShown ? el("button", { type: "button", className: "more", onclick: () => { pastShown += 12; feed(); } }, "Show more") : null) : null,
        !upcoming.length && !past.length ? el("p", { className: "empty" }, !loaded ? "Loading the records…"
            : ctx.rows.length ? "Nothing dated here yet. Search above."
            : "This app is registered and being built. Its records will appear here once they are published.") : null);
}

let sortBy = "relevance", seq = 0, mapView = null;
async function results(q) {
    if (document.activeElement !== $("#q input")) $("#q input").value = q;
    const mine = ++seq;
    // Meaning needs the embedding model, which the first search downloads (~130MB). Nobody
    // waits on that: words answer at once, and meaning replaces them when it is ready.
    const vec = ctx.queryVector(q);
    const qv = await Promise.race([vec, new Promise((ok) => setTimeout(() => ok(undefined), 400))]);
    if (mine !== seq) return;   // a newer search won
    if (qv === undefined) vec.then((v) => { if (v && mine === seq) render(q, v); });
    render(q, qv ?? null, qv === undefined);
}

function render(q, qv, loading = false) {
    const hits = search(ctx.rows, q, R, { qv, limit: 80, ...(only && facet ? { where: { [facet]: only } } : {}) });
    // One result per item: the same agenda item turns up in its agenda, its packet and its minutes.
    const groups = new Map();
    for (const h of hits) {
        const r = byId.get(h.id); if (!r) continue;
        const k = `${placeOf(r)}|${titleOf(r, R).toLowerCase()}`;
        const g = groups.get(k);
        if (!g) groups.set(k, { r, also: 0 });
        else { g.also++; if (detail(r, R).length > detail(g.r, R).length) g.r = r; }
    }
    let list = [...groups.values()];
    if (sortBy === "newest") list = list.sort((a, b) => dateOf(b.r).localeCompare(dateOf(a.r)));
    const terms = q.toLowerCase().split(/\W+/).filter((t) => t.length > 2);
    const sorter = el("div", { className: "sort" }, "Sort: ", ["relevance", "newest"].map((s) =>
        el("button", { type: "button", className: s === sortBy ? "chip on" : "chip", onclick: () => { sortBy = s; render(q, qv, loading); } }, s)));
    show(picker(), el("div", { className: "resultsbar" }, el("span", {}, `${list.length} result${list.length === 1 ? "" : "s"} for “${q}”${only ? ` in ${only}` : ""}`,
            loading ? el("small", {}, " · matching words; search by meaning is loading") : null), sorter),
        list.length ? el("ul", { className: "list" }, list.slice(0, 40).map(({ r, also }) => row(r, { terms, also })))
            : el("p", { className: "empty" }, "No matches. Try other words, or All places."));
}

function item(key) {
    const r = byKey.get(key);
    if (!r) return show(el("p", { className: "empty" }, "That record is not in this app any more. ", el("a", { href: "#/" }, "Home")));
    const src = docUrl(r), d = detail(r, R);
    const HIDE = new Set(["id", "owner", "text", "vector", "norm", "embed", "entityType", R.identity, R.thread, ...R.title, ...R.subtitle, ...R.media, ...(R.temporal ?? [])]);
    const facts = Object.entries(r).filter(([k, v]) => !HIDE.has(k) && !/(_id|_sha256)$|^paid_/.test(k) && (typeof v === "string" || typeof v === "number") && String(v).length < 120);
    const frame = el("div", { className: "doc" });
    const docBtn = src ? el("button", { type: "button", className: "act", onclick: () => {
        if (frame.firstChild) { frame.replaceChildren(); docBtn.textContent = "View document"; return; }
        frame.append(el("iframe", { src: `./doc?u=${encodeURIComponent(src)}${Number(r.page) > 1 ? `#page=${r.page}` : ""}`, title: "Source document", loading: "lazy" }));
        docBtn.textContent = "Hide document";
    } }, "View document") : null;
    const occ = occasions(ctx.rows.filter((x) => placeOf(x) === placeOf(r) && dateOf(x) === dateOf(r) && subtitleOf(x, R) === subtitleOf(r, R)), R, { facet });
    const siblings = [...occ.upcoming, ...occ.past].flatMap((g) => g.items).filter((x) => titleOf(x, R) !== titleOf(r, R));
    const thread = threadOf(r);
    const near = neighbors(ctx.rows, r.id, R, { limit: 12 }).near.map((h) => byId.get(h.id)).filter((x) => x && titleOf(x, R) !== titleOf(r, R)).slice(0, 6);
    show(el("p", {}, el("a", { href: "#/", onclick: (e) => { if (history.length > 1) { e.preventDefault(); history.back(); } } }, "← Back")),
        el("article", { className: "record" },
            el("small", {}, [placeOf(r), subtitleOf(r, R)].filter(Boolean).join(" · ")),
            el("h2", {}, titleText(r)),
            d ? el("p", {}, d) : el("p", { className: "hint" }, "No decision is recorded under this item (it may be on an agenda, before the meeting)."),
            facts.length ? el("dl", {}, facts.map(([k, v]) => [el("dt", {}, k.replace(/_/g, " ")), el("dd", {}, String(v))])) : null,
            el("div", { className: "acts" }, votes(r), docBtn, src ? el("a", { href: src, target: "_blank", rel: "noopener", className: "act" }, "Source ↗") : null),
            paid && r.paid_sha256 ? decision(r) : null,
            frame),
        thread && thread.steps.length > 1 ? el("section", {}, el("h2", {}, "Followed across meetings"), timeline(thread)) : null,
        siblings.length ? el("section", {}, el("h2", {}, "Same meeting"), el("ul", { className: "list" }, siblings.slice(0, 12).map((x) => row(x, { meta: false })))) : null,
        near.length ? el("section", {}, el("h2", {}, "Similar"), el("ul", { className: "list" }, near.map((x) => row(x)))) : null);
}

// The item's paid record: what was decided, as fields. Bought with the reader's account (a
// wallet underneath, paying over x402 as an agent does; none of that is said on the page), and
// checked against the sha256 the app published. A record once bought
// is kept on this device, so opening the item again never charges twice.
const bought = { get(k) { try { return JSON.parse(localStorage.getItem(`${SLUG}:paid:${k}`)); } catch { return null; } },
                 set(k, v) { try { localStorage.setItem(`${SLUG}:paid:${k}`, JSON.stringify(v)); } catch { /* not kept */ } } };
function decision(r) {
    const key = r[R.identity] ?? r.id, box = el("section", { className: "paid" });
    const fields = (got) => {
        const x = got.record;
        // The DOM's own replaceChildren writes null as "null"; el() is what skips it.
        box.replaceChildren(...[el("h3", {}, "Decision record"),
            x.summary ? el("p", {}, x.summary) : null,
            el("dl", {}, [["Action", x.action], ["Outcome", x.outcome], ["Vote", x.vote && `${x.vote.for}–${x.vote.against}`]]
                .filter(([, v]) => v).map(([k, v]) => [el("dt", {}, k), el("dd", {}, v)])),
            x.steps?.length > 1 ? el("ol", {}, x.steps.map((st) => el("li", {}, st.result ? `${st.motion} · ${st.result}` : st.motion))) : null,
            x.amounts?.length ? el("ul", {}, x.amounts.map((a) => el("li", {}, typeof a === "string" ? a : [a.amount, a.for ? ` · ${a.for}` : ""]))) : null,
            x.organizations?.length ? el("p", {}, "Organizations: ", x.organizations.map((o) => typeof o === "string" ? o : `${o.name}${o.role !== "other" ? ` (${o.role})` : ""}`).join(", ")) : null,
            el("small", { title: got.receipt?.transaction ?? "" }, got.verified ? "✓ Checked against the record this app published" : got.verified === false ? "✗ Does not match the record this app published" : "",
               got.receipt?.transaction ? ` · Bought for ${PRICE}` : "")].filter(Boolean));
    };
    const have = bought.get(key);
    if (have) { fields(have); return box; }
    const status = el("small", {}), btn = el("button", { type: "button", className: "act" }, `Read the decision record · ${PRICE}`);
    btn.onclick = async () => {
        btn.disabled = true; status.textContent = "Signing you in…";
        try {
            const w = await (await import("./wallet.js")).wallet(paid);
            await w.signIn();
            const bal = await w.balance().catch(() => null);
            if (bal != null && bal < PRICE_N) {
                btn.disabled = false;
                return status.replaceChildren(`Your account has ${money(bal)}. `, el("a", { href: "#/account" }, "Add credit"), ` to read it.`);
            }
            status.textContent = "Buying…";
            const got = await w.buy(key, r.paid_sha256);
            if (got.error) throw new Error(got.error);
            bought.set(key, got); fields(got);
        } catch (e) {
            btn.disabled = false;
            status.replaceChildren(`Couldn't buy it: ${e.message}. `, el("a", { href: "#/account" }, "Your account"));
        }
    };
    box.append(el("h3", {}, "Decision record"),
        el("p", { className: "hint" }, r.paid_includes ? `Includes ${r.paid_includes}, read from the minutes.`
            : "What was decided, read from the minutes: the action, the vote, the amounts and who they go to, the organizations."),
        el("div", { className: "acts" }, btn, status));
    return box;
}

function download(name, text, type) {
    const a = el("a", { href: URL.createObjectURL(new Blob([text], { type })), download: name });
    document.body.append(a); a.click(); a.remove();
}

// "For you": the kernel with its knobs. Knob settings are a per-viewer convenience, kept locally.
const knobStore = { get() { try { return JSON.parse(localStorage.getItem(`${SLUG}:knobs`)) ?? {}; } catch { return {}; } },
                    set(v) { try { localStorage.setItem(`${SLUG}:knobs`, JSON.stringify(v)); } catch { /* not kept */ } } };
const knobs = { ...Object.fromEntries(Object.entries(KNOBS).map(([k, [d]]) => [k, d])), ...knobStore.get(), seed: 1 };
const KNOB_LABELS = { lookahead: ["Lookahead", "what you like now", "where you're heading"], variety: ["Variety", "close to each other", "all different"],
                      surprise: ["Surprise", "best first", "shuffled"], reach: ["Reach", "nearest", "further out"] };
function forYou() {
    const { likes, dislikes } = ctx.votes();
    const res = discover(ctx.rows.filter(inPlace), likes, dislikes, { ...knobs, limit: 30 });
    const knob = (name) => {
        const [label, lo, hi] = KNOB_LABELS[name], out = el("output", {}, `${Math.round(knobs[name] * 100)}%`);
        const input = el("input", { type: "range", min: 0, max: 1, step: 0.05, value: knobs[name], id: `k-${name}`, title: KNOBS[name][1] });
        input.oninput = () => { out.textContent = `${Math.round(input.value * 100)}%`; };
        input.onchange = () => { knobs[name] = Number(input.value); knobStore.set({ ...knobs, seed: undefined }); forYou(); document.getElementById(`k-${name}`)?.focus(); };
        return el("label", { className: "knob", htmlFor: `k-${name}` }, el("span", {}, label, out), input, el("small", {}, `${lo} ↔ ${hi}`));
    };
    const pill = (x, no) => el("li", { className: no ? "no" : "" }, x.title,
        el("button", { type: "button", ariaLabel: `Forget ${x.title}`, onclick: () => ctx.rate(x.id, "clear") }, "×"));
    show(el("h2", { className: "page" }, "For you"), picker(),
        el("section", { className: "taste" },
            likes.length || dislikes.length ? el("ul", { className: "pills" }, likes.slice(-30).map((x) => pill(x)), dislikes.slice(-10).map((x) => pill(x, true)))
                : el("p", { className: "hint" }, "Save records with ☆ and this fills with more like them. Newer saves count more; it all stays in this browser."),
            res.taste ? el("p", { className: "hint" }, res.taste.heading ? "Your recent likes point somewhere new; Lookahead follows them." : "Like 4 or more and Lookahead can follow where your taste is heading.") : null,
            el("div", { className: "knobs" }, Object.keys(KNOBS).map(knob)),
            el("button", { type: "button", className: "act", disabled: !knobs.surprise, title: knobs.surprise ? "" : "Turn up Surprise to reroll",
                onclick: () => { knobs.seed++; forYou(); } }, "Reroll")),
        res.picks.length ? el("ul", { className: "list" }, res.picks.map(({ row: r }) => row(r))) : null);
}

function saved() {
    const items = store.saved(), t = store.taste(), slug = NAME.toLowerCase().replace(/\W+/g, "-");
    const bundle = () => JSON.stringify(store.bundle({ name: NAME, url: location.origin }), null, 1);
    const copy = el("button", { type: "button", className: "act", onclick: async () => {
        try { await navigator.clipboard.writeText(bundle()); copy.textContent = "Copied"; } catch { download(`${slug}-session.json`, bundle(), "application/json"); }
    } }, "Copy for an agent");
    show(el("h2", { className: "page" }, `Saved (${items.length})`),
        items.length ? el("div", { className: "acts" },
            el("button", { type: "button", className: "act", onclick: () => download(`${slug}-saved.json`, bundle(), "application/json") }, "Export JSON"),
            el("button", { type: "button", className: "act", onclick: () => download(`${slug}-saved.csv`, toCSV(items), "text/csv") }, "CSV"),
            el("button", { type: "button", className: "act", onclick: () => download(`${slug}-saved.md`, toMarkdown(items, `${NAME}: saved`), "text/markdown") }, "Markdown"),
            copy) : el("p", { className: "empty" }, "Nothing saved yet. Tap ☆ on a record; what you save stays on this device."),
        t ? el("p", { className: "hint" }, `"For you" is built from these ${t.n}${t.rejected.length ? `, and away from ${t.rejected.length} you passed on` : ""}. It lives in this browser; the export carries it, so an agent can use it too. `,
            el("button", { type: "button", className: "linkish", onclick: () => { store.clear("passed"); saved(); counts(); } }, "Forget what I passed on")) : null,
        el("ul", { className: "list" }, items.slice().reverse().map((i) => {
            const r = byKey.get(i.key);
            return el("li", { className: "row" }, el("div", { className: "main" },
                el("a", { href: r ? itemHref(r) : i.url ?? "#/", className: "title" }, i.title),
                el("small", {}, [i.place, i.subtitle].filter(Boolean).join(" · ")),
                i.detail ? el("p", { className: "detail" }, clip(i.detail)) : null),
                el("button", { type: "button", className: "vote", ariaLabel: `Forget ${i.title}`, title: "Forget", onclick: () => { store.unvote(i.key); saved(); counts(); } }, "×"));
        })));
}

function historyView() {
    const h = store.history();
    show(el("h2", { className: "page" }, "Searches this session"),
        h.length ? el("ul", { className: "list" }, h.map(({ q, at }) => el("li", { className: "row" }, el("div", { className: "main" },
            el("a", { href: `#/search/${encodeURIComponent(q)}`, className: "title" }, q), el("small", {}, new Date(at).toLocaleTimeString()))))) : el("p", { className: "empty" }, "No searches yet."),
        h.length ? el("button", { type: "button", className: "act", onclick: () => { store.clear("history"); historyView(); } }, "Clear") : null);
}

// The reader's account: who they are signed in as, their credit, and adding to it. A wallet
// underneath (Privy's, one across every Fangorn app); the page says account and credit.
async function accountView() {
    show(el("p", { className: "empty" }, "Opening your account…"));
    let w;
    try { w = await (await import("./wallet.js")).wallet(paid); } catch (e) { return show(el("p", { className: "empty" }, `Accounts are unavailable: ${e.message}`)); }
    const draw = async () => {
        if (!location.hash.startsWith("#/account")) return;
        if (!w.authenticated) return show(el("h2", { className: "page" }, "Account"),
            el("p", {}, `Sign in to read decision records (${PRICE} each). Use your email or Google: nothing to install, no password, and the same account works in every Fangorn app.`),
            el("div", { className: "acts" }, el("button", { type: "button", className: "act", onclick: () => w.signIn() }, "Sign in")));
        const bal = w.address ? await w.balance().catch(() => null) : null;
        const copy = el("button", { type: "button", className: "linkish", onclick: async () => { await navigator.clipboard.writeText(w.address); copy.textContent = "Copied"; } }, "Copy");
        show(el("h2", { className: "page" }, "Account"),
            el("dl", {}, el("dt", {}, "Signed in as"), el("dd", {}, w.email ?? "you"),
               el("dt", {}, "Credit"), el("dd", {}, !w.address ? "setting up your account…" : bal == null ? "…" : `${money(bal)} · ${Math.floor(bal / PRICE_N + 1e-9).toLocaleString()} record${Math.floor(bal / PRICE_N + 1e-9) === 1 ? "" : "s"}`)),
            el("div", { className: "acts" },
                el("button", { type: "button", className: "act", onclick: () => w.addFunds() }, w.faucet ? "Get free test credit" : "Add credit"),
                el("button", { type: "button", className: "act", onclick: () => w.logout() }, "Sign out")),
            w.faucet && w.address ? el("section", {}, el("p", { className: "hint" }, `${NAME} is in testing, so credit is free. The button opens Circle's test-credit page: choose USDC on ${w.chain.name}, paste your account number below, and send.`),
                el("p", {}, el("small", {}, "Account number: "), el("code", {}, w.address), " ", copy)) : null,
            el("p", { className: "hint" }, "Records you buy stay readable on this device."));
    };
    w.onChange(() => { draw(); });
}

// ── routing ──
function counts() { const n = store.saved().length; $("#nsaved").textContent = n ? ` (${n})` : ""; }
function route() {
    const [, name = "", arg = ""] = (location.hash.match(/^#\/([^/]*)\/?(.*)$/) ?? []);
    const a = decodeURIComponent(arg);
    for (const l of document.querySelectorAll("nav a")) l.classList.toggle("on", l.getAttribute("href") === `#/${name}`);
    document.body.classList.toggle("wide", name === "map");
    if (name === "search" && a) return results(a);
    if (name === "item" && a) return item(a);
    if (name === "signals" && R.thread) return signals();
    if (name === "saved") return saved();
    if (name === "for-you") return forYou();
    if (name === "history") return historyView();
    if ((name === "account" || name === "wallet") && paid) return accountView();
    if (name === "map" && geo) return (mapView ??= createMap(geo, { el, show, row, placeOf, ctx })).render(...arg.split("/").map(decodeURIComponent));
    $("#q input").value = "";
    return feed();
}

let typing;
input.oninput = () => {
    clearTimeout(typing);
    const q = input.value.trim();
    typing = setTimeout(() => {
        if (!q) { if (location.hash.startsWith("#/search")) location.hash = "#/"; return; }
        history.replaceState(null, "", `#/search/${encodeURIComponent(q)}`);   // shareable, without one entry per keystroke
        results(q);
    }, 250);
};
$("#q").onsubmit = (e) => { e.preventDefault(); const q = input.value.trim(); if (!q) return; store.remember(q); location.hash = `#/search/${encodeURIComponent(q)}`; };
view.addEventListener("click", (e) => { if (e.target.closest("a.title") && location.hash.startsWith("#/search/")) store.remember(input.value); });
window.onhashchange = route;
counts();
route();
ctx.rows = await loading;
loaded = true; reindex();
registerAgent(ctx);   // only now: a tool called before its data loads answers wrong, silently
route();
