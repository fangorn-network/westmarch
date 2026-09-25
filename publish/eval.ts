#!/usr/bin/env node
// westmarch-eval: does a view answer what its app says it should?
//
//   westmarch-eval <view> [--golden eval/golden.jsonl] [--base <view>] [--known 200] [--json] [--report out.json]
//
// A view is a URL or a directory (westmarch-ship --local writes one), served here as a reader fetches it.
//   westmarch-eval --selfcheck
//
// It grades the RECIPE — how records are shaped, which fields are embedded, how rows
// rank — never the data. New records are facts, and a view is not worse for holding
// them. So: build a base view (main's recipe) and a candidate (the change) from the
// same data, on the same machine, and run both through here. The exit code is the gate.
//
// Every check runs the reader's own code (consume/tools.js `search`, the same model),
// so a score is what an agent calling fangorn-mcp would get, not what a test harness
// with its own ranker would.
//
// golden.jsonl holds one check per line. It is data, not code, so a change proposed
// by an agent cannot also edit how it is graded:
//
//   {"id":"plover","q":"Plover village board","expect":{"where":{"city":"Plover"}},"min":0.8}
//       search: the share of the top k (default 5) that satisfies `expect`
//   {"id":"portage-solar","kind":"count","where":{"county":"Portage"},"expect":{"match":{"heading":"solar"}},"min":3}
//       count: rows the agent's `where` reaches AND that satisfy `expect` — can a filter get to them at all
//   {"id":"addresses","kind":"records","expect":{"match":{"text":"/\\b\\d{2,6} [A-Z]\\w+ (St|Ave)\\b/"}},"max_pct":0.5,"hard":true}
//       records: the % of rows that satisfy `expect`, lower is better; `hard`: any rise over the base fails.
//       `of` (a predicate) narrows which rows count, e.g. only meeting items have a date to miss.
//
// A predicate is {where?, match?, not?}. `where` is fangorn's own whole-value,
// case-insensitive match — the filter agents use. `match` maps a field (or several
// joined by `|`) to a regex, case-insensitive unless written /like this/flags. `not`
// negates another predicate.
//
// Built in, with no labels: known items. N rows are sampled (seeded, so reruns agree)
// and searched by their own title; `known@1`/`known@10` are how often they come back.

import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { configure, loadShard, trimView } from "@fangorn-network/westmarch/shard";
import { rolesFrom, textOf, titleOf, subtitleOf } from "@fangorn-network/westmarch/roles";
import { search, matches } from "@fangorn-network/westmarch/tools";
import { EMBED_MODEL, embedQueryDirect } from "@fangorn-network/westmarch/embed";

type Pred = { where?: Record<string, string>; match?: Record<string, string>; not?: Pred };
type Check =
    | { id: string; kind?: "search"; q: string; k?: number; expect: Pred; min?: number }
    | { id: string; kind: "count"; where?: Record<string, string>; expect?: Pred; min?: number; max?: number }
    | { id: string; kind: "records"; of?: Pred; expect: Pred; max_pct: number; hard?: boolean };
type Result = { id: string; kind: "search" | "count" | "records" | "known"; score: number; pass: boolean; hard?: boolean; top?: string[] };
type QueryVector = (q: string) => Promise<Float32Array | null>;

/** A drop below this, in mean precision@k or known@10, is "worse". canton-corpus's number. */
const TOLERANCE = 0.05;

const regex = (s: string) => {
    const m = /^\/(.*)\/([a-z]*)$/s.exec(s);
    return m ? new RegExp(m[1], m[2]) : new RegExp(s, "i");
};
const fieldText = (v: unknown) => (Array.isArray(v) ? v.join(" ") : String(v ?? ""));

/** A predicate, compiled once: it runs against every row. */
function compile(p: Pred = {}): (r: Row) => boolean {
    const res = Object.entries(p.match ?? {}).map(([k, re]) => [k.split("|"), regex(re)] as const);
    const not = p.not ? compile(p.not) : null;
    return (r) => matches(r, p.where)
        && res.every(([fs, re]) => re.test(fs.map((f) => fieldText(r[f])).join(" ")))
        && !not?.(r);
}

const round = (x: number) => Math.round(x * 1000) / 1000;

async function grade(rows: Row[], roles: Roles, checks: Check[], qv: QueryVector, known: number): Promise<Result[]> {
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: Result[] = [];
    for (const c of checks) {
        if (c.kind === "count") {
            const ok = compile(c.expect);
            const n = rows.filter((r) => matches(r, c.where) && ok(r)).length;
            out.push({ id: c.id, kind: "count", score: n, pass: n >= (c.min ?? 1) && n <= (c.max ?? Infinity) });
        } else if (c.kind === "records") {
            const of = rows.filter(compile(c.of)), ok = compile(c.expect);
            const pct = of.length ? round((100 * of.filter(ok).length) / of.length) : 0;
            out.push({ id: c.id, kind: "records", score: pct, pass: pct <= c.max_pct, hard: c.hard });
        } else {
            const k = c.k ?? 5, ok = compile(c.expect);
            const hits = search(rows, c.q, roles, { qv: await qv(c.q), limit: k }).map((h) => byId.get(h.id)!);
            const score = round(hits.filter(ok).length / k);
            out.push({ id: c.id, kind: "search", score, pass: score >= (c.min ?? 0), top: hits.slice(0, 3).map((r) => titleOf(r, roles).slice(0, 90)) });
        }
    }
    // ponytail: the pool is each view's own rows, so base and candidate sample different
    // rows once their records differ. TOLERANCE absorbs it; sample ids from the base if it doesn't.
    const pool = rows.filter((r) => titleOf(r, roles).split(/\s+/).length >= 4);
    const n = Math.min(known, pool.length);
    if (n) {
        let seed = 42;
        const rand = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
        // Many rows share a title ("Approve the minutes"): the same title and subtitle is a find.
        const same = (a: Row, b: Row) => a.id === b.id || (titleOf(a, roles) === titleOf(b, roles) && subtitleOf(a, roles) === subtitleOf(b, roles));
        let at1 = 0, at10 = 0;
        for (let i = 0; i < n; i++) {
            const r = pool[Math.floor(rand() * pool.length)], t = titleOf(r, roles);
            const at = search(rows, t, roles, { qv: await qv(t), limit: 10 }).findIndex((h) => same(byId.get(h.id)!, r));
            at1 += +(at === 0); at10 += +(at >= 0);
        }
        out.push({ id: "known@1", kind: "known", score: round(at1 / n), pass: true },
                 { id: "known@10", kind: "known", score: round(at10 / n), pass: true });
    }
    return out;
}

/** The candidate against the base. Worse on any one rule is worse. */
function compare(cand: Result[], base: Result[]) {
    const was = new Map(base.map((r) => [r.id, r.score]));
    const failures: string[] = [];
    for (const r of cand) {
        const b = was.get(r.id);
        if (!r.pass) failures.push(`${r.id}: ${r.score} is outside its bounds`);
        // The ratchet: a question the base answered at all, the candidate must too.
        if (r.kind === "search" && b !== undefined && b > 0 && r.score === 0) failures.push(`${r.id}: answered before, nothing now`);
        if (r.hard && b !== undefined && r.score > b) failures.push(`${r.id}: ${b}% → ${r.score}%, and it may not rise`);
    }
    // Aggregates, over the checks both sides ran: one question moving a rank is noise.
    const both = (kind: Result["kind"]) => cand.filter((r) => (kind === "known" ? r.id === "known@10" : r.kind === kind) && was.has(r.id));
    const mean = (rs: Result[], f: (r: Result) => number) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
    const deltas = (["search", "known"] as const).flatMap((kind) => {
        const rs = both(kind);
        return rs.length ? [{ kind, cand: round(mean(rs, (r) => r.score)), base: round(mean(rs, (r) => was.get(r.id)!)) }] : [];
    });
    for (const d of deltas) if (d.cand < d.base - TOLERANCE) failures.push(`${d.kind}: ${d.base} → ${d.cand}`);
    const verdict = failures.length ? "worse" : deltas.some((d) => d.cand > d.base + TOLERANCE) ? "better" : "unchanged";
    return { verdict, deltas, failures };
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[2] === "--selfcheck") await selfcheck();
else if (realpathSync(process.argv[1]).match(/\/eval\.[jt]s$/)) await main();

async function main() {
    const flags: Record<string, string | boolean> = {};
    const pos: string[] = [];
    for (let i = 2; i < process.argv.length; i++) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(process.argv[i]);
        if (!m) pos.push(process.argv[i]);
        else flags[m[1]] = m[2] ?? (["json", "help"].includes(m[1]) ? true : process.argv[++i]);
    }
    if (flags.help || pos.length !== 1) {
        console.error("usage: westmarch-eval <view> [--golden eval/golden.jsonl] [--base <view>] [--known 200] [--json] [--report out.json]");
        process.exit(flags.help ? 0 : 2);
    }
    const checks: Check[] = readFileSync(String(flags.golden ?? "eval/golden.jsonl"), "utf8")
        .split("\n").filter((l) => l.trim() && !l.startsWith("//")).map((l) => JSON.parse(l));
    const known = Number(flags.known ?? 200);

    const { env } = await import("@huggingface/transformers");
    env.cacheDir = `${homedir()}/.cache/fangorn-mcp/models`;   // shared with fangorn-mcp and westmarch-view
    const roles = new Map<string, Roles>();
    configure({ onManifests: (ms, v) => { roles.set(v, rolesFrom(ms)); }, rowText: (f, v) => textOf(f, roles.get(v)!) });
    // No fallback to word matching: a grade the reader would not get is not a grade.
    const vectors = new Map<string, Promise<Float32Array>>();
    const qv = (q: string) => vectors.get(q) ?? vectors.set(q, embedQueryDirect(q)).get(q)!;
    const run = async (at: string) => {
        const v = existsSync(at) ? await serve(at) : trimView(at), rows = await loadShard(v);
        return { view: at, rows: rows.length, results: await grade(rows, roles.get(v)!, checks, qv, known) };
    };

    const cand = await run(pos[0]);
    const base = flags.base ? await run(String(flags.base)) : null;
    const cmp = base ? compare(cand.results, base.results) : null;
    const failures = cmp?.failures ?? cand.results.filter((r) => !r.pass).map((r) => `${r.id}: ${r.score} is outside its bounds`);
    // What reproduces this grade: the model, the runtime, and the views (whose manifests hash every shard).
    const report = { model: EMBED_MODEL, node: process.version, platform: `${process.platform}-${process.arch}`,
                     candidate: cand, base, verdict: cmp?.verdict ?? null, deltas: cmp?.deltas ?? [], failures, pass: !failures.length };

    if (flags.report) writeFileSync(String(flags.report), JSON.stringify(report, null, 1));
    if (flags.json) console.log(JSON.stringify(report, null, 1));
    else {
        const was = new Map(base?.results.map((r) => [r.id, r.score]));
        console.log(`${cand.view}: ${cand.rows} rows${base ? `  (base ${base.view}: ${base.rows} rows)` : ""}\n`);
        for (const r of cand.results) {
            const b = was.get(r.id);
            console.log(`${r.pass ? " " : "✗"} ${r.kind.padEnd(7)} ${r.id.padEnd(32)} ${b === undefined ? "" : `${b} → `}${r.score}`);
        }
        for (const d of report.deltas) console.log(`\n${d.kind}: ${d.base} → ${d.cand}`);
        console.log(`\n${report.verdict ?? (report.pass ? "pass" : "fail")}${failures.length ? `\n  ${failures.join("\n  ")}` : ""}`);
    }
    process.exit(report.pass ? 0 : 1);
}

/** A view directory over HTTP on a free port, for this process's lifetime. */
async function serve(dir: string): Promise<string> {
    const srv = createServer((q, s) => {
        try { s.end(readFileSync(`${dir}${decodeURIComponent(new URL(q.url ?? "/", "http://x").pathname)}`)); }
        catch { s.statusCode = 404; s.end(); }
    });
    await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
    srv.unref();
    const a = srv.address();
    return `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}`;
}

async function selfcheck() {
    const assert = (ok: unknown, msg: string) => { if (!ok) throw new Error(msg); };
    const roles = rolesFrom([{ role_map: { title: "heading", tags: ["city"], text: ["text"] } }]);
    const rows: Row[] = [
        { id: "a", heading: "Rezoning of the lot on Main", city: "Plover", text: "Rezoning of the lot on Main. Approved 5-0." },
        { id: "b", heading: "Liquor license for the Brewing Company", city: "Plover", text: "Liquor license for the Brewing Company." },
        { id: "c", heading: "Water main replacement on Post Road", city: "Stevens Point", county: ["Portage", "Wood"], text: "Water main replacement on Post Road, 1200 Post Rd." },
        { id: "d", heading: "Snow removal contract for the winter", city: "Stevens Point", text: "Snow removal contract for the winter season." },
    ];

    // Predicates: fangorn's where (whole value, any case, arrays), field-joined regex, /flags/, not.
    assert(compile({ where: { city: "plover" } })(rows[0]), "where matches case-insensitively");
    assert(!compile({ where: { city: "Plov" } })(rows[0]), "where matches whole values only");
    assert(compile({ where: { county: "wood" } })(rows[2]), "where matches inside an array");
    assert(compile({ match: { "heading|text": "approved" } })(rows[0]), "match joins the fields it names");
    assert(!compile({ match: { heading: "/rezoning/" } })(rows[0]), "/re/ is case-sensitive");
    assert(!compile({ match: { heading: "rezon" }, not: { where: { city: "Plover" } } })(rows[0]), "not negates");

    const checks: Check[] = [
        { id: "rezoning", q: "rezoning", expect: { match: { heading: "rezon" } }, k: 1, min: 1 },
        { id: "plover", kind: "count", where: { city: "Plover" }, min: 2, max: 2 },
        { id: "wells", kind: "count", where: { city: "Plover" }, expect: { match: { heading: "well" } } },
        { id: "addresses", kind: "records", expect: { match: { text: "/\\b\\d{2,6} [A-Z]\\w+ (Rd|St)\\b/" } }, max_pct: 30, hard: true },
    ];
    const r = Object.fromEntries((await grade(rows, roles, checks, async () => null, 2)).map((x) => [x.id, x]));
    assert(r.rezoning.score === 1 && r.rezoning.pass, `lexical search finds the rezoning: ${JSON.stringify(r.rezoning)}`);
    assert(r.plover.score === 2 && r.plover.pass, "count reaches both Plover rows");
    assert(r.wells.score === 0 && !r.wells.pass, "a count with nothing to reach fails (min defaults to 1)");
    assert(r.addresses.score === 25 && r.addresses.pass, `records is a percentage: ${r.addresses.score}`);
    const [scoped] = await grade(rows, roles, [{ id: "s", kind: "records", of: { where: { city: "Stevens Point" } }, expect: { match: { text: "Rd" } }, max_pct: 100 }], async () => null, 0);
    assert(scoped.score === 50, `\`of\` narrows the rows a record check counts: ${scoped.score}`);
    assert(r["known@10"].score === 1, "every title finds its own row");

    // The verdict.
    const res = (id: string, score: number, kind: Result["kind"] = "search", extra = {}): Result => ({ id, kind, score, pass: true, ...extra });
    const base = [res("q1", 0.8), res("q2", 0.4), res("known@10", 0.9, "known"), res("pii", 0.1, "records", { hard: true })];
    assert(compare(base, base).verdict === "unchanged", "same is unchanged");
    assert(compare([res("q1", 0.8), res("q2", 0.4), res("known@10", 0.93, "known"), res("pii", 0.1, "records", { hard: true })], base).verdict === "unchanged", "within tolerance is unchanged");
    assert(compare([res("q1", 1), res("q2", 0.6), res("known@10", 0.9, "known"), res("pii", 0.1, "records", { hard: true })], base).verdict === "better", "a mean rise is better");
    assert(compare([res("q1", 0.6), res("q2", 0.4), res("known@10", 0.9, "known"), res("pii", 0.1, "records", { hard: true })], base).verdict === "worse", "a mean drop is worse");
    const ratchet = compare([res("q1", 1), res("q2", 0), res("known@10", 0.9, "known"), res("pii", 0.1, "records", { hard: true })], base);
    assert(ratchet.verdict === "worse" && /answered before/.test(ratchet.failures[0]), "the ratchet holds even when the mean does not drop");
    assert(compare([res("q1", 0.8), res("q2", 0.4), res("known@10", 0.9, "known"), res("pii", 0.2, "records", { hard: true })], base).verdict === "worse", "a hard record may not rise");
    assert(compare([res("q1", 0.8, "search", { pass: false }), res("q2", 0.4)], base).verdict === "worse", "a floor fails whatever the base did");
    assert(compare([res("q1", 0.8), res("q2", 0.4), res("q3", 0)], base).verdict === "unchanged", "a new question has no base to fall from");
    console.log("eval: selfcheck ok");
}
