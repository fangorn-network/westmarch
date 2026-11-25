// "cloudflare:workers" for tests (vitest.config.js aliases it here): just the DurableObject base class.
export class DurableObject {
    constructor(ctx, env) { this.ctx = ctx; this.env = env; }
}
