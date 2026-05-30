// Rich snapshot mode (`ecswatch inspect <service>` or
// `ecswatch watch <service> --once`). Pulls everything we know about it in
// parallel and prints a tabular report.
//
// Layout follows the `kubectl get` / `docker ps` / `top` convention:
// muted uppercase column headers, one record per line, fixed-width
// columns, no decorative chrome (no `━━━` dividers, no bullets in tables).
// Use colored *text* (not background pills) inside tables — pills break
// column alignment and overwhelm the eye when there's lots of data.

import {describeService, getRecentStoppedTasks, listTasksDetailed, describeTaskDef} from '../aws/ecs.js';
import {tail as tailLogs} from '../aws/logs.js';
import {describeTargetHealth} from '../aws/elb.js';
import {analyze} from '../analyze/diagnostics.js';
import {rootCause} from '../analyze/rootCause.js';
import {c} from '../theme.js';
import {table, termWidth, trunc, type Column} from '../format/table.js';
import type {CliContext, DeploymentSnapshot, Diagnostic, LogLine, RootCauseAnalysis, ServiceEventSnapshot, ServiceSnapshot, TargetHealthSnapshot, TaskSnapshot} from '../types.js';

export interface SnapshotOptions {
    /** Also tail N recent log lines (default 0 — logs are noisy in snapshot mode). */
    logLines?: number;
    /** Skip the LLM root cause call even if keys are configured. */
    noLlm?: boolean;
}

export async function runSnapshot(ctx: CliContext, opts: SnapshotOptions = {}): Promise<number> {
    let svc: ServiceSnapshot;
    try {
        svc = await describeService(ctx.region, ctx.cluster, ctx.service);
    } catch (err) {
        console.error(c.error(err instanceof Error ? err.message : String(err)));
        return 1;
    }

    const [running, stopped, tgHealth, taskDef] = await Promise.all([
        safe(() => listTasksDetailed(ctx.region, ctx.cluster, ctx.service, {desiredStatus: 'RUNNING'}, svc.primaryTaskDefinitionArn), [] as TaskSnapshot[]),
        safe(() => getRecentStoppedTasks(ctx.region, ctx.cluster, ctx.service, svc.primaryTaskDefinitionArn), [] as TaskSnapshot[]),
        safe(() => describeTargetHealth(ctx.region, svc.targetGroupArns), [] as TargetHealthSnapshot[]),
        safe(() => describeTaskDef(ctx.region, svc.primaryTaskDefinitionArn), null),
    ]);

    const logGroup = ctx.logGroup ?? taskDef?.logGroup ?? null;
    let logs: LogLine[] = [];
    if (logGroup && (opts.logLines ?? 0) > 0) {
        logs = await safe(() => tailLogs(ctx.region, logGroup, {limit: opts.logLines ?? 40, sinceMs: Date.now() - 30 * 60_000}), [] as LogLine[]);
    }

    printHeader(svc);
    section('DEPLOYMENTS');
    printDeployments(svc.deployments);
    section('TASKS');
    printTasks(running, stopped);
    if (tgHealth.length > 0) {
        section('TARGETS');
        printTargetHealth(tgHealth);
    }
    section('EVENTS', `${svc.events.length} most recent`);
    printEvents(svc.events.slice(0, 10));
    if (logs.length > 0) {
        section('LOGS', logGroup ?? undefined);
        printLogs(logs);
    }

    const diagnostics = analyze({service: svc, stoppedTasks: stopped, runningTasks: running, targetHealth: tgHealth});
    section('DIAGNOSTICS');
    printDiagnostics(diagnostics);

    const analysis = opts.noLlm
        ? heuristicOnly(svc, diagnostics)
        : await rootCause({service: svc, diagnostics, stoppedTasks: stopped, targetHealth: tgHealth, recentLogs: logs});
    section('ROOT CAUSE', `${analysis.source}${analysis.model ? ' · ' + analysis.model : ''} · ${analysis.elapsedMs}ms`);
    printRootCause(analysis);

    console.log('');

    return diagnostics.some((d) => d.severity === 'error') ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

function section(label: string, subtitle?: string): void {
    console.log('');
    const head = c.accent(label);
    if (subtitle) {
        console.log(`${head}  ${c.dim(subtitle)}`);
    } else {
        console.log(head);
    }
}

function printHeader(svc: ServiceSnapshot): void {
    console.log('');
    // line 1: identity. Avoid pills/badges here so the rest of the report can
    // use them sparingly and they still pop.
    const statusColor = svc.status === 'ACTIVE' ? c.success : svc.status === 'DRAINING' ? c.warning : c.error;
    console.log(`${c.accent(svc.serviceName)}  ${statusColor(svc.status)}  ${c.muted('on')}  ${c.fg(svc.clusterName)}  ${c.muted('(' + svc.region + ')')}`);
    // line 2: high-level counts + task def, kv style joined by ` · `.
    const sep = c.dim(' · ');
    const kvs: string[] = [
        kv('desired', c.fg(String(svc.desiredCount))),
        kv('running', svc.runningCount === svc.desiredCount ? c.success(String(svc.runningCount)) : c.warning(String(svc.runningCount))),
        kv('pending', svc.pendingCount > 0 ? c.pending(String(svc.pendingCount)) : c.dim('0')),
        kv('task def', c.fg(svc.primaryTaskDefinition)),
    ];
    console.log(kvs.join(sep));
    // line 3: launch info + targets.
    const meta: string[] = [];
    if (svc.launchType) meta.push(kv('launch', c.fg(svc.launchType + (svc.platformVersion ? ' ' + svc.platformVersion : ''))));
    if (svc.targetGroupArns.length > 0) {
        meta.push(kv('targets', c.fg(svc.targetGroupArns.map((a) => a.split('/').slice(-2, -1)[0] ?? a).join(', '))));
    }
    if (meta.length > 0) console.log(meta.join(sep));
}

function kv(label: string, value: string): string {
    return `${c.muted(label)} ${value}`;
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function printDeployments(deps: DeploymentSnapshot[]): void {
    if (deps.length === 0) {
        console.log(c.dim('  (no deployments)'));
        return;
    }

    const cols: Column<DeploymentSnapshot>[] = [
        {
            header: 'status',
            text: (d) => d.status,
            color: (d, t) => d.status === 'PRIMARY' ? c.primary(t) : d.status === 'ACTIVE' ? c.info(t) : c.muted(t),
        },
        {
            header: 'task def',
            text: (d) => d.taskDefinition,
            color: (_, t) => c.fg(t),
        },
        {
            header: 'rollout',
            text: (d) => d.rolloutState,
            color: (d, t) => colorRolloutText(d.rolloutState, t),
        },
        {header: 'run', text: (d) => String(d.runningCount), color: (_, t) => c.success(t), align: 'right'},
        {header: 'des', text: (d) => String(d.desiredCount), color: (_, t) => c.fg(t), align: 'right'},
        {header: 'pend', text: (d) => String(d.pendingCount), color: (d, t) => d.pendingCount > 0 ? c.pending(t) : c.dim(t), align: 'right'},
        {header: 'fail', text: (d) => String(d.failedTasks), color: (d, t) => d.failedTasks > 0 ? c.error(t) : c.dim(t), align: 'right'},
        {header: 'age', text: (d) => d.createdAt ? relTime(d.createdAt) : '—', color: (_, t) => c.muted(t), align: 'right'},
    ];
    for (const line of table(deps, cols)) console.log(line);

    // Per-deployment reason on its own dim line below the table — only when
    // it adds signal (skip the generic "completed" noise on healthy rollouts).
    for (const d of deps) {
        if (!d.rolloutStateReason) continue;
        if (d.rolloutState === 'COMPLETED' && /completed\.?$/i.test(d.rolloutStateReason)) continue;
        console.log(`  ${c.dim(d.status.toLowerCase() + ' →')} ${c.muted(d.rolloutStateReason)}`);
    }
}

function printTasks(running: TaskSnapshot[], stopped: TaskSnapshot[]): void {
    if (running.length === 0 && stopped.length === 0) {
        console.log(c.dim('  (no tasks)'));
        return;
    }

    if (running.length > 0) {
        const cols: Column<TaskSnapshot>[] = [
            {header: 'id', text: (t) => t.shortId, color: (_, t) => c.fg(t)},
            {
                header: 'gen',
                text: (t) => t.onPrimaryDeployment ? 'new' : 'old',
                color: (t, txt) => t.onPrimaryDeployment ? c.primary(txt) : c.warning(txt),
            },
            {header: 'task def', text: (t) => t.taskDefinition, color: (_, t) => c.fg(t)},
            {header: 'state', text: (t) => t.lastStatus, color: (t, txt) => colorTaskStateText(t.lastStatus, txt)},
            {header: 'health', text: (t) => t.healthStatus, color: (t, txt) => colorHealthText(t.healthStatus, txt)},
            {header: 'cpu', text: (t) => t.cpu || '—', color: (_, t) => c.muted(t), align: 'right'},
            {header: 'mem', text: (t) => t.memory || '—', color: (_, t) => c.muted(t), align: 'right'},
            {header: 'az', text: (t) => t.availabilityZone ?? '—', color: (_, t) => c.muted(t)},
            {header: 'uptime', text: (t) => t.startedAt ? relTime(t.startedAt) : '—', color: (_, t) => c.muted(t), align: 'right'},
        ];
        for (const line of table(running, cols)) console.log(line);
    }

    if (stopped.length > 0) {
        const recent = stopped.slice(0, 5);
        console.log('');
        console.log(`  ${c.warning('recently stopped')}  ${c.dim('(' + recent.length + ' of ' + stopped.length + ')')}`);
        const cols: Column<TaskSnapshot>[] = [
            {header: 'id', text: (t) => t.shortId, color: (_, t) => c.fg(t)},
            {header: 'task def', text: (t) => t.taskDefinition, color: (_, t) => c.fg(t)},
            {header: 'stop code', text: (t) => t.stopCode ?? '—', color: (_, t) => c.error(t)},
            {
                header: 'exits',
                text: (t) => t.containers.map((cn) => cn.exitCode === null ? '—' : String(cn.exitCode)).join(' '),
                color: (t, _) => t.containers.map((cn) =>
                    cn.exitCode === null ? c.dim('—')
                        : cn.exitCode === 0 ? c.success('0')
                            : c.error(String(cn.exitCode)),
                ).join(' '),
            },
            {header: 'stopped', text: (t) => t.stoppedAt ? relTime(t.stoppedAt) : '—', color: (_, t) => c.muted(t), align: 'right'},
        ];
        for (const line of table(recent, cols)) console.log(line);
        // Reasons are too long for a column; dump as a follow-up line per task.
        for (const t of recent) {
            if (!t.stoppedReason) continue;
            console.log(`  ${c.dim(t.shortId + ' →')} ${c.muted(trunc(t.stoppedReason, termWidth() - t.shortId.length - 6))}`);
        }
    }
}

function printTargetHealth(groups: TargetHealthSnapshot[]): void {
    const rows = groups.map((g) => {
        const counts: Record<string, number> = {healthy: 0, unhealthy: 0, draining: 0, initial: 0, unused: 0};
        for (const t of g.targets) counts[t.state] = (counts[t.state] ?? 0) + 1;
        return {group: g, counts};
    });
    const cols: Column<typeof rows[number]>[] = [
        {header: 'group', text: (r) => r.group.targetGroupName, color: (_, t) => c.fg(t)},
        {header: 'total', text: (r) => String(r.group.targets.length), color: (_, t) => c.fg(t), align: 'right'},
        {header: 'healthy', text: (r) => String(r.counts.healthy ?? 0), color: (r, t) => (r.counts.healthy ?? 0) > 0 ? c.success(t) : c.dim(t), align: 'right'},
        {header: 'unhealthy', text: (r) => String(r.counts.unhealthy ?? 0), color: (r, t) => (r.counts.unhealthy ?? 0) > 0 ? c.error(t) : c.dim(t), align: 'right'},
        {header: 'draining', text: (r) => String(r.counts.draining ?? 0), color: (r, t) => (r.counts.draining ?? 0) > 0 ? c.warning(t) : c.dim(t), align: 'right'},
        {header: 'initial', text: (r) => String(r.counts.initial ?? 0), color: (r, t) => (r.counts.initial ?? 0) > 0 ? c.pending(t) : c.dim(t), align: 'right'},
    ];
    for (const line of table(rows, cols)) console.log(line);

    // Per-unhealthy-target detail row, similar to `kubectl describe` events.
    for (const g of groups) {
        for (const t of g.targets) {
            if (t.state === 'healthy') continue;
            const id = `${t.id}${t.port ? ':' + t.port : ''}`;
            const reason = [t.reason, t.description].filter(Boolean).join(' — ');
            console.log(`  ${c.dim(g.targetGroupName + ' →')} ${c.fg(id)}  ${c.error(t.state)}${reason ? '  ' + c.muted(trunc(reason, 100)) : ''}`);
        }
    }
}

function printEvents(events: ServiceEventSnapshot[]): void {
    if (events.length === 0) {
        console.log(c.dim('  (no events)'));
        return;
    }
    // Cap message column to the remaining width so long ARNs don't wrap.
    const reserved = 2 /*indent*/ + 8 /*time*/ + 2 /*gap*/;
    const msgCap = Math.max(40, termWidth() - reserved - 1);
    const cols: Column<ServiceEventSnapshot>[] = [
        {header: 'time', text: (e) => e.createdAt.toISOString().slice(11, 19), color: (_, t) => c.dim(t)},
        {
            header: 'message',
            text: (e) => e.message,
            color: (e, t) => colorEventByText(e.severity, t),
            maxWidth: msgCap,
        },
    ];
    for (const line of table(events, cols)) console.log(line);
}

function printLogs(logs: LogLine[]): void {
    const reserved = 2 + 8 + 2;
    const msgCap = Math.max(40, termWidth() - reserved - 1);
    const cols: Column<LogLine>[] = [
        {header: 'time', text: (l) => l.timestamp.toISOString().slice(11, 19), color: (_, t) => c.dim(t)},
        {
            header: 'message',
            text: (l) => l.message,
            color: (l, t) => l.severity === 'error' ? c.error(t)
                : l.severity === 'warn' ? c.warning(t)
                    : l.severity === 'debug' ? c.dim(t) : c.fg(t),
            maxWidth: msgCap,
        },
    ];
    for (const line of table(logs, cols)) console.log(line);
}

function printDiagnostics(diagnostics: Diagnostic[]): void {
    if (diagnostics.length === 0) {
        console.log(`  ${c.success('●')} ${c.fg('No issues detected.')}`);
        return;
    }
    for (const d of diagnostics) {
        const dot = d.severity === 'error' ? c.error('●') : d.severity === 'warn' ? c.warning('●') : c.info('●');
        const label = d.severity === 'error' ? c.error('error')
            : d.severity === 'warn' ? c.warning('warn') : c.info('info');
        console.log(`  ${dot} ${label}  ${c.fg(d.title)}`);
        console.log(`    ${c.muted(trunc(d.detail, termWidth() - 6))}`);
        if (d.suggestion) console.log(`    ${c.info('→ ' + trunc(d.suggestion, termWidth() - 8))}`);
    }
}

function printRootCause(a: RootCauseAnalysis): void {
    console.log(`  ${c.fg(a.summary)}`);
    if (a.likelyCauses.length > 0) {
        console.log('');
        console.log(`  ${c.warning('causes')}`);
        for (const cause of a.likelyCauses) console.log(`    ${c.dim('·')} ${c.fg(cause)}`);
    }
    if (a.suggestedFixes.length > 0) {
        console.log('');
        console.log(`  ${c.success('fixes')}`);
        for (const fix of a.suggestedFixes) console.log(`    ${c.dim('·')} ${c.fg(fix)}`);
    }
}

// ---------------------------------------------------------------------------
// Misc colorers (text-only; never apply background colors here — tables
// need plain text in for measurement and color out for display)
// ---------------------------------------------------------------------------

function colorRolloutText(state: string, label: string): string {
    switch (state) {
        case 'COMPLETED': return c.success(label);
        case 'IN_PROGRESS': return c.rolling(label);
        case 'FAILED': return c.error(label);
        default: return c.muted(label);
    }
}

function colorTaskStateText(state: string, label: string): string {
    switch (state) {
        case 'RUNNING': return c.success(label);
        case 'PENDING':
        case 'PROVISIONING':
        case 'ACTIVATING': return c.pending(label);
        case 'STOPPED':
        case 'DEPROVISIONING':
        case 'DEACTIVATING': return c.warning(label);
        default: return c.muted(label);
    }
}

function colorHealthText(health: string, label: string): string {
    switch (health) {
        case 'HEALTHY': return c.success(label);
        case 'UNHEALTHY': return c.error(label);
        case 'UNKNOWN': return c.dim(label);
        default: return c.muted(label);
    }
}

function colorEventByText(severity: ServiceEventSnapshot['severity'], label: string): string {
    switch (severity) {
        case 'error': return c.error(label);
        case 'warn': return c.warning(label);
        case 'success': return c.success(label);
        case 'info':
        default: return c.info(label);
    }
}

function relTime(d: Date): string {
    const diff = Date.now() - d.getTime();
    const s = Math.round(diff / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;
}

function heuristicOnly(svc: ServiceSnapshot, diagnostics: Diagnostic[]): RootCauseAnalysis {
    const errors = diagnostics.filter((d) => d.severity === 'error');
    const warns = diagnostics.filter((d) => d.severity === 'warn');
    if (errors.length === 0 && warns.length === 0) {
        return {
            source: 'heuristic',
            summary: `${svc.serviceName} looks healthy — ${svc.runningCount}/${svc.desiredCount} running.`,
            likelyCauses: [],
            suggestedFixes: [],
            elapsedMs: 0,
        };
    }
    return {
        source: 'heuristic',
        summary: errors[0]?.title ?? warns[0]?.title ?? 'Service degraded.',
        likelyCauses: [...errors, ...warns].slice(0, 5).map((d) => `${d.title}: ${d.detail}`),
        suggestedFixes: [...errors, ...warns].map((d) => d.suggestion).filter((s): s is string => Boolean(s)).slice(0, 5),
        elapsedMs: 0,
    };
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
    try {
        return await fn();
    } catch {
        return fallback;
    }
}
