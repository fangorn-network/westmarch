// Publishing an index's view to Fangorn, so a static page anywhere can find the latest one on chain.
// (No node: imports, so the Worker uses it too.)

/** The view to storage, and a `view` record pointing at it. Returns the view file's CID. */
// ponytail: one tx per new root (triggers coalesce); batch on a timer if roots move faster than that's worth
export async function publishView(fangorn, repo, view) {
    const src = await fangorn.getStorage().putFile(new TextEncoder().encode(JSON.stringify(view)), "view.json");
    await fangorn.initRepo(repo);
    await fangorn.uploadBatch(repo, [{ id: "view", type: "view", payload: { src, root: view.root, stitch: view.stitch, records: view.records.length } }]);
    const landed = await fangorn.engine.readRecord(fangorn.getAddress(), repo, "view");
    if (landed?.payload.src !== src) throw new Error(`the view record didn't land (see the SDK's silent-revert issue)`);
    return src;
}
