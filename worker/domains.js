// Each app's own hostname, <name>.<POOL_ZONE>, as a Workers Custom Domain on the pool Worker: Cloudflare makes the DNS
// record and a certificate for each, at no cost (a first-level name is covered; a wildcard two levels down would need
// Advanced Certificate Manager). The same call the ops repo's deploy workflow makes per app.
//
// A hostname another Worker already serves is refused, never moved: an app named after an existing deployment (say
// registry-sepolia) can't take its traffic.
//
// env: CF_API_TOKEN (secret: Workers Scripts edit, Zone read, DNS edit and Workers Routes edit on the zone),
// CF_ACCOUNT_ID, POOL_ZONE (e.g. "fangorn.network"), POOL_SERVICE (the pool Worker's script name).
// Without CF_API_TOKEN, apps get no hostname and are served by path (/apps/<name>/).

const API = "https://api.cloudflare.com/client/v4";

export const domainsOn = (env) => Boolean(env.CF_API_TOKEN && env.CF_ACCOUNT_ID && env.POOL_ZONE && env.POOL_SERVICE);

export function domains(env, fetcher = fetch) {
    const cf = async (path, init = {}) => {
        const res = await fetcher(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" } });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.success === false) throw new Error(`Cloudflare ${init.method ?? "GET"} ${path}: ${body.errors?.map((e) => e.message).join("; ") || res.status}`);
        return body.result;
    };
    const account = `/accounts/${env.CF_ACCOUNT_ID}/workers/domains`;
    const held = (hostname) => cf(`${account}?hostname=${encodeURIComponent(hostname)}`);
    let zoneId;
    return {
        hostOf: (name) => `${name}.${env.POOL_ZONE}`,
        /** The app's hostname on the pool, made if missing. Throws if another Worker serves it. */
        async ensure(name) {
            const hostname = `${name}.${env.POOL_ZONE}`, now = await held(hostname);
            const other = now.find((d) => d.service !== env.POOL_SERVICE);
            if (other) throw new Error(`${hostname} is served by the Worker "${other.service}"; pick another name or revoke that one first`);
            if (now.length) return hostname;
            zoneId ??= (await cf(`/zones?name=${encodeURIComponent(env.POOL_ZONE)}`))[0]?.id;
            if (!zoneId) throw new Error(`no zone ${env.POOL_ZONE} on this account`);
            await cf(account, { method: "PUT", body: JSON.stringify({ hostname, service: env.POOL_SERVICE, zone_id: zoneId, environment: "production" }) });
            return hostname;
        },
        /** Removes the app's hostname, only where it's the pool's. */
        async remove(name) {
            for (const d of await held(`${name}.${env.POOL_ZONE}`))
                if (d.service === env.POOL_SERVICE) await cf(`${account}/${d.id}`, { method: "DELETE" });
        },
    };
}
