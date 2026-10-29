# Fangorn skills for Codex

Codex and the `fangorn-builder` Claude plugin use the same `fangorn-app` and
`fangorn-improve` skills in `plugin-builder/skills/`. Each skill's `SKILL.md` is
the single source for its workflow; there is no separate Codex copy. This
integration adds no runtime, MCP server, hooks, or wallet setup.

## Install

Paste this prompt into Codex:

```text
$skill-installer Install fangorn-app and fangorn-improve from https://github.com/fangorn-network/westmarch, using plugin-builder/skills/fangorn-app and plugin-builder/skills/fangorn-improve.
```

**The shared skills with these compatibility updates are available from the
default branch after these changes are merged.** Before merge, use a local
checkout as described below, or explicitly ask the installer for a published branch or commit that contains these paths.

The built-in installer accepts GitHub repository paths and installs both folders
for your user account. It refuses to replace existing skill folders. Skills are
available on your next turn; restart Codex if they do not appear. See the
[official Codex skill documentation](https://learn.chatgpt.com/docs/build-skills)
for installation, discovery, and invocation conventions (checked 2026-10-29).

For a project-only local install, copy `plugin-builder/skills/fangorn-app/` and
`plugin-builder/skills/fangorn-improve/` into that project's `.agents/skills/`.
Keep each folder's `SKILL.md` and `LICENSE.md`. Do not overwrite an existing folder. Choose one installation scope to avoid duplicate skill names. Merely
cloning this repository does not activate skills stored under `plugin-builder/skills/`.
To uninstall, remove only these two folders from the chosen installation location.

## Invoke

Use the skill picker or paste one of these prompts:

```text
Use $fangorn-app to build a Fangorn app from my dataset at <path or URL>.
Start with questions and local evaluation. Ask before publishing or deploying.
```

```text
Use $fangorn-improve in this app repository for one improvement run.
Check its evaluation gate and branch protection first.
```

Codex can also select a skill when a request matches its description. Installation
alone runs no Fangorn workflow and creates no schedule. Recurring runs require an
explicit request and the host's supported scheduler.

## Prerequisites and credentials

- Builder: Node 22, the Fangorn CLI, westmarch, and Python 3 with quickbeam for
  sources. The retained SDK install example is older than this checkout's
  `@fangorn-network/sdk` peer dependency (`^2026.10.27-dev`); follow the workflow's
  instruction to check the installed westmarch package's peer dependency.
- Publication/deployment, only when explicitly authorized: the app-owning wallet
  on the app's network, Pinata, and the intended Cloudflare account. New apps use
  Base Sepolia; existing apps may remain on Arbitrum Sepolia.
- Improve: an existing app repository, Git, authenticated GitHub CLI, golden
  questions and goals, protected `main` requiring `eval`, `ship.yml` with an
  `observe` step and `observe-report` artifact, `eval.yml`, and the expected labels.
  Missing prerequisites mean stop and report; this integration supplies none of
  that GitHub setup. Improve never publishes, deploys, or merges and needs no wallet.

Wallet setup stays in the user's own terminal. References to `fangorn init` mean
that manual step, outside chat and agent-controlled terminals. Never request,
read, display, or copy private keys, seed phrases, or secret-bearing configuration.
Pinata and Cloudflare credentials likewise stay outside chat and generated files.
Use public addresses for checks; do not inspect wallet configuration or dump
secret-bearing environment variables. Installing these skills needs no credentials.

## Provenance and differences from upstream

Prepared adaptation inspected 2026-10-29, based on
[`a8382568dd6e3bca8aaa8ba1c281e37c289d7965`](https://github.com/fangorn-network/westmarch/commit/a8382568dd6e3bca8aaa8ba1c281e37c289d7965),
`fangorn-builder` version `0.2.2`, author Tony Riemer:

- [Original app skill](https://github.com/fangorn-network/westmarch/blob/a8382568dd6e3bca8aaa8ba1c281e37c289d7965/plugin-builder/skills/fangorn-app/SKILL.md)
- [Original improve skill](https://github.com/fangorn-network/westmarch/blob/a8382568dd6e3bca8aaa8ba1c281e37c289d7965/plugin-builder/skills/fangorn-improve/SKILL.md)

The refreshed `origin/main` was still at that commit on 2026-10-29; comparing
`plugin-builder/skills/` against the baseline found no newer instructions to
reconcile. The upstream MIT license is retained [here](../LICENSE.md) and in each
installable skill folder.

Both hosts use the workflows directly in `plugin-builder/skills/*/SKILL.md`.
The Claude plugin manifest and skill locations are unchanged. The shared skills
preserve Fangorn commands, registration before building when authorized,
real-source requirements, local evaluation gates, immutable identities
and card binding, deployed verification, UI/tool parity, and one improvement PR
per run with no publication, deployment, or merging. Adaptation changes:

- Make scheduling host-specific and explicitly requested (`/loop` remains an option
  in Claude Code); add scope, credential, untrusted-input, and unique
  temporary-path guidance.
- Include the required `network: baseSepolia` in the minimal registration example.
- Use upstream's `--update <agentId>` guidance when refreshing an existing agent,
  rather than a bare registration rerun that would mint another agent.
- Pin the walkthrough link to the inspected baseline. Check the installed package
  version before applying guidance from another release.
- Correct the claim that the builder establishes improve's GitHub prerequisites.
- Replace archive installation instructions with a Codex installer prompt pointing
  to the shared skill folders and a project-local alternative. Fold the prepared
  adaptation into the existing Claude skills and remove the separate Codex copies.

Remaining upstream inconsistencies: the builder mixes Worker and Pages deployment
paths; inspect the existing deployment and preserve `--no-deploy` for Deploy-button
apps. Its later CID-based identity explanation is broader than its own earlier
payload-ID guidance; keep stable, globally unique record identities. Improve still
requires GitHub gates absent from the builder's current local loop. Civic-data
filenames are examples for apps with that structure, not files to fabricate.
This adaptation does not repair the upstream deployment implementation or version drift.

## Validation scope

Both skills are checked with Codex's skill validator, local Markdown references
are resolved, licenses are compared, and workflow differences are reviewed against
the baseline. No Fangorn registration, publication, deployment, wallet access, or
chain-writing command is needed for these checks. Live Fangorn execution and
fresh-session skill discovery are outside this documentation integration's checks.
