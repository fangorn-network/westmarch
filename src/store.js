// Where a stitcher keeps its last `{ stitch, root, patterns }`: `load()` → it or undefined, `save(it)`.
// The stitch CID, not the root, is what matters: it is what `restitch` resumes from (it names the
// log position), and its block is in storage.

export const STITCH_TYPE = "fangorn.stitch.v1";
const ID = "stitch";

/** On fangorn itself: one record (`id: "stitch"`) in `repo`, a repo of the indexer's own key. */
export function fangornStore(fangorn, repo = "stitch") {
    return {
        async load() {
            return (await fangorn.inspectRepo(repo)).records.find((r) => r.id === ID)?.payload;
        },
        async save(it) {
            await fangorn.initRepo(repo); // a no-op once it exists
            await fangorn.upload(repo, it, STITCH_TYPE, ID);
        },
    };
}

/** In memory, for local runs and tests: no tx per save, gone on exit. */
export function memoryStore() {
    let saved;
    return { load: async () => saved, save: async (it) => { saved = it; } };
}
