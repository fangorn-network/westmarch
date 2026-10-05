// What a person does on the page, kept on their own device: what they saved, what they
// passed on, and what they searched this session. Nothing leaves the browser unless they
// export it. The saved items are also the likes a taste is built from (src/taste/taste.js),
// so "For you" is theirs, and so is the file they can hand an agent.
//
// Saved items are snapshots keyed by the publisher's own id (the identity role), not the
// row's CID: a record re-published with a new CID must still be the item they saved.
import { exportTaste, taste } from "../src/taste/taste.js";
import { packVec, unpackVec } from "../src/core/embed.js";

const read = (s, k, dflt) => { try { return JSON.parse(s?.getItem(k) ?? "null") ?? dflt; } catch { return dflt; } };
const write = (s, k, v) => { try { s?.setItem(k, JSON.stringify(v)); } catch { /* private mode or full: the page still works */ } };

/** `local` keeps saved items across visits, `session` keeps this visit's searches. */
export function createStore({ local, session, app = "app" } = {}) {
    const K = { saved: `${app}:saved`, passed: `${app}:passed`, history: `${app}:history` };
    return {
        saved: () => read(local, K.saved, []),
        passed: () => read(local, K.passed, []),
        history: () => read(session, K.history, []),
        isSaved(key) { return this.saved().some((s) => s.key === key); },
        toggleSave(item) {
            const all = this.saved(), at = all.findIndex((s) => s.key === item.key);
            if (at >= 0) all.splice(at, 1); else all.push({ ...item, savedAt: new Date().toISOString() });
            write(local, K.saved, all);
            write(local, K.passed, this.passed().filter((p) => p.key !== item.key));
            return at < 0;
        },
        pass(item) {
            write(local, K.passed, [...this.passed().filter((p) => p.key !== item.key), item].slice(-50));
            write(local, K.saved, this.saved().filter((s) => s.key !== item.key));
        },
        /** Neither liked nor passed on: the vote cleared. */
        unvote(key) {
            write(local, K.saved, this.saved().filter((s) => s.key !== key));
            write(local, K.passed, this.passed().filter((p) => p.key !== key));
        },
        remember(query) {
            const q = query.trim();
            if (!q) return;
            write(session, K.history, [{ q, at: new Date().toISOString() }, ...this.history().filter((h) => h.q !== q)].slice(0, 50));
        },
        clear(which) { write(which === "history" ? session : local, K[which], []); },
        /** Likes (saved) and dislikes (passed), newest last, as the kernel takes them. */
        votes() {
            const vec = (x) => ({ id: x.key, title: x.title, vector: x.v ? unpackVec(x.v) : null });
            return { likes: this.saved().map(vec), dislikes: this.passed().map(vec) };
        },
        /** The taste these choices make, or null before the first like. */
        taste() { const { likes, dislikes } = this.votes(); return taste(likes, dislikes); },
        /** Everything, for the person to keep or hand to an agent. */
        bundle({ name = app, url = "" } = {}) {
            const strip = ({ v, ...x }) => x;
            return { app: name, url, exported: new Date().toISOString(), saved: this.saved().map(strip),
                     searches: this.history(), taste: exportTaste(this.taste()) };
        },
    };
}

/** A saved-item snapshot of a row: enough to list it, link it and rank by it later. */
export const snapshot = (r, { key, title, subtitle, place, date, link, detail }) => ({
    key, title, subtitle, place, date, url: link ?? null, detail: detail ?? "", ...(r.vector ? { v: packVec(Array.from(r.vector)) } : {}),
});

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
export const toCSV = (items) => ["title,place,subtitle,date,url,detail", ...items.map((i) =>
    [i.title, i.place, i.subtitle, i.date, i.url, i.detail].map(csvCell).join(","))].join("\n");
export const toMarkdown = (items, name = "Saved") => [`# ${name}`, "", ...items.map((i) =>
    `- **${i.url ? `[${i.title}](${i.url})` : i.title}** — ${[i.place, i.subtitle].filter(Boolean).join(" · ")}${i.detail ? `\n  ${i.detail}` : ""}`)].join("\n");

// ── self-check: `node site/store.js` ──
if (typeof process !== "undefined" && process.argv[1]?.endsWith("/store.js")) {
    const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v) }; };
    const s = createStore({ local: mem(), session: mem(), app: "t" });
    const row = (i) => ({ vector: Array.from({ length: 8 }, (_, j) => (j === i ? 1 : 0.1)) });
    const a = snapshot(row(0), { key: "a", title: "Budget", place: "X", date: "2026-01-01" });
    const b = snapshot(row(1), { key: "b", title: "Roads, \"east\"", place: "Y" });
    const eq = (x, y, m) => { if (JSON.stringify(x) !== JSON.stringify(y)) throw new Error(`${m}: ${JSON.stringify(x)}`); };
    eq(s.taste(), null, "no taste before a save");
    s.toggleSave(a); s.toggleSave(b);
    eq(s.saved().map((x) => x.key), ["a", "b"], "saved in order");
    if (!s.taste()?.q) throw new Error("saves make a taste");
    s.pass(b);
    eq([s.saved().map((x) => x.key), s.passed().map((x) => x.key)], [["a"], ["b"]], "passing on an item unsaves it");
    eq(s.taste().rejected, ["Roads, \"east\""], "and it steers the taste away");
    s.remember("snow"); s.remember("budget"); s.remember("snow");
    eq(s.history().map((h) => h.q), ["snow", "budget"], "history: newest first, no repeats");
    const out = s.bundle({ name: "T" });
    if (out.saved[0].v || !out.taste?.q || out.searches.length !== 2) throw new Error("the bundle carries choices and taste, not raw vectors");
    if (!toCSV([b]).includes('"Roads, ""east"""')) throw new Error("CSV quoting");
    if (createStore({ local: { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } } }).saved().length !== 0)
        throw new Error("blocked storage reads as empty");
    console.log("store.js self-check ok — saves and passes steer a taste, history dedupes, the bundle carries no raw vectors, CSV quotes, blocked storage is empty not fatal");
}
