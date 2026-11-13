import { test, expect } from "vitest";
import { memoryNetwork } from "@fangorn-network/sdk/lib/test/testbed.js";
import { fold } from "./fold.js";

// First claim of a slot wins, in log order; a commit that touches anything else is rejected whole.
const claims = (s = { owner: {}, rejected: 0, commits: 0 }, e) => {
    s = { ...s, owner: { ...s.owner }, commits: s.commits + 1 };
    const [p, more] = e.puts;
    if (!p || more || e.deletes.length || s.owner[p.payload.slot]) return { ...s, rejected: s.rejected + 1 };
    s.owner[p.payload.slot] = e.publisher;
    return s;
};
const claim = (c, slot, id = slot) => c.uploadBatch("game", [{ id, type: "claim", payload: { slot } }]);

test("everyone who folds the log gets the same state, in log order, and can resume or stop at a point", async () => {
    const net = memoryNetwork();
    const [alice, bob, eve, ref1, ref2] = await Promise.all([1, 2, 3, 4, 5].map(() => net.client()));
    await Promise.all([alice, bob, eve].map((c) => c.initRepo("game")));
    await eve.initRepo("other");
    const a = alice.getAddress().toLowerCase(), b = bob.getAddress().toLowerCase();

    await claim(alice, "x");
    const mid = await ref1.getRegistry().clock();
    await claim(bob, "x");                                       // too late: alice has it
    await claim(bob, "y");
    await eve.uploadBatch("game", [{ id: "1", type: "claim", payload: { slot: "z" } }, { id: "2", type: "claim", payload: { slot: "w" } }]); // two at once
    await eve.uploadBatch("other", [{ id: "z", type: "claim", payload: { slot: "z" } }]); // not the game

    const one = await fold(ref1, ["game"], claims), two = await fold(ref2, ["game"], claims);
    expect(two.state).toEqual(one.state);
    expect(one.state.owner).toEqual({ x: a, y: b });
    expect(one.state.rejected).toBe(5); // the three initRepo commits (no puts), bob's late x, eve's double

    // the state at an earlier point
    expect((await fold(ref1, ["game"], claims, { to: mid })).state.owner).toEqual({ x: a });

    // resume: only what's new is read
    await claim(alice, "z");
    const next = await fold(ref1, ["game"], claims, one);
    expect(next.state.owner.z).toBe(a);
    expect(next.state.commits).toBe(one.state.commits + 1);
});
