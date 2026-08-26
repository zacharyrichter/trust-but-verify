# Safe, Automated Container Updates: Renovate + Komodo on a Self-Hosted Fleet

## Why this exists

Running a homelab with 20+ Docker Compose stacks across multiple hosts means
a constant, low-grade decision: *do I update this image now, or do I let it
rot for six months because updating is annoying?*

Manual updates don't scale. But naive automation is worse — a blind
"redeploy on every git push" pipeline will happily bounce your reverse
proxy, your orchestrator's own agent, or a database mid-major-version-jump,
all without asking. Either failure mode (stagnation or reckless automation)
is a real production risk in a self-hosted environment where "someone else
will notice and roll it back" isn't a safety net.

The goal of this project was to build a pipeline that automatically opens
pull requests for dependency updates, and — for updates that are actually
safe to apply automatically — deploys them, without ever touching the
handful of services where an unattended restart could take down the whole
stack (including the tooling doing the automating).

This writeup covers the full pipeline: **Renovate** for update detection
and PR generation, and **Komodo** for gated, filtered deployment. It also
covers several non-obvious failure modes that were hit and root-caused
along the way — these are documented because they cost real debugging time
and aren't well-covered in either project's official docs.

## What it needed to accomplish

1. **Detect available image updates** across every Compose stack in the
   fleet, on a schedule, without manual polling.
2. **Respect per-service compatibility constraints.** A database's major
   version is not safe to bump the same way a stateless web app's patch
   version is. This needed to be expressed per-package, not fleet-wide.
3. **Never auto-merge.** Every proposed update becomes a pull request for
   human review — this pipeline automates *deployment of an approved
   change*, not the decision to approve it.
4. **Only auto-deploy after a real, human-reviewed merge** — and only when
   that merge was actually made by the update bot, not by a coincidental
   push from a person.
5. **Never auto-deploy critical infrastructure** — the reverse proxy, the
   orchestrator's own agent, and the identity provider are permanently
   excluded from automatic redeployment, regardless of who merged what.
6. **Work across multiple repositories on shared infrastructure**, without
   duplicating the deploy logic per repo.

## Architecture overview

```
┌──────────────┐     scheduled/manual      ┌──────────────────┐
│  Git server  │ ───────────────────────▶ │  Renovate (CI)    │
│ (self-hosted)│                           │  opens PRs        │
└──────────────┘                            └──────────────────┘
       │                                            
       │ human reviews & merges PR
       ▼
┌─────────────┐   webhook (push event)    ┌───────────────────┐
│  Git server │ ───────────────────────▶ │ Commit-filter      │
│             │                           │ Action (Komodo)   │
└─────────────┘                           └───────────────────┘
                                                     │
                                     commit author == bot account?
                                                     │ yes
                                                     ▼
                                            ┌──────────────────┐
                                            │  Deploy Procedure  │
                                            │  1. Pull all repos │
                                            │  2. Deploy changed │
                                            │     stacks, except │
                                            │     tagged ones    │
                                            └──────────────────┘
```

The pipeline has two independent gates before anything actually redeploys:

- **Gate 1 — who pushed this?** A webhook fires on every push to any
  tracked repository, but a small Action inspects the push payload and
  only proceeds if the commit was authored by the update bot's account.
  A manual push from a human — even one that happens to touch a tracked
  file — is correctly ignored.
- **Gate 2 — is this stack allowed to auto-deploy?** Passing Gate 1 only
  triggers a deploy job that itself excludes any stack carrying a
  `critical-infra` tag. This is a second, independent safety layer: even
  a fully legitimate bot-authored merge can never touch the reverse
  proxy, the orchestrator agent, or the identity provider through this
  pipeline.

Separating these two checks matters. They answer different questions —
*is this trigger legitimate* and *is this target safe* — and conflating
them into one check would mean a config mistake in one place removes both
protections at once.

## Part 1 — Update detection (Renovate)

[Renovate](https://docs.renovatebot.com/) scans Compose files for image
tags and opens pull requests when newer versions are available. It runs
as a scheduled CI job against a self-hosted Git server (any Forgejo/Gitea
instance works the same way; the concepts translate directly to GitHub
Actions too).

### Per-package rules, not fleet-wide defaults

The default Renovate config (`config:recommended`) treats every dependency
the same way. That's wrong for a fleet with mixed criticality — a stateless
frontend and its backing Postgres instance do not have the same blast
radius when something goes wrong.

The working config for one stack's `renovate.json` ended up looking like
this (values are illustrative, not the real fleet's):

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["config:recommended"],
  "automerge": false,
  "minimumReleaseAge": "3 days",
  "dependencyDashboard": true,
  "packageRules": [
    {
      "description": "Never propose majors for the database backing this app's search index",
      "matchFileNames": ["my-app/**"],
      "matchPackageNames": ["postgres", "docker.io/library/postgres"],
      "matchUpdateTypes": ["major"],
      "enabled": false
    },
    {
      "description": "This app's docs pin Postgres 16 specifically",
      "matchFileNames": ["another-app/**"],
      "matchPackageNames": ["postgres", "docker.io/library/postgres"],
      "allowedVersions": "/^16-alpine$/"
    },
    {
      "description": "Immediate PR for anything touching the identity provider — no cooldown",
      "matchFileNames": ["auth-service/**"],
      "minimumReleaseAge": "0 days",
      "labels": ["auth-review"]
    }
  ]
}
```

Three lessons from building this out, each of which cost real debugging
time before landing on the version above:

**Lesson: `matchFileNames` needs a glob, not an exact path.**
`matchFileNames: ["my-app/compose.yaml"]` silently matched nothing.
`matchFileNames: ["my-app/**"]` worked. Renovate did not error on the
broken version — it just quietly never applied the rule. The only way to
confirm a `packageRules` entry is actually firing is to run with
`LOG_LEVEL=debug` and check the `Filtered out N disabled update(s)` line
against what you expect to be filtered.

**Lesson: don't gate on `matchUpdateTypes` classification for
calendar-versioned images.** Some upstream images use date-based versioning
(e.g. `24.04`, `26.04`) rather than semver. Renovate's major/minor
detection assumes semver, so a "patch" bump on a calendar-versioned image
can silently be a two-year jump in practice. Renovate's own docs advise
against combining `matchUpdateTypes` with a `versioning` override in the
same rule for exactly this reason — the update type isn't known at the
point versioning is applied. If you need to hard-pin a calendar-versioned
image, use a regex `allowedVersions` (`"/^24.04.5.1.1$/"` or similar)
instead of trusting the major/minor label.

**Lesson: the same dependency can have different literal names across
files.** A Postgres image referenced as bare `postgres` in one Compose
file and `docker.io/library/postgres` (fully qualified) in another will
not both match a single-string `matchPackageNames`. Always verify the
exact `packageName` Renovate extracted, from a debug log — not by copying
a rule that worked for a "similar" dependency elsewhere in the fleet.

### One configuration mistake can silently disable everything

Early in this project, an entire repository's safety rules were inert for
multiple work sessions because of a single structural mistake: config
values were nested under a fake manager key —

```jsonc
// WRONG — this key doesn't correspond to a real Renovate manager,
// so everything inside it is silently ignored
{
  "docker-compose": {
    "minimumReleaseAge": "3 days",
    "packageRules": [ /* ... */ ]
  }
}
```

Renovate did not error. It fell back to bare `config:recommended` defaults
and kept working exactly as if the file were empty. Several unwanted pull
requests (including a couple of true major-version bumps) got opened as a
direct result, one of which was merged before the mistake was caught.

**Takeaway:** a Renovate config that parses as valid JSON is not proof that
your rules are active. Confirm with a debug-log run against a real
dependency you expect to be filtered, gated, or delayed — every time you
touch the file.

## Part 2 — Gated, filtered deployment (Komodo)

[Komodo](https://komo.do/) is a self-hosted Docker orchestration tool with
a scripting layer (Actions) and multi-step pipelines (Procedures). This
project uses three Komodo resources together:

### 1. The commit-filter Action

Receives the raw webhook payload from the Git server on every push to any
tracked repo, and only proceeds if a commit in that push was authored (or
committed) by the automation bot's account.

Full script: [`scripts/commit-filter-action.ts`](./scripts/commit-filter-action.ts)

A `COMMIT` flag gates whether this actually fires the deploy or just logs
what it *would* do — invaluable for testing the filter logic against real
webhook traffic before letting it touch anything.

### 2. The deploy procedure (two stages)

**Stage 1 — pull every tracked repo.** This is easy to skip and the
pipeline will *appear* to work without it — logs will look clean, no
errors — but nothing will actually redeploy on subsequent runs. The
"deploy if changed" check in Stage 2 compares against the orchestrator's
locally cached copy of each repo, not live upstream state. If that cache
is stale, everything looks unchanged even when the tracked repo has new
commits. Most orchestrators expose some form of "pull all matching repos
in parallel" primitive for exactly this — use it rather than one
pull-stage per repo if it's available, so adding a new repo to the fleet
doesn't require editing this pipeline.

**Stage 2 — deploy any stack with a real diff, excluding tagged ones.**
The exclusion logic runs on the orchestrator's own resource tags, not a
hardcoded list of stack names — new stacks tagged `critical-infra` are
automatically protected without touching this script again. This script
also supports excluding by repo, server, stack-name substring,
service-name substring, or image-name substring, for cases where tagging
every resource isn't practical.

Full script: [`scripts/batch-deploy-with-exclusions.ts`](./scripts/batch-deploy-with-exclusions.ts)

### 3. The webhook

Points at the **commit-filter Action's** own webhook endpoint — not the
Procedure's. This distinction matters: if the Git server's webhook is
pointed directly at the deploy Procedure, there is no author check at all,
and *any* push (including manual ones) triggers a deploy attempt.

### Two arguments that must be pushed, not scripted

Both Komodo resources above take their configuration through Arguments
rather than hardcoded values, so the same scripts serve multiple
repositories/environments without duplication:

| Resource | Key argument | Purpose |
|---|---|---|
| Commit-filter Action | `BOT_USERNAME` | The exact bot account username to match against |
| Commit-filter Action | `PROCEDURE_ID` | Which deploy pipeline to trigger on a match |
| Deploy Procedure stage | `TAGS` | Comma-separated exclusion tags |
| Both | `COMMIT` | `false`/absent = dry run, `true` = live |

**Lesson: default-argument format matters and fails silently.** Komodo
supports both a Key-Value and a JSON format for an Action's default
arguments. A Key-Value-formatted argument list that looked correct in the
UI did not actually reach the script — every argument came through as
`undefined`, with no error at all. Switching the format selector to JSON
fixed it immediately. If a script's arguments are mysteriously `undefined`
despite looking correct in the UI, check the format selector before
assuming the script logic is wrong.

## Non-obvious failure modes (worth reading before you hit them yourself)

**A firewall can silently eat a webhook with no useful error.** If your
Git server and orchestrator live on different network segments, a missing
firewall rule produces a bare connection timeout on the sending side —
no rejection, no log line on the receiving end, nothing to grep for. If a
webhook delivery just hangs, check for a network path before debugging
application logic.

**Author/committer matching depends on the bot's account email being
exactly correct — including in webhook payloads you might not expect.**
Some Git servers only populate a commit's `username` field in a webhook
payload if the commit's git-config email exactly matches a *verified*
email on an existing account. A one-character typo in that stored email
(`.rog` instead of `.org`, in this project's case) means every commit from
that account shows up in webhook payloads with an **empty username field**
— even though the commit's author name and email look completely correct
elsewhere. This is invisible unless you inspect the raw webhook payload
directly; the deploy filter's "no matching commits" behavior looks
identical whether the bot didn't author the push, or the bot's account is
misconfigured. When an author-match filter is silently failing on commits
you're sure came from the right account, dump the raw webhook delivery
payload and check the literal `username` field, not just the display name.

## Reproducing this

None of this is tool-specific in principle — the same three-stage shape
(detect → gate on trigger legitimacy → gate on target safety) works with
GitHub Actions + any orchestrator with a scripting/webhook layer, or with
Renovate's own GitHub App mode. The concepts that matter:

1. Separate "who triggered this" from "is this target safe" into two
   independent checks — never conflate them into one.
2. Test every rule against a real debug log, not against what the config
   *should* do.
3. Dry-run everything (a `COMMIT`-style flag on every Action that would
   otherwise take a real action) until you've watched it correctly refuse
   to act on bad input at least once.
4. Tag-based exclusion beats hardcoded name lists — it survives the fleet
   growing without a code change.

## Repo contents

```
.
├── README.md                              (this file)
└──LICENSE
└── scripts/
    ├── commit-filter-action.ts            (Gate 1 — author check)
    └── batch-deploy-with-exclusions.ts    (Gate 2 — tag/pattern exclusion)
```

Both scripts are the real, working versions used in production — sanitized
only insofar as variable names refer to generic concepts (`BOT_USERNAME`,
not a specific account) rather than fleet-specific values. Copy them
directly into your own Komodo Actions and set the Arguments described in
each file's header comment.

## License

MIT — see [LICENSE](./LICENSE). Sanitized: all hostnames, tokens, internal
IPs, and service names in this writeup are illustrative, not the actual
fleet's configuration. The two scripts under `scripts/` are the real,
working automation with only account-specific values genericized.
