#!/usr/bin/env node
// A new app from the template: its recipe (app.json, wrangler.json, eval/), no data.
//   npx @fangorn-network/westmarch init <app> [dir] [--no-install]
//   westmarch build      the deploy button's build step (ship.js buildForDeploy)
// The app's data is what its members commit; the repo this makes can be public.
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildForDeploy, nameApp } from "./ship.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const TEMPLATE = join(ROOT, "template");
// What fangorn.network accepts: a name a shell and a URL need no quoting for.
const APP_NAME = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export function init(app, dir = app, { install = true, log = console.log } = {}) {
    if (!APP_NAME.test(app ?? "")) throw new Error(`"${app}": 2-63 characters, lowercase letters, digits, dot, dash or underscore`);
    dir = resolve(dir);
    if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty`);
    cpSync(TEMPLATE, dir, { recursive: true });
    renameSync(join(dir, "gitignore"), join(dir, ".gitignore"));   // npm drops a published .gitignore

    const cfg = nameApp(JSON.parse(readFileSync(join(dir, "app.json"), "utf8")), app);
    writeFileSync(join(dir, "app.json"), JSON.stringify(cfg, null, 1) + "\n");
    const w = JSON.parse(readFileSync(join(dir, "wrangler.json"), "utf8"));
    Object.assign(w, { name: cfg.site.project, r2_buckets: [{ ...w.r2_buckets[0], bucket_name: `${cfg.site.project}-view` }] });
    writeFileSync(join(dir, "wrangler.json"), JSON.stringify(w, null, 1) + "\n");
    writeFileSync(join(dir, "README.md"), readFileSync(join(dir, "README.md"), "utf8").replaceAll("my-app", app));
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    pkg.dependencies["@fangorn-network/westmarch"] = `^${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version}`;
    writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2) + "\n");

    if (install) {
        const sh = (cmd, ...args) => { if (spawnSync(cmd, args, { cwd: dir, stdio: "inherit" }).status !== 0) throw new Error(`${cmd} ${args[0]} failed`); };
        sh("npm", "install");   // the lock CI installs from
        sh("git", "init", "-q", "-b", "main");
        sh("git", "add", "-A");
        sh("git", "commit", "-q", "-m", `${app}: from the westmarch template`);
    }
    log(`${app} is in ${dir}. Next:
  1. app.json: the description, and the type's fields (role_map)
  2. npx westmarch-ship app.json           # claims ${app} if it isn't yet, deploys the Worker, registers its agent`);
    return dir;
}

if (process.argv[2] === "--selfcheck") {
    const dir = join(mkdtempSync(join(tmpdir(), "init-")), "app");
    try {
        init("my.app_1", dir, { install: false, log: () => {} });
        const cfg = JSON.parse(readFileSync(join(dir, "app.json"), "utf8"));
        if (cfg.app !== "my.app_1" || cfg.site.project !== "my-app-1" || !cfg.types["my.app_1.item.v1"]?.presentation.types["my.app_1.item.v1"])
            throw new Error(`app.json not filled: ${JSON.stringify(cfg)}`);
        if (!existsSync(join(dir, ".gitignore"))) throw new Error("template files missing");
        const w = JSON.parse(readFileSync(join(dir, "wrangler.json"), "utf8"));
        if (w.name !== "my-app-1" || w.r2_buckets[0].bucket_name !== "my-app-1-view") throw new Error(`wrangler.json not filled: ${JSON.stringify(w)}`);
        if (readFileSync(join(dir, "README.md"), "utf8").includes("my-app")) throw new Error("README still names my-app");
        let threw = false;
        try { init("x", join(dir, "y"), { install: false, log: () => {} }); } catch { threw = true; }
        if (!threw) throw new Error("a one-letter name must be refused");
        console.log("init: ok");
    } finally { rmSync(dirname(dir), { recursive: true, force: true }); }
} else if (process.argv[2] === "init") {
    const [app, dir] = process.argv.slice(3).filter((a) => !a.startsWith("--"));
    try { init(app, dir, { install: !process.argv.includes("--no-install") }); }
    catch (e) { console.error(e.message); process.exit(1); }
} else if (process.argv[2] === "build") {
    try { await buildForDeploy(process.argv[3] ?? "app.json"); }
    catch (e) { console.error(e.message); process.exit(1); }
} else {
    console.error("usage: westmarch init <app> [dir] [--no-install] | westmarch build [app.json]");
    process.exit(2);
}
