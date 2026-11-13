// What `@huggingface/transformers` resolves to in the app Worker (wrangler `alias`): the Worker
// embeds with its AI binding, never in-process, and the real package is ~1.5 MB of bundle.
const none = { from_pretrained() { throw new Error("no in-process model in the Worker; it embeds with its AI binding"); } };
export const AutoModel = none, AutoTokenizer = none, env = {};
