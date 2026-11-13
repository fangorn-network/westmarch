#!/usr/bin/env node
// Experiment: shared game state with no game server, on the sandbox.
//
//   npm run sandbox             # in one terminal
//   node examples/game.js       # in another
//
// Territory on a 6×6 board. Each player writes moves to their OWN repo, "territory-1": one move per
// commit. The game is a pure reducer over those commits in the chain's log order (src/fold.js), so every
// player, referee and spectator computes the same board, and nobody hosts it. Anyone with a repo of that
// name has joined. Rules (enforced by every reader, not by a server): one move per commit, never two turns
// in a row, an empty cell next to your own territory, and past moves can't be changed or deleted.

import { createHash } from "node:crypto";
import { fold } from "../src/fold.js";
import { digestOf } from "../src/sandbox.js";
import { agent, metered, say, h, who } from "./lib.js";

// The block a stitch was folded up to. ponytail: Fangorn.readStitch drops `t` (the engine has it); return it
// there and this goes.
const stitchT = async (c, s) => (await c.engine.readStitch(c.engine.hexToRootCid(digestOf(s)))).t;

const GAME = `territory-${Date.now().toString(36)}`, N = 6; // a new game each run
const adjacent = (a, b) => { const [x, y] = a.split(",").map(Number), [u, v] = b.split(",").map(Number); return Math.abs(x - u) + Math.abs(y - v) === 1; };

/** The rules. `{ perCommit: 3, alternate: false }` is a variant: same moves, other rules, another app. */
const territory = ({ perCommit = 1, alternate = true } = {}) => (s = { board: {}, last: null, seen: {}, moves: 0, players: [], rejected: [] }, e) => {
    const reject = (why) => ({ ...s, rejected: [...s.rejected, { player: e.publisher, pos: e.pos, why }] });
    if (!e.puts.length && !e.deletes.length) return s.players.includes(e.publisher) ? s : { ...s, players: [...s.players, e.publisher] }; // initRepo: joined
    if (e.deletes.length) return reject("deletes a past move");
    if (e.puts.length > perCommit) return reject(`${e.puts.length} moves in one commit`);
    const next = { ...s, board: { ...s.board }, seen: { ...s.seen } };
    for (const m of e.puts) {
        const id = `${e.publisher}/${m.id}`, [x, y] = m.payload.cell ?? [], c = `${x},${y}`;
        if (next.seen[id]) return reject("rewrites a past move");
        if (!(x >= 0 && x < N && y >= 0 && y < N)) return reject("off the board");
        if (next.board[c]) return reject(`${c} is taken`);
        const mine = Object.keys(next.board).filter((k) => next.board[k] === e.publisher);
        if (mine.length && !mine.some((k) => adjacent(k, c))) return reject(`${c} isn't next to their territory`);
        next.board[c] = e.publisher; next.seen[id] = true; next.moves++;
    }
    if (alternate && e.publisher === s.last) return reject("two turns in a row");
    return { ...next, last: e.publisher };
};
const rules = territory();
const hash = (s) => createHash("sha256").update(JSON.stringify(s)).digest("hex").slice(0, 16);
const draw = (s) => {
    for (let y = 0; y < N; y++) say("     " + [...Array(N)].map((_, x) => s.board[`${x},${y}`] ? who(s.board[`${x},${y}`])[0].toUpperCase() : "·").join(" "));
};

const [alice, bob, carol, eve, referee, spectator] = await Promise.all(["alice", "bob", "carol", "eve", "referee", "spectator"].map((n) => agent(n)));
const players = [alice, bob, carol];
const move = (p, id, cell) => p.uploadBatch(GAME, [{ id, type: "move", payload: { cell } }]);

h("1. players join and play at once, each from its own view of the log");
const starts = [[0, 0], [5, 5], [0, 5]];
const play = async (p, i, turns) => {
    let view = {};
    for (let k = 0; k < turns; k++) {
        for (let w = 0; ; w++) { // wait for someone else to move (or give up, and see it rejected)
            view = await fold(p, [GAME], rules, view);
            if (view.state.last !== p.address || w > 50) break;
            await new Promise((r) => setTimeout(r, 20 + Math.random() * 40));
        }
        const s = view.state;
        const mine = Object.keys(s.board).filter((k) => s.board[k] === p.address);
        const free = mine.length
            ? [...new Set(mine.flatMap((k) => { const [x, y] = k.split(",").map(Number); return [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]; }))]
                .filter(([x, y]) => x >= 0 && x < N && y >= 0 && y < N && !s.board[`${x},${y}`])
            : [starts[i]];
        if (!free.length) break;
        // the next id comes from the log, not from memory: a player that restarts picks up where it was
        await move(p, `m${Object.keys(s.seen).filter((k) => k.startsWith(p.address)).length}`, free[Math.floor(Math.random() * free.length)]);
    }
};
await Promise.all([...players, eve].map((p) => p.initRepo(GAME)));
const round1 = await metered("3 players, 6 moves each, racing", () => Promise.all(players.map((p, i) => play(p, i, 6))));
const mid = await referee.restitch([GAME]); // the game at this point, by one hash

h("2. eve cheats; nobody moderates");
await move(eve, "e0", [5, 0]);
await eve.uploadBatch(GAME, [1, 2, 3].map((k) => ({ id: `e${k}`, type: "move", payload: { cell: [5, k] } })));
await move(eve, "e0", [2, 2]);                                         // rewrite her first move
const taken = Object.entries((await fold(eve, [GAME], rules)).state.board).find(([, o]) => o !== eve.address)[0];
await move(eve, "e9", taken.split(",").map(Number));                   // take a cell that's someone's
await eve.uploadBatch(GAME, [], ["e0"]);                               // delete her past move
// and write as alice: eve signs her own commit, then submits it as alice's
const { commitCid } = await eve.commit({ repo: GAME, parent: (await eve.engine.resolveHeadCommit(eve.address, GAME)).toString(), records: [{ id: "x", type: "move", payload: { cell: [4, 4] } }] });
const forged = await referee.relayPush({ ...(await eve.signPush(GAME, commitCid)), publisher: alice.address }).then(() => "accepted!", (e) => `rejected by the contract (${e.shortMessage ?? e.message.split("\n")[0]})`);
say(`  eve's update as alice: ${forged}`);

await metered("3 players, 4 more moves each", () => Promise.all(players.map((p, i) => play(p, i, 4))));

h("3. the result, as every reader computes it");
const t0 = performance.now();
const final = await fold(referee, [GAME], rules);
const foldMs = Math.round(performance.now() - t0);
const s = final.state;
draw(s);
say(`  players: ${s.players.map(who).join(", ")}   moves: ${s.moves}   score: ${s.players.map((p) => `${who(p)} ${Object.values(s.board).filter((o) => o === p).length}`).join(", ")}`);
say(`  rejected ${s.rejected.length}:`);
for (const r of s.rejected) say(`     ${who(r.player).padEnd(6)} #${String(r.pos).padEnd(3)} ${r.why}`);
say(`  gas per move: ${Math.round(round1.gas / round1.txs)} (${round1.txs} txs in round 1)   full replay: ${foldMs} ms over ${s.moves + s.rejected.length} commits`);

h("4. a spectator who trusts nobody");
const other = await fold(spectator, [GAME], rules);
say(`  spectator's own replay: ${hash(other.state)}  referee's: ${hash(s)}  → ${hash(other.state) === hash(s) ? "same board" : "DIFFERENT"}`);
// the referee publishes a checkpoint: a stitch, and the state hash as of it
const cp = await referee.restitch([GAME]);
const t = await stitchT(referee, cp);
await referee.initRepo("referee");
await referee.uploadBatch("referee", [{ id: GAME, type: "checkpoint", payload: { stitch: cp.toString(), t: Number(t), state: hash((await fold(referee, [GAME], rules, { to: t })).state) } }]);
const got = (await spectator.engine.readRecord(referee.address, "referee", GAME)).payload;
const ok = await spectator.verifyStitch(got.stitch, [GAME]);
const mine = hash((await fold(spectator, [GAME], rules, { to: BigInt(got.t) })).state);
say(`  referee's checkpoint: stitch ${got.stitch.slice(0, 16)}… state ${got.state}`);
say(`  stitch matches the chain's log: ${ok}; replayed to it: ${mine} → ${mine === got.state ? "checkpoint holds" : "checkpoint is FALSE"}`);
say(`  who's in it, from the stitch alone: ${(await spectator.stitchHeads(got.stitch)).map((x) => who(x.publisher)).join(", ")}`);

h("5. the past, and other apps over the same moves");
const then = await fold(spectator, [GAME], rules, { to: await stitchT(spectator, mid) });
say(`  the board as of the stitch taken after round 1 (${then.state.moves} moves):`);
draw(then.state);
const variant = await fold(spectator, [GAME], territory({ perCommit: 3, alternate: false }));
say(`  same moves, under a looser variant: 3 moves per commit, turns in a row allowed (${variant.state.moves} moves count, vs ${s.moves}):`);
draw(variant.state);
process.exit(0);
