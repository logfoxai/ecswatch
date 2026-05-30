// CI/streaming mode. Matches and improves on the existing
// `infra/ci-cd/watch-ecs-service.sh` UX:
//
//   1. Watch a service from now → COMPLETED | FAILED.
//   2. Print new ECS events as they arrive (one line per event, colored).
//   3. Print rollout progress (running/desired/pending) only on change.
//   4. On FAILED, pull stopped tasks + tail logs and run diagnostics +
//      optional LLM root-cause; print a `::error::` GH annotation so the
//      Actions PR view shows it inline.
//   5. Exit non-zero on failure; 0 on completed rollout; 130 on Ctrl-C.
//
// Reads exactly the same env vars the bash script accepted so this is a
// drop-in replacement when called from `release.yml`-style workflows.

import {describeService, getRecentStoppedTasks, primaryDeployment, describeTaskDef} from '../aws/ecs.js';
import {tail as tailLogs} from '../aws/logs.js';
import {describeTargetHealth} from '../aws/elb.js';
import {analyze} from '../analyze/diagnostics.js';
import {rootCause} from '../analyze/rootCause.js';
import * as gh from '../ghAnnotations.js';
import {c, colorEventMessage, colorRolloutState, pill} from '../theme.js';
import type {CliContext, ServiceSnapshot} from '../types.js';

const POLL_MS = 5_000;
const TAG = c.accent('[ECS]');

export interface CiOptions {
    /** When true, print snapshot + exit immediately (no watch). */
    once: boolean;
    /** Optional: assert that PRIMARY rolls onto this task-def ARN before COMPLETED counts. */
    expectedTaskDefinitionArn?: string;
}

export async function runCi(ctx: CliContext, opts: CiOptions): Promise<number> {
    console.log(`${c.primary('==>')} Watching ${c.fg(ctx.service)} on ${c.fg(ctx.cluster)} (${c.muted(ctx.region)})`);

    let svc: ServiceSnapshot;
    try {
        svc = await describeService(ctx.region, ctx.cluster, ctx.service);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        gh.error(msg, {title: 'ecswatch: service lookup failed'});
        console.error(c.error(msg));
        return 1;
    }

    if (opts.once) {
        printSnapshot(svc);
        return 0;
    }

    const startedAt = Date.now();
    const seenEventIds = new Set<string>(svc.events.map((e) => e.id));
    let lastRunning = -1;
    let lastPending = -1;
    let lastRollout = '__unset__';
    let sawInProgress = false;
    const onSigint = () => {
        process.exit(130);
    };
    process.on('SIGINT', onSigint);

    console.log(`${TAG} ${c.muted('waiting for deploy events (use --once for snapshot, Ctrl-C to stop)')}`);

    while (true) {
        try {
            svc = await describeService(ctx.region, ctx.cluster, ctx.service);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.error(`${TAG} ${c.warning(`describe-services failed: ${msg}`)}`);
            await sleep(POLL_MS);
            continue;
        }

        // Print new events (chronological).
        const fresh = svc.events
            .filter((e) => !seenEventIds.has(e.id) && e.createdAt.getTime() >= startedAt - 60_000)
            .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
        for (const e of fresh) {
            seenEventIds.add(e.id);
            console.log(`  ${TAG} ${colorEventMessage(e.message)}`);
        }

        const primary = primaryDeployment(svc);
        if (primary) {
            const running = primary.runningCount;
            const pending = primary.pendingCount;
            const rollout = primary.rolloutState;
            if (running !== lastRunning || pending !== lastPending || rollout !== lastRollout) {
                printProgress(primary.desiredCount, running, pending, rollout);
                lastRunning = running;
                lastPending = pending;
                lastRollout = rollout;
            }
            if (rollout === 'IN_PROGRESS') sawInProgress = true;
            if (rollout === 'COMPLETED' && sawInProgress) {
                if (opts.expectedTaskDefinitionArn && primary.taskDefinitionArn !== opts.expectedTaskDefinitionArn) {
                    const msg = `ECS service is stable but PRIMARY is on ${primary.taskDefinitionArn}, expected ${opts.expectedTaskDefinitionArn} (circuit breaker rollback?).`;
                    gh.error(msg, {title: 'ecswatch: wrong task definition'});
                    console.error(c.error(msg));
                    process.removeListener('SIGINT', onSigint);
                    return 1;
                }
                console.log('');
                printSnapshot(svc);
                gh.notice(`Rollout complete: ${svc.serviceName} on ${primary.taskDefinition}`, {title: 'ecswatch: rollout complete'});
                process.removeListener('SIGINT', onSigint);
                return 0;
            }
            if (rollout === 'FAILED' && sawInProgress) {
                console.log('');
                await emitFailureReport(ctx, svc);
                process.removeListener('SIGINT', onSigint);
                return 1;
            }
        }

        await sleep(POLL_MS);
    }
}

function printProgress(desired: number, running: number, pending: number, rollout: string): void {
    if (desired === 0 && running === 0 && pending === 0) {
        console.log(`  ${TAG} ${c.muted('deployment starting…')}`);
        return;
    }
    const bar = progressBar(running, desired);
    console.log(`  ${TAG} ${bar} ${c.fg(`${running}/${desired}`)} running, ${c.pending(`${pending}`)} pending ${colorRolloutState(rollout)}`);
}

function progressBar(running: number, desired: number): string {
    // See note in snapshot.ts — pill glyphs + primary blue so the bar can't be
    // mistaken for a green status pill on an adjacent line in CI logs.
    const width = 12;
    if (desired <= 0) return c.dim('▱'.repeat(width));
    const filled = Math.min(width, Math.round((running / desired) * width));
    const empty = width - filled;
    return c.primary('▰'.repeat(filled)) + c.dim('▱'.repeat(empty));
}

function printSnapshot(svc: ServiceSnapshot): void {
    const primary = primaryDeployment(svc);
    console.log(c.accent('━'.repeat(60)));
    console.log(`${c.muted('service:')}    ${c.fg(svc.serviceName)}`);
    console.log(`${c.muted('cluster:')}    ${c.fg(svc.clusterName)}  ${c.muted(svc.region)}`);
    console.log(`${c.muted('status:')}     ${pill(svc.status, svc.status === 'ACTIVE' ? 'success' : 'warning')}`);
    console.log(`${c.muted('desired:')}    ${c.fg(String(svc.desiredCount))}`);
    console.log(`${c.muted('running:')}    ${c.success(String(svc.runningCount))}`);
    console.log(`${c.muted('pending:')}    ${c.pending(String(svc.pendingCount))}`);
    console.log(`${c.muted('task def:')}   ${c.fg(svc.primaryTaskDefinition)}`);
    if (primary) {
        console.log(`${c.muted('rollout:')}    ${colorRolloutState(primary.rolloutState)}${primary.rolloutStateReason ? '  ' + c.muted(primary.rolloutStateReason) : ''}`);
    }
    console.log(c.accent('━'.repeat(60)));
    console.log(c.muted('Recent events:'));
    for (const e of svc.events.slice(0, 8)) {
        const stamp = c.dim(e.createdAt.toISOString().replace('T', ' ').slice(0, 19));
        console.log(`  ${stamp}  ${colorEventMessage(e.message)}`);
    }
}

async function emitFailureReport(ctx: CliContext, svc: ServiceSnapshot): Promise<void> {
    const primary = primaryDeployment(svc);
    gh.error(
        `${svc.serviceName} rollout FAILED${primary?.rolloutStateReason ? ': ' + primary.rolloutStateReason : ''}`,
        {title: 'ecswatch: rollout failed'},
    );

    printSnapshot(svc);

    await gh.withGroup('ecswatch: stopped tasks', async () => {
        try {
            const stopped = await getRecentStoppedTasks(ctx.region, ctx.cluster, ctx.service, svc.primaryTaskDefinitionArn);
            if (stopped.length === 0) {
                console.log(c.muted('  (no recently stopped tasks)'));
                return;
            }
            for (const t of stopped.slice(0, 8)) {
                console.log(`  ${c.warning('●')} ${c.fg(t.shortId)} ${c.muted(`(${t.taskDefinition})`)}`);
                console.log(`    ${c.muted('stopCode:')}   ${c.error(t.stopCode ?? '?')}`);
                console.log(`    ${c.muted('reason:')}     ${t.stoppedReason ?? c.dim('—')}`);
                for (const cont of t.containers) {
                    const exit = cont.exitCode === null ? c.dim('—') : (cont.exitCode === 0 ? c.success('0') : c.error(String(cont.exitCode)));
                    console.log(`    ${c.muted('container:')}  ${c.fg(cont.name)} ${c.muted('exit=')}${exit} ${cont.reason ? c.dim(cont.reason) : ''}`);
                }
            }
        } catch (err) {
            console.log(c.dim(`  (could not list stopped tasks: ${err instanceof Error ? err.message : String(err)})`));
        }
    });

    let logGroup: string | null = ctx.logGroup;
    if (!logGroup) {
        try {
            const td = await describeTaskDef(ctx.region, svc.primaryTaskDefinitionArn);
            logGroup = td.logGroup;
        } catch {
            // best effort
        }
    }

    let logs: ReturnType<typeof tailLogs> extends Promise<infer L> ? L : never = [];
    if (logGroup) {
        await gh.withGroup(`ecswatch: log tail (${logGroup})`, async () => {
            try {
                logs = await tailLogs(ctx.region, logGroup!, {limit: 80, sinceMs: Date.now() - 15 * 60_000});
                if (logs.length === 0) console.log(c.muted('  (no log events in the last 15m)'));
                for (const line of logs.slice(-60)) {
                    const stamp = c.dim(line.timestamp.toISOString().slice(11, 19));
                    const colored = line.severity === 'error' ? c.error(line.message)
                        : line.severity === 'warn' ? c.warning(line.message)
                            : c.fg(line.message);
                    console.log(`  ${stamp}  ${colored}`);
                }
            } catch (err) {
                console.log(c.dim(`  (could not tail logs: ${err instanceof Error ? err.message : String(err)})`));
            }
        });
    }

    const stoppedForAnalysis = await safe(() => getRecentStoppedTasks(ctx.region, ctx.cluster, ctx.service, svc.primaryTaskDefinitionArn), []);
    const tgHealth = await safe(() => describeTargetHealth(ctx.region, svc.targetGroupArns), []);
    const diagnostics = analyze({service: svc, stoppedTasks: stoppedForAnalysis, runningTasks: [], targetHealth: tgHealth});

    await gh.withGroup('ecswatch: diagnostics', async () => {
        if (diagnostics.length === 0) {
            console.log(c.muted('  (no diagnostics matched — see snapshot / events above)'));
            return;
        }
        for (const d of diagnostics) {
            const tag = d.severity === 'error' ? c.error('[ERROR]')
                : d.severity === 'warn' ? c.warning('[WARN]') : c.info('[INFO]');
            console.log(`  ${tag} ${c.fg(d.title)}`);
            console.log(`    ${c.muted(d.detail)}`);
            if (d.suggestion) console.log(`    ${c.info('→ ' + d.suggestion)}`);
        }
    });

    await gh.withGroup('ecswatch: root cause analysis', async () => {
        const analysis = await rootCause({
            service: svc,
            diagnostics,
            stoppedTasks: stoppedForAnalysis,
            targetHealth: tgHealth,
            recentLogs: logs,
        });
        const badge = analysis.source === 'llm'
            ? pill(`LLM · ${analysis.model ?? '?'}`, 'primary')
            : pill('HEURISTIC', 'warning');
        console.log(`  ${badge} ${c.muted(`(${analysis.elapsedMs}ms)`)}`);
        console.log(`  ${c.accent('SUMMARY:')} ${c.fg(analysis.summary)}`);
        if (analysis.likelyCauses.length > 0) {
            console.log(`  ${c.accent('CAUSES:')}`);
            for (const cause of analysis.likelyCauses) console.log(`    ${c.warning('•')} ${c.fg(cause)}`);
        }
        if (analysis.suggestedFixes.length > 0) {
            console.log(`  ${c.accent('FIXES:')}`);
            for (const fix of analysis.suggestedFixes) console.log(`    ${c.success('•')} ${c.fg(fix)}`);
        }
    });
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await fn();
    } catch {
        return fallback;
    }
}
