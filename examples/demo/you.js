// You, as a file.
//
// WHY THIS IS HERE AND NOT IN AN APP
// ----------------------------------
// fangorn.tv is one app. There will be a music app, a games app, an xyz app,
// each with its own interface and its own tools, and none of them should own the
// person. What moves between them is the taste — and it can, because every
// corpus on this network embeds with the same model, so a vector learned
// watching films means the same thing in a catalogue of games whose publisher
// has never heard of you.
//
// WHY IT IS A DOCUMENT AND NOT A DASHBOARD
// ----------------------------------------
// This page used to be a dashboard: a PCA of 21,000 films with a dot marking
// where you sat in it, a row of counters, and an earnings figure of zero. All
// three were honest and none of them was useful. "You are here in a point cloud"
// is not a question anyone has, and it is not actionable — there is nothing you
// can do with the answer.
//
// A file is different, and the model is AGENTS.md. It has two halves. The
// derived half says what your choices look like from where the catalogues are
// standing, in the catalogues' own declared vocabulary. The authored half is a
// text box, kept verbatim, placed ABOVE the derived half and marked as
// overriding it. That ordering is the argument: what a machine inferred about
// you is an observation, and an observation you cannot answer is a profile.
//
// It is also the handoff. `exportTaste` produces 108 portable bytes that no
// human can check; this produces the same thing in a form you can read, correct,
// paste into a chat, and keep in a repo.
import { loadShard, trimView, domainManifests, configure } from "@fangorn/westmarch/shard";
import { rolesFrom, textOf } from "@fangorn/westmarch/roles";
import { importTaste } from "@fangorn/westmarch/taste";
import { tasteDoc } from "@fangorn/westmarch/taste-doc";

const $ = (id) => document.getElementById(id);
const TASTE_KEY = "westmarch.taste";
const NOTES_KEY = "westmarch.instructions";
// The same two the index opens. The vocabulary has to come from real rows —
// a term means the mean of the rows carrying it — so the document cannot be
// written without the catalogues it describes you against.
const CATALOGUES = ["/archive-films", "/games"];

// ── the taste, however it got here ──────────────────────────────────────────
function readTaste() {
    const handed = new URLSearchParams(location.search).get("taste");
    if (handed) {
        try {
            const t = importTaste(JSON.parse(atob(handed)));
            // An arriving taste is ADOPTED, not merely displayed: the person came
            // from an app carrying it, and if this page forgets it the moment the
            // query string is gone, the handoff was theatre.
            if (t) { localStorage.setItem(TASTE_KEY, atob(handed)); return t; }
        } catch { /* a stranger's base64 is not a crash */ }
    }
    try { return importTaste(JSON.parse(localStorage.getItem(TASTE_KEY) || "null")); }
    catch { return null; }
}

const held = new Map();
configure({ onManifests: (ms, v) => held.set(v, rolesFrom(ms)), rowText: (f, v) => textOf(f, held.get(v) ?? { text: [] }) });

async function catalogue(url) {
    const view = trimView(new URL(url, location.origin).toString());
    const rows = await loadShard(view);
    const roles = rolesFrom(domainManifests(view), rows);
    return { name: roles.name ?? view.split("/").filter(Boolean).pop(), rows, roles };
}

// ── the smallest markdown renderer that covers what tasteDoc writes ─────────
//
// Escaped FIRST, then marked up. The standing instructions are authored text and
// the term names come off a stranger's shard, so both reach this function as
// content and neither may reach the DOM as markup.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/_([^_\n]+)_/g, "<em>$1</em>");

function toHtml(md) {
    const out = [];
    let list = null;
    const closeList = () => { if (list) { out.push(`<ul>${list.join("")}</ul>`); list = null; } };
    for (const raw of md.split("\n")) {
        const line = raw.trimEnd();
        if (/^- /.test(line)) {
            // `- **term** — corpus · field · n rows · score` — the trailing
            // metadata is pushed right rather than run on, so a list of seven is
            // readable as a table without being one.
            const body = line.slice(2);
            const cut = body.lastIndexOf(" — ");
            (list ??= []).push(cut > 0
                ? `<li>${inline(body.slice(0, cut))}<span class="meta">${inline(body.slice(cut + 3))}</span></li>`
                : `<li>${inline(body)}</li>`);
            continue;
        }
        closeList();
        if (!line) continue;
        if (line === "---") out.push("<hr>");
        else if (line.startsWith("## ")) out.push(`<h2>${inline(line.slice(3))}</h2>`);
        else if (line.startsWith("# ")) out.push(`<h1>${inline(line.slice(2))}</h1>`);
        else if (line.startsWith("> ")) out.push(`<blockquote>${inline(line.slice(2))}</blockquote>`);
        else if (line.startsWith("_Generated")) out.push(`<div class="stamp">${inline(line)}</div>`);
        else out.push(`<p>${inline(line)}</p>`);
    }
    closeList();
    // Consecutive blockquote lines are one quote, not four.
    return out.join("\n").replace(/<\/blockquote>\n<blockquote>/g, " ");
}

// ── render ──────────────────────────────────────────────────────────────────
const t = readTaste();
let catalogues = [];
let md = "";

function paint() {
    md = tasteDoc({ t, catalogues, instructions: $("instructions").value });
    $("doc").innerHTML = toHtml(md);
    $("raw").textContent = md;
    $("size").textContent = `${new Blob([md]).size.toLocaleString()} bytes`;
}

$("instructions").value = localStorage.getItem(NOTES_KEY) ?? "";
// Repainted on every keystroke, debounced only by how cheap it is: the derived
// sections are already computed, and a person editing the authored half should
// watch it land in the document rather than press a save button.
$("instructions").addEventListener("input", () => {
    try { localStorage.setItem(NOTES_KEY, $("instructions").value); } catch { /* private window */ }
    paint();
});

$("toggle").onclick = () => {
    const showRaw = $("raw").hidden;
    $("raw").hidden = !showRaw;
    $("doc").hidden = showRaw;
    $("toggle").textContent = showRaw ? "raw" : "rendered";
    $("toggle").classList.toggle("on", showRaw);
};
$("copy").onclick = async () => {
    try { await navigator.clipboard.writeText(md); $("copy").textContent = "copied"; }
    catch { $("toggle").click(); $("copy").textContent = "select it"; }   // clipboard denied: show the text to copy by hand
    setTimeout(() => ($("copy").textContent = "copy"), 1600);
};
$("save").onclick = () => {
    const a = Object.assign(document.createElement("a"),
        { href: URL.createObjectURL(new Blob([md], { type: "text/markdown" })), download: "taste.md" });
    a.click();
    URL.revokeObjectURL(a.href);
};

// Painted once before anything is downloaded. Without a taste that is the whole
// page and it says so; with one, the authored half and the named titles are
// already true, and only the vocabulary is waiting on bytes.
paint();
$("status").textContent = t ? "reading your catalogues…" : "nothing observed yet";

if (t) {
    const got = await Promise.allSettled(CATALOGUES.map(catalogue));
    catalogues = got.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const lost = got.length - catalogues.length;
    paint();
    $("status").textContent = catalogues.length
        ? `${catalogues.map((c) => `${c.name} ${c.rows.length.toLocaleString()}`).join(" · ")}`
          + (lost ? ` · ${lost} unreachable` : "")
        // Named, not hidden: with no catalogue the document still has your
        // instructions and your titles, and it is missing exactly the half that
        // needs someone else's rows to write.
        : "no catalogue reachable — the derived sections need a publisher's rows";
}
