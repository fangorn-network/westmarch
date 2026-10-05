// A UI for data nobody wrote a UI for.
//
// MCP Apps (formerly mcp-ui) lets a tool return an HTML view alongside its JSON:
// an `EmbeddedResource` content block with a `ui://` uri, which a host renders in
// a sandboxed iframe and a host that has never heard of it ignores. `resource` is
// a standard MCP content type, so emitting one is safe on any client — the worst
// case is that the text block is shown instead, which is what happens today.
//
// The reason it is interesting HERE rather than in general: this page does not
// know what its rows are. It reads whatever a stranger baked, and `roles` is the
// publisher's own statement of which field is the title, which is the subtitle,
// which are the tags, which are the measures. That is exactly the input a table
// renderer needs. So the interface is generated per corpus at the moment of the
// call, from a declaration that shipped with the data — not designed for films
// and then reused for games.
//
// `rankedList`, `record` and `bars` are PREVIEWS — enough to decide, and then a
// link out to whoever owns the thing. `stage` is not, and the comment at its own
// definition argues the reversal: the links went to an app that does not exist,
// and the presentation belongs to whoever holds the taste.
//
// ponytail: four layouts, because the verbs return four shapes — a ranked
// list, one record, a distribution, and a queue to consume. Not a component
// library: each one is
// ASSEMBLED from the role_map at the moment of the call, so the same function
// previews a video game, a public-domain film and a restaurant differently
// because their publishers declared different things, not because anyone wrote
// three templates.

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** http(s) only. A link comes out of a row someone else published, and this HTML
 *  runs in an iframe the host trusts enough to show. `javascript:` never lands
 *  in an href from here. */
function safeHref(url) {
    try {
        const u = new URL(String(url));
        return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
    } catch { return null; }
}

const CSS = `
:root{color-scheme:light dark;--fg:#111;--dim:#6b7280;--line:#e5e7eb;--bg:#fff;--accent:#2563eb}
@media (prefers-color-scheme:dark){:root{--fg:#e5e7eb;--dim:#9ca3af;--line:#27272a;--bg:#0b0b0d;--accent:#60a5fa}}
*{box-sizing:border-box}
body{margin:0;padding:12px;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
h1{font-size:13px;margin:0 0 2px;font-weight:600}
.sub{color:var(--dim);font-size:11px;margin-bottom:10px}
ol{list-style:none;margin:0;padding:0}
li{display:grid;grid-template-columns:34px 1fr;gap:10px;padding:7px 0;border-top:1px solid var(--line)}
li:first-child{border-top:0}
.s{font-variant-numeric:tabular-nums;color:var(--dim);font-size:11px;padding-top:2px}
.s i{display:block;height:3px;background:var(--accent);border-radius:2px;margin-top:3px;opacity:.65}
.t{font-weight:600}
.t a{color:inherit;text-decoration:none;border-bottom:1px solid var(--line)}
.m{color:var(--dim);font-size:11px;margin-top:1px}
.c{display:inline-block;padding:0 5px;margin-right:6px;border:1px solid var(--line);border-radius:3px;font-size:10px;color:var(--dim)}
.x{font-size:11px;margin-top:3px}
button{font:inherit;font-size:10px;color:var(--dim);background:none;border:1px solid var(--line);border-radius:3px;padding:1px 6px;cursor:pointer}
button:hover{color:var(--fg);border-color:var(--accent)}
.empty{color:var(--dim);padding:14px 0}
/* record */
.hero{width:100%;max-height:190px;object-fit:cover;border-radius:5px;margin-bottom:10px;display:block}
.head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
h2{font-size:17px;margin:0;font-weight:650;letter-spacing:-.01em}
h2 a{color:inherit;text-decoration:none}
.stats{display:flex;gap:14px;flex-wrap:wrap;margin:10px 0}
.stat b{display:block;font-size:16px;font-weight:650;font-variant-numeric:tabular-nums}
.stat span{font-size:10px;color:var(--dim);text-transform:uppercase;letter-spacing:.06em}
.prose{margin:10px 0;line-height:1.55;max-width:62ch}
dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;margin:10px 0 0;font-size:12px}
dt{color:var(--dim)}
dd{margin:0}
.lock{color:var(--dim);border-top:1px solid var(--line);margin-top:12px;padding-top:8px;font-size:11px}
.acts{margin-top:12px;display:flex;gap:6px;flex-wrap:wrap;align-items:center}
.acts a{font:inherit;font-size:11px;color:var(--fg);background:var(--accent);border-radius:4px;padding:5px 11px;text-decoration:none;font-weight:600}
.acts a.alt{background:none;border:1px solid var(--line);color:var(--dim);font-weight:400}
/* bars */
.b{display:grid;grid-template-columns:minmax(90px,30%) 1fr 58px;gap:9px;align-items:center;padding:2px 0}
.b .k{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.b .g{background:var(--line);height:7px;border-radius:2px;overflow:hidden}
.b .g i{display:block;height:100%;background:var(--accent)}
.b .v{text-align:right;color:var(--dim);font-variant-numeric:tabular-nums}
`;

// The one place this view talks back. `tool` and `prompt` are MCP Apps' own
// intents; a host that does not implement them drops the message and the buttons
// are inert, which is why nothing here depends on a reply.
const JS = `
document.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-id]"); if (!b) return;
  if (b.dataset.act === "back") return parent.postMessage({ type: "intent", payload: { intent: "back" } }, "*");
  if (b.dataset.act === "like") { b.textContent = "♥ noted"; return parent.postMessage({ type: "tool", payload: { toolName: "note-taste", params: { like: [b.dataset.id], corpus: b.dataset.corpus || undefined } } }, "*"); }
  const msg = b.dataset.act === "similar"
    ? { type: "tool", payload: { toolName: "similar-rows", params: { id: b.dataset.id, corpus: b.dataset.corpus || undefined } } }
    : { type: "tool", payload: { toolName: "get-row", params: { id: b.dataset.id, corpus: b.dataset.corpus || undefined } } };
  parent.postMessage(msg, "*");
});
`;

/**
 * Render a ranked list the way its publisher said to.
 *
 * `hits` are what the verbs already return — `brief()` output, so title/subtitle/
 * tags are resolved and `score` is present. `roles` is consulted for the EXTRA
 * columns: measures the publisher declared, and the link field, neither of which
 * brief() flattens. Hits carrying `corpus` (a spanning call) are chipped with it.
 */
export function rankedList({ heading = "", note = "", hits = [], roles = null, link = null } = {}) {
    const top = Math.max(...hits.map((h) => Number(h.score) || 0), 0) || 1;
    const measures = (roles?.measures ?? []).slice(0, 3);
    // A ranked list has scores; a set someone MADE has an order. Same layout,
    // and the left gutter says which one you are looking at — an empty score
    // column above a curated playlist is a rank that was never computed.
    const scored = hits.some((h) => h.score != null);
    const items = hits.map((h, i) => {
        const href = safeHref(link ? h[link] : (h.url ?? h.link ?? null));
        const tags = [].concat(h.tags ?? []).filter(Boolean).slice(0, 5);
        const extra = measures.map((m) => (h[m] == null || h[m] === "" ? null : `${esc(m)} ${esc(h[m])}`)).filter(Boolean);
        const pct = Math.round((100 * (Number(h.score) || 0)) / top);
        return `<li>
      <span class="s">${scored ? `${h.score == null ? "" : Number(h.score).toFixed(3)}<i style="width:${pct}%"></i>` : `${i + 1}.`}</span>
      <div>
        <div class="t">${href ? `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${esc(h.title)}</a>` : esc(h.title)}</div>
        <div class="m">${h.corpus ? `<span class="c">${esc(h.corpus)}</span>` : ""}${[h.subtitle, ...tags].filter(Boolean).map(esc).join(" · ")}</div>
        ${extra.length ? `<div class="m">${extra.join(" · ")}</div>` : ""}
        ${h.id ? `<div class="x"><button data-act="row" data-id="${esc(h.id)}" data-corpus="${esc(h.corpus ?? "")}">open</button>
                  <button data-act="similar" data-id="${esc(h.id)}" data-corpus="${esc(h.corpus ?? "")}">more like this</button></div>` : ""}
      </div></li>`;
    }).join("");
    return `<style>${CSS}</style><h1>${esc(heading)}</h1><div class="sub">${esc(note)}</div>`
        + (items ? `<ol>${items}</ol>` : `<div class="empty">nothing matched</div>`)
        + `<script>${JS}<\/script>`;
}

/** Does this look like something an <img> can show? `media` is a declared role,
 *  not a promise of an image — places declares `googleMapsUri` as its media, and
 *  a broken <img> is worse than a link. */
const imageish = (u) => /\.(png|jpe?g|gif|webp|avif|svg)(\?|#|$)/i.test(String(u ?? ""));

/**
 * The doors out.
 *
 * This file used to mount `<video>` for an action declared `kind: "video"`, and
 * that was the moment the index started turning into a portal. A switchboard
 * does not play the film — it tells you the film exists, roughly what it is, and
 * where to go. So every resolved action becomes a LINK regardless of kind, and
 * the app on the other side owns the player, the wallet and the seventeen verbs
 * that go with it.
 *
 * `kind` is still carried through from the publisher's declaration, because the
 * app on the other side needs it and dropping data at the boundary is how the
 * next person ends up re-baking a corpus.
 */
function links(actions) {
    return actions.filter((a) => !a.locked.length && safeHref(a.href))
        .map((a, i) => `<a class="${i ? "alt" : ""}" href="${esc(safeHref(a.href))}" target="_blank" rel="noreferrer noopener">${esc(a.label)}</a>`)
        .join("");
}

const NOISE = new Set(["vector", "norm", "hasVector", "vectorDim", "text", "id", "owner", "entityType"]);

/**
 * One record, laid out by what its publisher declared.
 *
 * This is the JIT part, and the reason it is not a template engine: nothing here
 * knows what a game or a film or a restaurant is. `roles.media` decides whether
 * there is a hero image, `roles.measures` decides whether there is a stat row,
 * `roles.text` decides what the prose is, `roles.labels` decides what to call
 * any of it — all published with the data. A bundle that declared none of it
 * still renders, as a title and a field list, which is what it actually is.
 *
 * `locked` is rendered rather than hidden. A record with fields missing and no
 * sign of it is how a person concludes the data is bad instead of unpaid.
 */
export function record({ row = {}, roles = {}, corpus = null, heading = "", locked = [], price = "", back = false, actions = [] } = {}) {
    const label = (f) => esc(roles.fieldLabels?.[f] ?? f);
    const val = (v) => (Array.isArray(v) ? v.join(", ") : String(v));
    // Undeclared fields are whatever the publisher happened to ship, and one of
    // them is a 6 KB wall of scraped event listings. Prose the publisher DECLARED
    // is shown whole; a field nobody claimed was prose is clipped.
    const clip = (t) => (t.length > 320 ? `${t.slice(0, 320)}…` : t);
    const has = (f) => row[f] != null && row[f] !== "" && !(Array.isArray(row[f]) && !row[f].length);

    const title = roles.title?.find(has) ? val(row[roles.title.find(has)]) : (row.title ?? row.id ?? "untitled");
    const sub = roles.subtitle?.find(has) ? val(row[roles.subtitle.find(has)]) : null;
    const icon = roles.types?.[row.entityType]?.icon ?? "";
    const href = safeHref(row.url ?? row.link ?? null);
    const media = roles.media?.map((f) => row[f]).find(Boolean) ?? null;
    const measures = (roles.measures ?? []).filter(has);
    const tags = (roles.tags ?? []).filter(has).flatMap((f) => [].concat(row[f])).filter(Boolean).slice(0, 12);
    const prose = (roles.text ?? []).filter(has).map((f) => val(row[f]));
    const place = (roles.spatial ?? []).filter(has).map((f) => val(row[f])).join(", ");

    // Whatever is left that the publisher named — shown, but only once. A
    // detail view that repeats the title as a field reads as a dump.
    const shown = new Set([...(roles.title ?? []), ...(roles.subtitle ?? []), ...(roles.tags ?? []),
                           ...(roles.text ?? []), ...(roles.measures ?? []), ...(roles.spatial ?? []),
                           ...(roles.media ?? []), "url", "link"]);
    const rest = Object.keys(row).filter((f) => !shown.has(f) && !NOISE.has(f) && has(f));

    return `<style>${CSS}</style>
${heading ? `<div class="sub">${esc(heading)}</div>` : ""}
${media && imageish(media) ? `<img class="hero" src="${esc(safeHref(media) ?? "")}" alt="">` : ""}
<div class="head">
  <h2>${href ? `<a href="${esc(href)}" target="_blank" rel="noreferrer noopener">${icon ? `${esc(icon)} ` : ""}${esc(title)}</a>`
             : `${icon ? `${esc(icon)} ` : ""}${esc(title)}`}</h2>
  ${corpus ? `<span class="c">${esc(corpus)}</span>` : ""}
</div>
${sub || place ? `<div class="m">${[sub, place].filter(Boolean).map(esc).join(" · ")}</div>` : ""}
${measures.length ? `<div class="stats">${measures.map((f) =>
    `<span class="stat"><b>${esc(val(row[f]))}</b><span>${label(f)}</span></span>`).join("")}</div>` : ""}
${tags.length ? `<div class="m" style="margin-top:8px">${tags.map((t) => `<span class="c">${esc(t)}</span>`).join("")}</div>` : ""}
${prose.map((t) => `<p class="prose">${esc(t)}</p>`).join("")}
${rest.length ? `<dl>${rest.map((f) => `<dt>${label(f)}</dt><dd>${esc(clip(val(row[f])))}</dd>`).join("")}</dl>` : ""}
${media && !imageish(media) && safeHref(media) && safeHref(media) !== href ? `<div class="m" style="margin-top:8px"><a href="${esc(safeHref(media))}" target="_blank" rel="noreferrer noopener">${esc(label(roles.media.find((f) => row[f] === media)))}</a></div>` : ""}
${(() => {
    // What you cannot have yet, named. Ranking is complete on the free tier —
    // this row is in the right place — so the only thing missing is fields, and
    // saying which ones is the difference between a purchase and a refund.
    const shut = actions.filter((a) => a.locked.length);
    const fields = [...new Set([...locked, ...shut.flatMap((a) => a.locked)])];
    if (!fields.length) return "";
    return `<div class="lock">${shut.length ? `${shut.map((a) => esc(a.label)).join(", ")} and ` : ""}`
        + `${fields.length} field${fields.length === 1 ? "" : "s"} withheld by the publisher${price ? ` · ${esc(price)}` : ""}`
        + ` — ${fields.slice(0, 6).map(esc).join(", ")}${fields.length > 6 ? " …" : ""}</div>`;
})()}
<div class="acts">
  ${links(actions)}
  ${row.id ? `<button data-act="like" data-id="${esc(row.id)}" data-corpus="${esc(corpus ?? "")}">♥ more of this</button>` : ""}
  ${row.id ? `<button data-act="similar" data-id="${esc(row.id)}" data-corpus="${esc(corpus ?? "")}">similar</button>` : ""}
  ${back ? `<button data-act="back" data-id="">← results</button>` : ""}
</div>
<script>${JS}<\/script>`;
}

/**
 * A distribution: field coverage, facet counts, collection sizes. One shape, so
 * one layout — `[{ label, count }]` with bars relative to the largest.
 */
export function bars({ heading = "", note = "", items = [], suffix = "" } = {}) {
    const top = Math.max(...items.map((i) => Number(i.count) || 0), 1);
    return `<style>${CSS}</style><h1>${esc(heading)}</h1><div class="sub">${esc(note)}</div>`
        + (items.length
            ? items.map((i) => `<div class="b"><span class="k">${esc(i.label)}</span>`
                + `<span class="g"><i style="width:${Math.round((100 * (Number(i.count) || 0)) / top)}%"></i></span>`
                + `<span class="v">${esc(Number(i.count).toLocaleString())}${esc(suffix)}</span></div>`).join("")
            : `<div class="empty">nothing to count</div>`);
}

/**
 * Wrap HTML as the content block a host renders.
 *
 * `ui://` is what marks it as a view rather than an attachment, and the uri is
 * per call — the same tool called twice is two views, and a host that caches by
 * uri would otherwise show the first one forever.
 */
let seq = 0;
export const uiResource = (html, name = "view") => ({
    type: "resource",
    resource: { uri: `ui://westmarch/${name}/${++seq}`, mimeType: "text/html", text: html },
});


// ── the stage ───────────────────────────────────────────────────────────────
//
// The three exports above DESCRIBE rows. This one plays them, and that is a
// reversal of a rule this file used to hold.
//
// The rule was: the index is a switchboard, an app owns the player, so a record
// here shows you enough to decide and hands you a link. It was the right rule
// while there was an app on the other end of the link. There is not. `launch`
// points at `http://localhost:5173`, which is nobody's television, and every
// hand-off ends at a page whose only advantage over this one is that somebody
// wrote a player for exactly one content type.
//
// So the presentation moves here, and the argument for it is the same argument
// as everywhere else in this library: nothing here knows what a film is. A row
// is playable because the publisher declared a `media` role and the row carries
// a `mime` — the same two facts an agent reads. `shapeOf` is the whole of the
// content-type half, five branches, and a publisher who ships audio gets an
// audio player without telling anyone.
//
// The other half is order. The queue arrives ranked by the taste kernel and is
// re-ranked in place as you use it: finishing something counts as a like,
// skipping counts against, and the host pushes the new order back into this
// frame WITHOUT touching the stage — which is why the media keeps playing while
// the list under it moves. That visible movement is the product. It is the only
// screen in the system where a person can watch their own preferences act on
// something.

const MEDIA_EXT = {
    video: ["mp4", "ogv", "webm", "m4v", "mov", "mkv"],
    audio: ["mp3", "ogg", "oga", "flac", "wav", "m4a", "opus", "aac"],
    image: ["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"],
};

/** The publisher's own media field, resolved to something an element can load.
 *  `roles.media` is a declaration, not a promise — places declares a Google Maps
 *  link as its media — so the caller still has to ask what SHAPE came back. */
function sourceOf(row, roles = {}) {
    for (const f of roles.media ?? []) {
        const u = safeHref(row?.[f]);
        if (u) return u;
    }
    return safeHref(row?.url ?? row?.link ?? null);
}

/**
 * What kind of thing is this, as far as presenting it goes.
 *
 * From the row and the role_map only. No corpus is named anywhere in here: the
 * archive bundle gets a video player because its rows say `video/mp4`, not
 * because anyone wrote a branch for archive.org, and the first publisher to bake
 * a podcast gets an audio player on the day they bake it.
 *
 * `mime` wins over the extension — `.ogg` is audio and `video/ogg` is not — and
 * a row with neither falls through to the two shapes that need no media at all.
 */
export function shapeOf(row, roles = {}) {
    const mime = String(row?.mime ?? row?.contentType ?? "");
    const src = sourceOf(row, roles);
    const ext = src ? (src.split(/[?#]/)[0].split(".").pop() ?? "").toLowerCase() : "";
    for (const kind of ["video", "audio", "image"]) {
        if (mime.startsWith(`${kind}/`) || (!mime && MEDIA_EXT[kind].includes(ext))) return kind;
    }
    if (row?.coordinates || (roles.spatial ?? []).some((f) => row?.[f])) return "place";
    return "read";
}

const GLYPH = { video: "▶", audio: "♪", image: "▣", place: "⌖", read: "¶" };

/** Why this is on screen when what matched was something else. Naming the corpus
 *  that scored is not a footnote: a person who typed a line of dialogue and got
 *  a film has to be able to tell that the film is the ANSWER and not a guess. */
function viaLine(via) {
    const at = Number(via.at);
    const when = Number.isFinite(at) && at > 0
        ? ` at ${Math.floor(at / 60)}:${String(Math.floor(at % 60)).padStart(2, "0")}`
        : "";
    const more = via.also ? ` · ${via.also + 1} passages matched` : "";
    return `found by ${via.corpus ?? "a passage"}${when}${more}`;
}

/** Seconds as a publisher happens to have written them. A measure called
 *  `duration` is 399 in one bundle and "6:39" in another; only the first is
 *  worth reformatting, and the second is already what we would produce. */
const clock = (v) => {
    const s = Number(v);
    if (!Number.isFinite(s) || s <= 0) return null;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = Math.round(s % 60);
    return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
};

const STAGE_CSS = `
#stage{margin:0 0 14px}
.player{width:100%;max-height:56vh;background:#000;border-radius:6px;display:block}
audio.player{max-height:none;height:44px;background:none}
.cover{width:100%;max-height:34vh;object-fit:cover;border-radius:6px;display:block;margin-bottom:9px}
.why{color:var(--dim);font-size:11px;margin-top:8px}
.via{color:var(--dim);font-size:11px;margin-top:6px;border-left:2px solid var(--accent);padding-left:9px}
.via q{display:block;color:var(--fg);font-style:italic;margin-top:3px;quotes:none;max-width:60ch}
.acts button{font-size:12px;padding:5px 12px}
.acts button.key{border-color:var(--accent);color:var(--fg)}
.qhead{color:var(--dim);font-size:10px;letter-spacing:.08em;text-transform:uppercase;border-top:1px solid var(--line);padding-top:9px;margin-top:16px}
#queue li{grid-template-columns:16px 1fr auto;cursor:pointer;align-items:baseline}
#queue li:hover .t{color:var(--accent)}
#queue .g{color:var(--dim);font-size:11px}
#queue .d{color:var(--dim);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.moved{animation:flash 1.2s ease-out}
@keyframes flash{from{background:color-mix(in srgb,var(--accent) 18%,transparent)}to{background:transparent}}
`;

// The frame drives itself. Everything below runs with no host attached — the
// queue advances, the media plays, `ended` moves on — and a host that IS
// attached gets told about every like and skip and may push a new order back.
// Splitting `drawStage` from `drawQueue` is the whole reason that push is
// possible: re-rendering the document to reorder a list would restart the film.
const STAGE_JS = `
let ITEMS = window.__ITEMS__, i = 0;
const $s = document.getElementById("stage"), $q = document.getElementById("queue"), $qn = document.getElementById("qnote");
const send = (m) => parent.postMessage(m, "*");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
const taste = (act, it) => it && send({ type:"tool", payload:{ toolName:"note-taste", params:{ [act]:[it.id], corpus: it.corpus || undefined } } });

function drawStage() {
  const it = ITEMS[i];
  if (!it) { $s.innerHTML = '<div class="empty">queue finished — ask something else, or let the taste pick again</div>'; return drawQueue(); }
  $s.innerHTML = it.html;
  const m = $s.querySelector("video,audio");
  // Watched to the end is the strongest signal this surface can collect, and it
  // costs the person nothing to give. Skipping is the other half of it.
  if (m) m.addEventListener("ended", () => { taste("like", it); next(); }, { once: true });
  drawQueue();
}
function drawQueue(flash) {
  const rest = ITEMS.slice(i + 1);
  $qn.textContent = rest.length ? rest.length + " queued" : "";
  $q.innerHTML = rest.length ? rest.map((q, n) =>
    '<li data-act="jump" data-n="' + n + '"><span class="g">' + esc(q.glyph) + '</span>'
    + '<div><div class="t">' + esc(q.title) + '</div><div class="m">'
    + (q.corpus ? '<span class="c">' + esc(q.corpus) + '</span>' : "") + esc(q.why ?? "") + '</div></div>'
    + '<span class="d">' + esc(q.length ?? "") + '</span></li>').join("")
    : '<li class="empty">nothing else queued</li>';
  if (flash) for (const li of $q.children) li.classList.add("moved");
}
function next() { i++; drawStage(); }

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-act]"); if (!el) return;
  const it = ITEMS[i], act = el.dataset.act;
  if (act === "like")    { el.textContent = "♥ noted"; return taste("like", it); }
  if (act === "skip")    { taste("dislike", it); return next(); }
  if (act === "next")    { return next(); }
  if (act === "jump")    { i += 1 + Number(el.dataset.n); return drawStage(); }
  if (act === "similar") { return it && send({ type:"tool", payload:{ toolName:"similar-rows", params:{ id: it.id, corpus: it.corpus || undefined } } }); }
});

// The host answering a like or a skip with a new order. Only the queue is
// redrawn; the stage — and whatever is playing in it — is left alone.
addEventListener("message", (e) => {
  if (e.data?.type !== "queue") return;
  const seen = new Set(ITEMS.slice(0, i + 1).map((p) => p.id));
  ITEMS = [...ITEMS.slice(0, i + 1), ...(e.data.payload?.items ?? []).filter((r) => !seen.has(r.id))];
  drawQueue(true);
});

drawStage();
`;

/** One item, laid out for its shape. Everything it needs comes from the roles
 *  the publisher declared plus the row itself, which is why a corpus nobody
 *  wrote code for still lands on a page rather than a link. */
function stageItem(row, roles = {}, corpus = null, via = null) {
    const has = (f) => row[f] != null && row[f] !== "" && !(Array.isArray(row[f]) && !row[f].length);
    const val = (v) => (Array.isArray(v) ? v.join(", ") : String(v));
    const shape = shapeOf(row, roles);
    const src = sourceOf(row, roles);
    const title = roles.title?.find(has) ? val(row[roles.title.find(has)]) : (row.title ?? row.id ?? "untitled");
    const sub = roles.subtitle?.find(has) ? val(row[roles.subtitle.find(has)]) : null;
    const icon = roles.types?.[row.entityType]?.icon ?? "";
    const place = (roles.spatial ?? []).filter(has).map((f) => val(row[f])).join(", ");
    const tags = (roles.tags ?? []).filter(has).flatMap((f) => [].concat(row[f])).filter(Boolean).slice(0, 8);
    const prose = (roles.text ?? []).filter(has).map((f) => val(row[f])).join(" ").slice(0, 700);
    const poster = safeHref(row.thumb ?? row.imageUrl ?? row.image ?? null);
    const length = clock((roles.measures ?? []).map((f) => row[f]).find((v) => Number(v) > 0) ?? row.duration);
    const out = safeHref(row.url ?? row.link ?? null);

    // A media fragment, when a subtitle brought us here and its publisher gave
    // the timecode away. `#t=` is what makes "search what was said, arrive at
    // what was filmed" land on the SECOND rather than on the film — and it costs
    // nothing: the range request the player already makes just starts later.
    const seek = Number(via?.at);
    const play = src && Number.isFinite(seek) && seek > 0 ? `${src}#t=${Math.floor(seek)}` : src;

    const media =
        shape === "video" && src ? `<video class="player" controls preload="metadata"${poster ? ` poster="${esc(poster)}"` : ""} src="${esc(play)}"></video>`
        : shape === "audio" && src ? `${poster ? `<img class="cover" src="${esc(poster)}" alt="">` : ""}<audio class="player" controls preload="metadata" src="${esc(play)}"></audio>`
        : shape === "image" && src ? `<img class="cover" style="max-height:52vh" src="${esc(src)}" alt="">`
        : poster ? `<img class="cover" src="${esc(poster)}" alt="">`
        : "";

    return { shape, title, length, html: `${media}
<div class="head"><h2>${icon ? `${esc(icon)} ` : ""}${esc(title)}</h2>${corpus ? `<span class="c">${esc(corpus)}</span>` : ""}</div>
${sub || place || length ? `<div class="m">${[sub, place, length].filter(Boolean).map(esc).join(" · ")}</div>` : ""}
${via ? `<div class="via">${esc(viaLine(via))}${via.line ? `<q>${esc(via.line)}</q>` : ""}</div>` : ""}
${tags.length ? `<div class="m" style="margin-top:6px">${tags.map((t) => `<span class="c">${esc(t)}</span>`).join("")}</div>` : ""}
${prose ? `<p class="prose">${esc(prose)}</p>` : ""}
<div class="acts">
  <button class="key" data-act="like">♥ more of this</button>
  <button data-act="skip">✕ not this</button>
  <button data-act="next">skip ⏭</button>
  <button data-act="similar">similar</button>
  ${out ? `<a class="alt" href="${esc(out)}" target="_blank" rel="noreferrer noopener">source</a>` : ""}
</div>` };
}

/**
 * A queue, presented.
 *
 * `picks` is `[{ row, roles, corpus, why }]` — rows rather than briefs, because
 * `brief()` resolves the publisher's LINK and a player needs their FILE, and the
 * two are different fields on the same row. Mixed corpora are the interesting
 * case and are handled by each pick carrying its own roles: a film, then a place,
 * then a game, ordered by one taste and rendered by three publishers' own
 * declarations.
 */
export function stageItems(picks = []) {
    return picks.map(({ row, roles = {}, corpus = null, why = "", via = null }) => {
        const it = stageItem(row, roles, corpus, via);
        return { id: row.id, corpus, why, title: it.title, glyph: GLYPH[it.shape] ?? "·", length: it.length, html: it.html };
    });
}

export function stage({ picks = [], heading = "", note = "" } = {}) {
    const items = stageItems(picks);
    // `</script>` inside a row someone else published would end this script tag.
    const json = JSON.stringify(items).replace(/</g, "\\u003c");
    return `<style>${CSS}${STAGE_CSS}</style>
<h1>${esc(heading)}</h1><div class="sub">${esc(note)}</div>
<div id="stage"></div>
<div class="qhead">up next <span id="qnote"></span></div>
<ol id="queue"></ol>
<script>window.__ITEMS__ = ${json};${STAGE_JS}<\/script>`;
}

// ── self-check: `node src/agent/ui.js` ────────────────────────────────────────
if (typeof process !== "undefined" && import.meta.url === `file://${process.argv[1]}` && process.argv[1].endsWith("/ui.js")) {
    const roles = { measures: ["rating", "year", "runtime", "votes"] };
    const html = rankedList({
        heading: 'search "frozen"', note: "2 corpora",
        roles,
        hits: [
            { id: "g1", corpus: "games", title: "Frostpunk", subtitle: "2018", tags: ["survival", "strategy"], score: 0.663, rating: 9, url: "https://en.wikipedia.org/wiki/Frostpunk" },
            { id: "f1", corpus: "archive-films", title: "<script>alert(1)</script>", subtitle: null, tags: [], score: 0.4, url: "javascript:alert(1)" },
        ],
    });

    // The trust boundary: titles and links come from a stranger's shard.
    if (html.includes("<script>alert(1)")) throw new Error("a row title must not reach the DOM unescaped");
    if (html.includes("javascript:alert")) throw new Error("a javascript: url must never become an href");
    if (!html.includes('href="https://en.wikipedia.org/wiki/Frostpunk"')) throw new Error("an http link must survive");

    // Role-driven, not hardcoded: `rating` is declared and present, so it shows;
    // `runtime` is declared and absent, so it does not become an empty column.
    if (!html.includes("rating 9")) throw new Error("a declared measure present on the row must render");
    if (html.includes("runtime")) throw new Error("a declared measure absent from every row must not render");
    // …and a corpus that declares no measures renders the same list with no extras.
    const bare = rankedList({ hits: [{ id: "x", title: "T", score: 1 }] });
    if (bare.slice(bare.indexOf("<ol>"), bare.indexOf("</ol>")).includes("undefined")) throw new Error("no roles must not leak undefined into a row");

    // A spanning call chips each hit with where it came from.
    if (!html.includes(">games<") || !html.includes(">archive-films<")) throw new Error("a merged hit must name its corpus");

    // Empty is a rendered state, not a blank page.
    if (!rankedList({ heading: "x", hits: [] }).includes("nothing matched")) throw new Error("no hits must still render something");

    const a = uiResource(html, "search"), b = uiResource(html, "search");
    if (a.resource.uri === b.resource.uri) throw new Error("two calls must not share a uri, or a host caches the first view forever");
    if (a.type !== "resource" || a.resource.mimeType !== "text/html") throw new Error("must be an MCP EmbeddedResource");
    if (!a.resource.uri.startsWith("ui://")) throw new Error("ui:// is what marks it renderable");

    // A curated set is numbered, not scored.
    {
        const made = rankedList({ heading: "playlist", hits: [{ title: "one" }, { title: "two" }] });
        if (!made.includes(">1.<") || !made.includes(">2.<")) throw new Error("an unscored list must number its rows");
        if (made.includes("width:0%")) throw new Error("…and must not draw an empty score bar");
        const ranked = rankedList({ heading: "search", hits: [{ title: "one", score: 0.5 }] });
        if (!ranked.includes("0.500")) throw new Error("a ranked list still shows its scores");
    }

    // ── record: the layout is the publisher's declaration, not a template ───
    const gameRoles = { title: ["title"], subtitle: ["year"], text: ["desc"], tags: ["genre"],
                        measures: [], media: ["thumb"], spatial: [], types: { Game: { icon: "🎮" } },
                        fieldLabels: { platform: "Plays on" } };
    const placeRoles = { title: ["title"], subtitle: ["primaryType"], text: ["editorialSummary"],
                         tags: ["categories"], measures: ["rating", "userRatingCount"], media: ["googleMapsUri"],
                         spatial: ["locality"], types: {}, fieldLabels: { rating: "Rating" } };

    let r = record({
        row: { id: "Frostpunk", entityType: "Game", title: "Frostpunk", year: "2018", desc: "A city-building survival game.",
               genre: ["survival", "strategy"], platform: ["windows"], thumb: "https://x.test/f.jpg",
               url: "https://en.wikipedia.org/wiki/Frostpunk", vector: [1, 2], norm: 1 },
        roles: gameRoles, corpus: "games", back: true,
    });
    if (!r.includes('class="hero" src="https://x.test/f.jpg"')) throw new Error("a declared image media must be the hero");
    if (!r.includes("🎮 Frostpunk")) throw new Error("the publisher's own icon must be used");
    if (!r.includes("A city-building survival game.")) throw new Error("the declared text role is the prose");
    if (!r.includes("<dt>Plays on</dt>")) throw new Error("undeclared-but-named fields use the publisher's label");
    if (r.includes("vector") || r.includes("norm</dt>")) throw new Error("internals must never render as fields");
    if ((r.match(/Frostpunk<\/a>|>Frostpunk</g) ?? []).length > 1) throw new Error("the title must not repeat as a field");
    if (!r.includes("← results")) throw new Error("back must be offered when the caller asked for it");
    if (!r.includes('class="stats"') === false) throw new Error("a corpus with no measures must draw no stat row");

    // The SAME function, a publisher that declared other things. No branch here
    // knows what a restaurant is.
    r = record({
        row: { id: "p1", title: "The Wharf", primaryType: "Bar", locality: "Eagle River, WI",
               rating: "4.7", userRatingCount: "218", categories: ["bar", "grill"],
               editorialSummary: "Lakeside bar.", googleMapsUri: "https://maps.test/p1" },
        roles: placeRoles, corpus: "places", locked: ["phone", "website"], price: "0.05 USDC",
    });
    if (r.includes("<img")) throw new Error("a media role that is not an image must not become a broken <img>");
    if (!r.includes('href="https://maps.test/p1"')) throw new Error("…it must still be reachable as a link");
    if (!r.includes("<b>4.7</b>") || !r.includes("<span>Rating</span>")) throw new Error("declared measures render as stats with their label");
    if (!r.includes("2 fields withheld") || !r.includes("0.05 USDC")) throw new Error("withheld fields must be named and priced, not hidden");
    if (r.includes("← results")) throw new Error("back must not appear unasked");

    // A bundle that declared nothing still renders.
    r = record({ row: { id: "x", name: "loose row", n: 3 }, roles: {} });
    if (!r.includes("loose row") && !r.includes("untitled")) throw new Error("an undeclared row must still render");

    // ── the doors out, not the thing itself ─────────────────────────────────
    r = record({
        row: { id: "f1", title: "The Temp" }, roles: { title: ["title"] }, price: "0.05 USDC",
        actions: [
            { kind: "video", label: "Play", href: "https://cdn.test/a.mp4", locked: [], missing: [] },
            { kind: "link", label: "On archive.org", href: "https://archive.org/details/x", locked: [], missing: [] },
        ],
    });
    if (r.includes("<video")) throw new Error("a preview must not mount a player — that is the app's job");
    if (!r.includes('href="https://cdn.test/a.mp4"') || !r.includes(">Play<")) throw new Error("…it must still be a door to it");
    if (!r.includes('href="https://archive.org/details/x"')) throw new Error("a declared link action must be a button");
    if (!r.includes("♥ more of this")) throw new Error("a record must be able to teach the taste");

    // What you cannot have yet is NAMED. Ranking is complete on the free tier,
    // so the only question left is what a purchase would actually get you.
    r = record({
        row: { id: "f1", title: "The Temp" }, roles: { title: ["title"] }, price: "0.05 USDC",
        actions: [{ kind: "video", label: "Play", href: "https://cdn.test/", locked: ["path"], missing: [] }],
    });
    if (r.includes('href="https://cdn.test/"')) throw new Error("a locked action must not render a door that does not open");
    if (!r.includes("0.05 USDC") || !r.includes("path") || !r.includes("Play")) {
        throw new Error("a withheld action must name itself, its fields and its price");
    }

    // A hostile action url is still just a url.
    r = record({ row: { id: "x", title: "T" }, roles: { title: ["title"] },
                 actions: [{ kind: "link", label: "P", href: "javascript:alert(1)", locked: [], missing: [] }] });
    if (r.includes("javascript:")) throw new Error("an action url gets the same gate as every other url");

    // An undeclared field holding 6 KB of scraped text must not become the page.
    r = record({ row: { id: "g", title: "T", blob: "x".repeat(5000) }, roles: { title: ["title"] } });
    if (!r.includes("…") || r.length > 6000) throw new Error(`an undeclared field must be clipped: ${r.length}`);

    // A publisher whose media role IS the link the title already carries must
    // not print the same url twice under a field name.
    r = record({ row: { id: "g", title: "T", url: "https://x.test/a", link2: null }, roles: { title: ["title"], media: ["url"] } });
    if ((r.match(/https:\/\/x\.test\/a/g) ?? []).length !== 1) throw new Error("the media link must not repeat the title's href");

    // Hostile input, same gate as the list.
    r = record({ row: { id: "x", title: "<img onerror=alert(1)>", url: "javascript:alert(1)", thumb: "javascript:x.png" }, roles: { title: ["title"], media: ["thumb"] } });
    if (r.includes("<img onerror")) throw new Error("a hostile title must be escaped");
    if (r.includes("javascript:")) throw new Error("javascript: must never reach an href or a src");

    // ── bars ────────────────────────────────────────────────────────────────
    const bb = bars({ heading: "genre", items: [{ label: "indie", count: 2485 }, { label: "action", count: 843 }] });
    if (!bb.includes("2,485")) throw new Error("counts must be grouped for reading");
    if (!bb.includes('style="width:100%"')) throw new Error("the largest bar is full width");
    if (!bb.includes('style="width:34%"')) throw new Error(`bars are relative to the largest: ${bb.match(/width:\d+%/g)}`);
    if (!bars({ items: [] }).includes("nothing to count")) throw new Error("an empty distribution must say so");

    // ── the stage: shape from the row, order from the taste ─────────────────
    const filmRoles = { title: ["name"], subtitle: ["creator"], text: ["desc"], tags: ["subject"],
                        measures: ["duration", "size"], media: ["url"], spatial: ["country"], types: { video: { icon: "🎞" } } };
    const film = { id: "f1", entityType: "video", name: "The Temp", creator: "Lieberman Bros.", mime: "video/ogg",
                   url: "https://archive.org/download/x/x.ogv", thumb: "https://archive.org/services/img/x",
                   desc: "Superman gets injured.", subject: ["lego"], duration: 399,
                   identifier: "x", vector: [1, 2] };

    // Content type comes off the row, never off the corpus name.
    if (shapeOf(film, filmRoles) !== "video") throw new Error("a video/* mime is a video");
    if (shapeOf({ url: "https://x.test/a.ogv" }, { media: ["url"] }) !== "video") throw new Error("…and an extension alone is enough");
    if (shapeOf({ mime: "video/ogg", url: "https://x.test/a.ogg" }, { media: ["url"] }) !== "video") throw new Error("mime must beat the extension: .ogg is audio, video/ogg is not");
    if (shapeOf({ mime: "audio/mpeg", url: "https://x.test/a.mp3" }, { media: ["url"] }) !== "audio") throw new Error("an audio publisher gets an audio player without asking");
    if (shapeOf({ googleMapsUri: "https://maps.test/p", locality: "Eagle River" }, placeRoles) !== "place") throw new Error("a maps link is not media — a row with a place is a place");
    if (shapeOf({ title: "T", desc: "words" }, { title: ["title"], text: ["desc"] }) !== "read") throw new Error("a row with no media at all still has a shape");

    let st = stage({ heading: "for you", note: "1 corpus",
                     picks: [{ row: film, roles: filmRoles, corpus: "archive-films", why: "0.71 · your taste" }] });

    // The reversal, asserted: the stage mounts the publisher's FILE. `record`
    // would have linked to `presentation.externalUrl` — the details page — and a
    // player cannot play that.
    if (!st.includes("https://archive.org/download/x/x.ogv")) throw new Error("the stage plays the media role, not the link role");
    if (!st.includes("poster=")) throw new Error("a thumb the publisher shipped is the poster");
    if (!st.includes("6:39")) throw new Error("a duration measure in seconds must be readable as a clock");
    if (!st.includes("🎞 The Temp")) throw new Error("the publisher's own icon still wins");

    // The whole point of splitting the two draws: a re-rank arriving mid-play
    // must not touch the element that is playing.
    if (!st.includes('e.data?.type !== "queue"')) throw new Error("the frame must accept a re-ranked queue from the host");
    const handler = st.match(/type !== "queue"[\s\S]*?drawQueue\(true\)/)?.[0];
    if (!handler) throw new Error("a queue push must end in a queue redraw");
    if (handler.includes("drawStage(")) throw new Error("a queue push must redraw the queue only — redrawing the stage restarts the film");
    if (!st.includes('toolName:"note-taste"') && !st.includes('toolName: "note-taste"')) throw new Error("likes and skips must reach the host as the same verb an agent calls");

    // ── arriving at a moment, from a line ───────────────────────────────────
    // The subtitle corpus scores; the film plays. What must survive the swap is
    // the evidence: which corpus matched, where in the film, and — when its
    // publisher gives the words away — the words.
    st = stage({ picks: [{
        row: film, roles: filmRoles, corpus: "archive-films",
        via: { corpus: "archive-dialogue", at: 41.5, also: 2, line: "we are cut off, and the wire is dead" },
    }] });
    if (!st.includes("x.ogv#t=41")) throw new Error("a timecode the publisher gave away must reach the player as a media fragment");
    if (!st.includes("found by archive-dialogue at 0:41")) throw new Error("a person handed a film for a line they typed must be told why");
    if (!st.includes("3 passages matched")) throw new Error("the other lines into the same film are the evidence, not noise");
    if (!st.includes("we are cut off")) throw new Error("a free line must be quoted — it is the thing that matched");

    // …and the archive bundle as it actually ships today, which sells `start`.
    // No timecode is not a reason to withhold the film, and it is not a reason
    // to invent second zero either.
    st = stage({ picks: [{ row: film, roles: filmRoles, corpus: "archive-films", via: { corpus: "archive-dialogue", at: null } }] });
    if (st.includes("#t=")) throw new Error("a withheld timecode must not become a fabricated one");
    if (!st.includes("https://archive.org/download/x/x.ogv")) throw new Error("…the film still plays");
    if (!st.includes("found by archive-dialogue")) throw new Error("…and still says what found it");
    if (/found by archive-dialogue at/.test(st)) throw new Error("…without claiming a moment nobody paid for");

    // Mixed corpora, each rendered by its own publisher's declaration. This is
    // the case that has no ad-tech equivalent and it must not need a branch.
    st = stage({ picks: [
        { row: film, roles: filmRoles, corpus: "archive-films" },
        { row: { id: "p1", title: "The Wharf", primaryType: "Bar", locality: "Eagle River, WI", rating: "4.7",
                 categories: ["bar"], editorialSummary: "Lakeside bar.", googleMapsUri: "https://maps.test/p1" },
          roles: placeRoles, corpus: "places" },
    ] });
    if (!st.includes("The Wharf") || !st.includes("The Temp")) throw new Error("one queue must carry two publishers");
    if (!st.includes("\\u2318") && !st.includes("⌖")) throw new Error("the queue must say what shape each item is");

    // Same trust boundary as everywhere else, plus one that is specific to
    // shipping rows inside a <script>.
    st = stage({ picks: [{ row: { id: "x", name: "</script><script>alert(1)</script>", mime: "video/mp4",
                                  url: "javascript:alert(1)", thumb: "javascript:x.png" }, roles: filmRoles }] });
    if (st.includes("</script><script>")) throw new Error("a title must not be able to close the tag its own JSON ships in");
    if (st.includes("javascript:")) throw new Error("javascript: must never become a src, a poster or an href");
    if (!stage({ picks: [] }).includes("queue")) throw new Error("an empty queue must still render a surface");

    console.log("ui.js self-check ok — list/record/bars all assembled from the publisher's role_map, one record function "
        + "lays out a game and a restaurant differently, withheld fields named not hidden, internals never rendered, "
        + "declared actions become doors out and never a player, a withheld one names its price instead, "
        + "hostile titles and urls neutralised, unique ui:// per call; the stage plays the media role by a shape read "
        + "off the row, mixes publishers in one queue, seeks to the moment a matched line names without inventing one when the timecode is withheld, and takes a re-ranked queue without restarting what is playing");
}
