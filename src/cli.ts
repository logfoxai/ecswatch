// CLI entry point for `ecswatch`.
//
// Subcommands (all take a single <service> positional):
//   watch   <service>   live monitor — TUI by default, CI streaming in CI
//   inspect <service>   rich one-shot snapshot (no watch loop)
//   ci      <service>   force CI streaming mode (no TUI even on a TTY)
//   tui     <service>   force interactive TUI (no fallback even in CI)
//
// Cluster resolution: ECS addresses a service as (cluster, service). You can
// pass --cluster explicitly; otherwise ecswatch discovers which cluster the
// service lives in by scanning the account/region once and caching the
// service->cluster map (see resolve/clusterResolver.ts). The account comes
// from your ambient AWS credentials (AWS_PROFILE / SSO / env / IMDS).
//
// Globals:
//   --cluster <cluster>         skip discovery and target this cluster
//   --region <region>           default AWS_REGION / AWS_DEFAULT_REGION or us-east-2
//   --container <name>          default `app` (or CONTAINER_NAME env)
//   --log-group <name>          override the CloudWatch log group
//   --refresh                   force a re-scan of clusters (ignore the cache)

import {Command} from 'commander';

import {runCi} from './modes/ci.js';
import {runSnapshot} from './modes/snapshot.js';
import {runTui} from './modes/tui.js';
import {resolveCluster} from './resolve/clusterResolver.js';
import {c} from './theme.js';
import type {CliContext} from './types.js';

// Mirror the AWS SDK's region resolution: AWS_REGION takes precedence, then
// AWS_DEFAULT_REGION. GitHub Actions' aws-actions/configure-aws-credentials
// exports both, but other CI setups / shells often only set
// AWS_DEFAULT_REGION, so honor it as a fallback before our hardcoded default.
const DEFAULT_REGION = process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-2';

interface GlobalOpts {
    region?: string;
    cluster?: string;
    container?: string;
    logGroup?: string;
    refresh?: boolean;
}

/**
 * Build the run context, resolving the cluster if one wasn't given. Cluster
 * precedence: --cluster flag → ECS_CLUSTER_NAME env → auto-discovery (cached).
 * On discovery we print a one-line dim breadcrumb to stderr so the user can
 * see which account/cluster they're actually pointed at.
 */
async function resolveContext(service: string, opts: GlobalOpts): Promise<CliContext> {
    const region = opts.region ?? DEFAULT_REGION;
    const containerName = opts.container ?? process.env.CONTAINER_NAME ?? 'app';
    const logGroup = opts.logGroup ?? process.env.ECSWATCH_LOG_GROUP ?? null;

    const explicitCluster = opts.cluster ?? process.env.ECS_CLUSTER_NAME;
    if (explicitCluster) {
        return {service, region, cluster: explicitCluster, containerName, logGroup};
    }

    const res = await resolveCluster(region, service, {refresh: opts.refresh});
    const how = res.source === 'cache' ? 'cached' : `scanned ${res.clustersScanned} clusters`;
    process.stderr.write(
        c.dim(`account ${res.accountId} · ${region} · cluster ${res.cluster} (${how})`) + '\n',
    );
    return {service, region, cluster: res.cluster, containerName, logGroup};
}

/** Resolve the context or print the error + set a failing exit code. */
async function contextOrExit(service: string, opts: GlobalOpts): Promise<CliContext | null> {
    try {
        return await resolveContext(service, opts);
    } catch (err) {
        console.error(c.error(err instanceof Error ? err.message : String(err)));
        process.exitCode = 1;
        return null;
    }
}

async function main(): Promise<void> {
    const program = new Command();
    program
        .name('ecswatch')
        .description('ECS deploy watcher + TUI. Streams plain output in CI (CI/GITHUB_ACTIONS set, or non-TTY); fully interactive TUI otherwise.')
        .option('--cluster <name>', 'target this ECS cluster (skips auto-discovery)')
        .option('--region <region>', `AWS region (default ${DEFAULT_REGION})`)
        .option('--container <name>', 'container name (default app)')
        .option('--log-group <name>', 'CloudWatch log group (auto-resolved from task def if omitted)')
        .option('--refresh', 'force a re-scan of clusters, ignoring the resolution cache')
        .showHelpAfterError();

    program
        .command('watch <service>')
        .description('live monitor — TUI in a TTY, streaming output in CI')
        .option('--once', 'snapshot then exit')
        .option('--expected-task-def <arn>', 'fail if PRIMARY ends on a different task definition')
        .option('--force-ci', 'force CI streaming output even on a TTY')
        .option('--force-tui', 'force the TUI even when CI=true or stdout is not a TTY')
        .action(async (service: string, cmdOpts: {once?: boolean; expectedTaskDef?: string; forceCi?: boolean; forceTui?: boolean}) => {
            const ctx = await contextOrExit(service, program.opts<GlobalOpts>());
            if (!ctx) return;
            if (cmdOpts.once) {
                process.exitCode = await runCi(ctx, {once: true});
                return;
            }
            const mode = cmdOpts.forceTui ? 'tui' : cmdOpts.forceCi ? 'ci' : 'auto';
            if (shouldUseTui(mode)) {
                process.exitCode = await runTui(ctx);
            } else {
                process.exitCode = await runCi(ctx, {once: false, expectedTaskDefinitionArn: cmdOpts.expectedTaskDef});
            }
        });

    program
        .command('inspect <service>')
        .description('rich one-shot snapshot (deployments, tasks, events, diagnostics, root cause)')
        .option('--logs <n>', 'tail N recent log lines from CloudWatch', (v) => parseInt(v, 10), 0)
        .option('--no-llm', 'skip LLM analysis; use heuristic root-cause only')
        .action(async (service: string, cmdOpts: {logs: number; llm: boolean}) => {
            const ctx = await contextOrExit(service, program.opts<GlobalOpts>());
            if (!ctx) return;
            process.exitCode = await runSnapshot(ctx, {logLines: cmdOpts.logs, noLlm: !cmdOpts.llm});
        });

    program
        .command('ci <service>')
        .description('force CI streaming mode (same as watch --force-ci)')
        .option('--expected-task-def <arn>', 'fail if PRIMARY ends on a different task definition')
        .action(async (service: string, cmdOpts: {expectedTaskDef?: string}) => {
            const ctx = await contextOrExit(service, program.opts<GlobalOpts>());
            if (!ctx) return;
            process.exitCode = await runCi(ctx, {once: false, expectedTaskDefinitionArn: cmdOpts.expectedTaskDef});
        });

    program
        .command('tui <service>')
        .description('force interactive TUI (overrides CI auto-detection)')
        .action(async (service: string) => {
            const ctx = await contextOrExit(service, program.opts<GlobalOpts>());
            if (!ctx) return;
            process.exitCode = await runTui(ctx);
        });

    await program.parseAsync(process.argv);
}

function shouldUseTui(force: 'tui' | 'ci' | 'auto'): boolean {
    if (force === 'tui') return true;
    if (force === 'ci') return false;
    if (process.env.CI === 'true' || process.env.GITHUB_ACTIONS === 'true') return false;
    if (!process.stdout.isTTY) return false;
    return true;
}

main().catch((err) => {
    console.error(c.error(err instanceof Error ? err.stack ?? err.message : String(err)));
    process.exit(1);
});
