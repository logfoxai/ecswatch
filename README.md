# ecswatch

[![build status](https://github.com/logfoxai/ecswatch/actions/workflows/release.yml/badge.svg)](https://github.com/logfoxai/ecswatch/actions)
[![SemVer](https://img.shields.io/badge/SemVer-2.0.0-blue)]()
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://conventionalcommits.org)
[![AutoRel](https://img.shields.io/badge/%F0%9F%9A%80%20AutoRel-2D4DDE)](https://github.com/mhweiner/autorel)

CLI for watching ECS service rollouts. Use it in CI for streaming deploy status, or in a terminal for an interactive TUI.

- **CI mode**: streams rollout progress, exits non-zero on failure, emits GitHub Actions annotations (`::group::`, `::error::`, `::notice::`).
- **TUI** (default on a TTY): deployments, tasks, events, logs, target health, diagnostics.
- **Snapshot** (`inspect`): one-shot tabular report.
- **Cluster discovery**: resolves `(cluster, service)` from the service name and caches the map.
- **Root-cause analysis** (optional): uses Anthropic/OpenAI when API keys are set; otherwise heuristics only.

## Install

From npm (once published):

```bash
npm install -g ecswatch
```

From a local checkout:

```bash
git clone <repo> ecswatch && cd ecswatch
npm install            # runs the build via the `prepare` script
npm link               # exposes `ecswatch` on your PATH
```

After that, `ecswatch --help` works from anywhere. If you change the source, run `npm run build` (or `npm run dev` for a watcher) — the global bin stays pointed at `dist/cli.js`.

To uninstall: `npm unlink -g ecswatch`.

## Usage

You give it a **service name**; ecswatch figures out the cluster.

```bash
ecswatch watch    phone-audit              # TUI on a TTY, CI streaming in CI
ecswatch inspect  phone-audit              # one-shot tabular snapshot
ecswatch inspect  phone-audit --logs 80    # also tail 80 log lines
ecswatch ci       phone-audit              # force CI streaming
ecswatch tui      phone-audit              # force interactive TUI
ecswatch watch    phone-audit --once       # snapshot then exit
ecswatch watch    phone-audit --cluster my-cluster   # skip discovery
```

### Cluster discovery & caching

ECS addresses a service as `(cluster, service)`. Rather than make you name the
cluster every time, ecswatch discovers it: on first use it scans every cluster
in the account/region (`ListClusters` → `ListServices`), builds a
`service → cluster` map, and caches it to `~/.cache/ecswatch/clusters.json`
(respects `XDG_CACHE_HOME`). Subsequent calls resolve instantly from the cache.

- The **AWS account** comes from your ambient credentials (`AWS_PROFILE` / SSO /
  env / IMDS). ecswatch prints the account id + resolved cluster on each run so
  you can see exactly what you're pointed at.
- The cache is keyed by `accountId:region`, so different profiles/regions never
  collide. Entries expire after 12h; a cache miss for a (possibly new) service
  also triggers a rescan.
- Pass `--refresh` to force a re-scan, or `--cluster <name>` (or
  `ECS_CLUSTER_NAME`) to skip discovery entirely.
- If a service name exists in **multiple** clusters, ecswatch errors and asks
  you to disambiguate with `--cluster`.

### Conventions

| Flag           | Default                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `--cluster`    | `$ECS_CLUSTER_NAME`, else auto-discovered by scanning the account        |
| `--region`     | `$AWS_REGION` / `$AWS_DEFAULT_REGION` or `us-east-2`                     |
| `--container`  | `$CONTAINER_NAME` or `app`                                               |
| `--log-group`  | resolved from the active task definition's `awslogs-group` if not given  |
| `--refresh`    | force a cluster re-scan, ignoring the cache                              |

### LLM configuration

Set one or both:

```bash
export ANTHROPIC_API_KEY=sk-ant-…
export OPENAI_API_KEY=sk-…
```

Optionally override the chain (default: `anthropic:claude-sonnet-4-6,openai:gpt-5`):

```bash
export ECSWATCH_LLM_MODELS="anthropic:claude-sonnet-4-6,openai:gpt-5"
```

If no key is configured, ecswatch uses heuristic diagnostics only — it still tells you about placement failures, image pulls, OOM exits, ALB health-check failures, circuit-breaker rollbacks, and the canonical `Manifest does not contain descriptor matching platform 'linux/amd64'` architecture mismatch.

## TUI keybindings

| Key       | Action                                                                  |
| --------- | ----------------------------------------------------------------------- |
| `1`–`6`   | focus deployments · tasks · events · logs · target health · diagnostics |
| `r`       | refresh now                                                             |
| `a`       | run root-cause analysis                                                 |
| `p`       | pause / resume log streaming                                            |
| `?`       | toggle help                                                             |
| `q` / `^C`| quit                                                                    |

The TUI runs analysis automatically on the first `FAILED` rollout.

## CI integration

```yaml
- name: Watch ECS rollout
  env:
    AWS_REGION: us-east-2
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}  # optional
  run: |
    npx ecswatch ci ${{ env.SERVICE_NAME }}
```

GitHub Actions auto-detection: ecswatch switches into CI mode when `CI=true` or `GITHUB_ACTIONS=true` is set, or when stdout is not a TTY. Use `--force-tui` to override.

CI output is colored via 24-bit ANSI (looks the same in iTerm, Alacritty, and the GitHub Actions web log viewer). Failure summaries are wrapped in `::group::` blocks so they're collapsible in the Actions UI, and `::error::` annotations show up inline on the failed step in the PR view.

## What it shows

| Panel          | Data                                                                                                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deployments    | PRIMARY + ACTIVE deployments, task definition, rollout state, running/desired/pending counts, failed-task counter, rollout reason, age.                                                       |
| Tasks          | Running tasks split by deployment (NEW vs OLD), last status, health, CPU/MB, AZ, uptime. Plus the 3 most recently stopped tasks with `stopCode` and container exit codes.                     |
| Events         | The most recent ECS service events, severity-colored.                                                                                                                                         |
| Logs           | Live tail of the CloudWatch log group resolved from the task definition.                                                                                                                      |
| Target health  | ALB target group health with per-target unhealthy reasons (`Target.FailedHealthChecks`, `Target.Timeout`, etc.).                                                                              |
| Diagnostics    | Heuristic detections: placement failures, image pull failures, essential container exits, ALB unhealthy, circuit breaker trips, OOM kills, IAM init errors, capacity mismatches.              |
| Root cause     | Summary, likely causes, and suggested fixes. Uses configured API keys when present; otherwise heuristics.                                                                                   |

## Architecture

```
bin/ecswatch             ─ shim that loads dist/cli.js (stable for `npm link`)
src/
  cli.ts                 ─ commander-driven CLI, mode dispatcher
  theme.ts               ─ central RGB palette (truecolor; chalk auto-degrades)
  ghAnnotations.ts       ─ GitHub Actions ::group:: / ::error:: / ::notice::
  format/
    table.ts             ─ tiny ANSI-aware table renderer (kubectl-style)
  resolve/
    clusterResolver.ts   ─ service→cluster discovery + on-disk cache
  aws/
    clients.ts           ─ lazy per-region ECS / Logs / ELB / STS clients
    ecs.ts               ─ describe/list services, tasks, task-defs, clusters
    logs.ts              ─ FilterLogEvents + async-iterator tail
    elb.ts               ─ DescribeTargetHealth
    sts.ts               ─ GetCallerIdentity (account id for cache key)
  analyze/
    diagnostics.ts       ─ heuristic failure detectors (events + tasks + targets)
    llm.ts               ─ Anthropic + OpenAI provider chain
    rootCause.ts         ─ compose payload → LLM → parse → fallback heuristic
  modes/
    ci.ts                ─ streaming watcher (CI / non-TTY)
    snapshot.ts          ─ tabular one-shot report
    tui.tsx              ─ Ink renderer
  ui/                    ─ Ink components + hooks (App, panels, theme, hooks)
```

## Dev

```bash
npm run typecheck     # tsc --noEmit
npm run build         # esbuild → dist/cli.js (ESM bundle, deps external)
npm run dev           # rebuild on change
npm run validate      # typecheck + build
```

## Publishing

This package targets the public npm registry (unscoped name). When ready:

```bash
npm login
npm run validate          # also runs as prepublishOnly
npm publish               # public access is the default for unscoped names
```

## License

MIT
