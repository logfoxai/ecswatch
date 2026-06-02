// Heuristic diagnostics. These pattern-match on the most common ECS rollout
// failure modes so the user gets a useful answer even when no LLM is
// configured. They're tuned for typical Fargate stacks (ARM64/Graviton or
// x86, ALB target groups, ECR images) so signals like the famous "Manifest
// does not contain descriptor matching platform" pull failure are caught
// with confidence.
//
// The output is plain `Diagnostic[]`. Anything that needs a free-form
// summary (e.g. "the new container exits 137 every 20s") delegates to
// the LLM module — see `rootCause.ts`.

import type {
    Diagnostic,
    ServiceEventSnapshot,
    ServiceSnapshot,
    TargetHealthSnapshot,
    TaskSnapshot,
} from '../types.js';

interface AnalyzeInput {
    service: ServiceSnapshot;
    stoppedTasks: TaskSnapshot[];
    runningTasks: TaskSnapshot[];
    targetHealth: TargetHealthSnapshot[];
}

/**
 * Run the heuristic battery and return a deduped, severity-sorted list.
 *
 * We err toward duplicating evidence into the `detail` field rather than
 * compressing — when the user is debugging at 2am, more context wins.
 */

export function analyze(input: AnalyzeInput): Diagnostic[] {

    const out: Diagnostic[] = [];
    const svc = input.service;
    const primary = svc.deployments.find((d) => d.status === 'PRIMARY');

    // ---- Rollout-level signals ------------------------------------------------
    if (primary?.rolloutState === 'FAILED') {

        out.push({
            id: 'rollout-failed',
            severity: 'error',
            title: 'Rollout marked FAILED',
            detail: primary.rolloutStateReason
                || 'ECS deployment circuit breaker tripped or the new task definition could not reach steady state.',
            suggestion: 'Inspect stopped tasks below for stopCode / exitCode and the most recent error events.',
        });

}
    if (primary && primary.failedTasks > 0) {

        out.push({
            id: 'rollout-failed-tasks',
            severity: 'error',
            title: `${primary.failedTasks} failed task${primary.failedTasks === 1 ? '' : 's'} on PRIMARY`,
            detail: `Deployment ${primary.taskDefinition} has ${primary.failedTasks} failed task(s); `
                + `desired=${primary.desiredCount} running=${primary.runningCount} pending=${primary.pendingCount}.`,
        });

}

    // Service-level "still rolling but standing still" — desired > running+pending
    // and PRIMARY has been around a while.
    if (primary && primary.rolloutState === 'IN_PROGRESS'
        && primary.runningCount + primary.pendingCount < primary.desiredCount
        && primary.createdAt && Date.now() - primary.createdAt.getTime() > 2 * 60_000) {

        out.push({
            id: 'rollout-stalled',
            severity: 'warn',
            title: 'Rollout has slots but no new tasks',
            detail: `PRIMARY deployment desired=${primary.desiredCount}, running+pending=`
                + `${primary.runningCount + primary.pendingCount}. ECS hasn't placed new tasks for `
                + `${Math.round((Date.now() - primary.createdAt.getTime()) / 1000)}s. Likely a capacity / `
                + 'placement constraint (Fargate subnet ENI exhaustion, missing capacity provider, or '
                + 'unsupported runtimePlatform).',
        });

}

    // ---- Event-level signals --------------------------------------------------
    out.push(...eventSignals(svc.events));

    // ---- Stopped task signals -------------------------------------------------
    out.push(...stoppedTaskSignals(input.stoppedTasks));

    // ---- Target group health --------------------------------------------------
    out.push(...targetGroupSignals(input.targetHealth));

    // Dedup by id, keep the first.
    const seen = new Set<string>();

    return out.filter((d) => {

        if (seen.has(d.id)) return false;
        seen.add(d.id);
        return true;

}).sort(severitySort);

}

function severitySort(a: Diagnostic, b: Diagnostic): number {

    const rank = (s: Diagnostic['severity']): number => (s === 'error' ? 0 : s === 'warn' ? 1 : 2);

    return rank(a.severity) - rank(b.severity);

}

function eventSignals(events: ServiceEventSnapshot[]): Diagnostic[] {

    const out: Diagnostic[] = [];

    // Walk newest -> oldest, only consider events in the last 30 minutes;
    // older noise is rarely actionable and just clutters the UI.
    const recent = events.filter((e) => Date.now() - e.createdAt.getTime() < 30 * 60_000);

    for (const e of recent) {

        const m = e.message.toLowerCase();

        if (m.includes('unable to consistently start tasks successfully')) {

            out.push({
                id: 'circuit-breaker-tripped',
                severity: 'error',
                title: 'Deployment circuit breaker tripped',
                detail: e.message,
                suggestion: 'ECS rolled back because it could not keep new tasks alive. Check container exit codes + logs immediately after task start.',
                sourceEventIds: [e.id],
            });

}

        if (m.includes('was unable to place a task')) {

            out.push({
                id: 'placement-failure',
                severity: 'error',
                title: 'Task placement failure',
                detail: e.message,
                suggestion: 'Fargate placement failures are usually subnet ENI exhaustion, '
                    + 'capacity-provider misconfiguration, or unsupported runtimePlatform. '
                    + 'For Fargate Spot capacity errors, retry — Spot isn\'t guaranteed.',
                sourceEventIds: [e.id],
            });

}

        if (m.includes('cannotpullcontainer') || m.includes('manifest does not contain')) {

            out.push({
                id: 'image-pull-failure',
                severity: 'error',
                title: 'Image pull / manifest failure',
                detail: e.message,
                suggestion: 'Check that the image exists and its architecture matches the task '
                    + '`runtimePlatform.cpuArchitecture`. Pushing an amd64 image to an ARM64/Graviton '
                    + 'task (or vice-versa) breaks the pull with a manifest mismatch.',
                sourceEventIds: [e.id],
            });

}

        if (m.includes('essential container in task exited')) {

            out.push({
                id: 'essential-container-exit',
                severity: 'error',
                title: 'Essential container exited',
                detail: e.message,
                suggestion: 'Inspect the recent stopped tasks below for exitCode + reason; tail container logs around the stop time.',
                sourceEventIds: [e.id],
            });

}

        if (m.includes('unhealthy') && m.includes('elb')) {

            out.push({
                id: 'elb-unhealthy',
                severity: 'error',
                title: 'ALB marked tasks unhealthy',
                detail: e.message,
                suggestion: 'Container is up but the ALB health check is failing. Verify the health-check path / port / status-code matcher matches what the app serves.',
                sourceEventIds: [e.id],
            });

}

        if (m.includes('no container instance met all of its requirements')) {

            out.push({
                id: 'no-instance-met',
                severity: 'error',
                title: 'No capacity matches task requirements',
                detail: e.message,
                suggestion: 'Task CPU/memory/architecture/AZ constraints exceed cluster capacity. On Fargate this is rare — check runtimePlatform.',
                sourceEventIds: [e.id],
            });

}

}

    return out;

}

function stoppedTaskSignals(tasks: TaskSnapshot[]): Diagnostic[] {

    const out: Diagnostic[] = [];

    // Limit to the last 5 stopped tasks; older runs are usually unrelated.
    const fresh = [...tasks]
        .sort((a, b) => (b.stoppedAt?.getTime() ?? 0) - (a.stoppedAt?.getTime() ?? 0))
        .slice(0, 5);

    for (const t of fresh) {

        const exits = t.containers.filter((c) => c.exitCode !== null && c.exitCode !== 0);

        for (const c of exits) {

            const oom = (t.stoppedReason ?? '').toLowerCase().includes('oom')
                || c.exitCode === 137;

            out.push({
                id: `task-exit-${t.shortId}-${c.name}`,
                severity: 'error',
                title: oom
                    ? `Container OOM-killed (exit ${c.exitCode}) on task ${t.shortId}`
                    : `Container exited ${c.exitCode} on task ${t.shortId}`,
                detail: `Container "${c.name}" stopped with exit ${c.exitCode}. `
                    + `Task reason: ${t.stoppedReason ?? 'unknown'}. `
                    + `Container reason: ${c.reason ?? 'none'}. `
                    + `Image: ${c.image}.`,
                suggestion: oom
                    ? 'Bump the task memory or fix a memory leak. ECS OOM is a hard kill (SIGKILL).'
                    : 'Tail the container logs in the time window around stoppedAt to find the crash.',
                sourceTaskArns: [t.arn],
            });

}

        // Some failures have no container exit code (e.g. ResourceInitializationError
        // before the container could even start). Capture those distinctly.
        if (exits.length === 0 && t.stopCode && t.stopCode !== 'EssentialContainerExited') {

            out.push({
                id: `task-stopcode-${t.shortId}`,
                severity: 'error',
                title: `Task ${t.shortId} stopped: ${t.stopCode}`,
                detail: t.stoppedReason ?? 'ECS provided no stoppedReason.',
                suggestion: stopCodeSuggestion(t.stopCode),
                sourceTaskArns: [t.arn],
            });

}

}

    return out;

}

function stopCodeSuggestion(code: string): string {

    switch (code) {

        case 'TaskFailedToStart':
            return 'ECS could not start the task. Most common: image pull failure, '
                + 'execution role missing perms, or invalid task definition. Check execution role + ECR.';
        case 'ResourceInitializationError':
            return 'Failed before the container ran. Usually IAM (execution role can\'t pull/log) or a secrets/SSM reference that doesn\'t resolve.';
        case 'ContainerRuntimeError':
            return 'Container runtime failed to launch — frequently an unsupported entrypoint or platform mismatch.';
        case 'SpotInterruption':
            return 'Fargate Spot reclaimed capacity. Retry; consider Fargate (on-demand) for hot path services.';
        case 'ServiceSchedulerInitiated':
            return 'Stopped intentionally by the scheduler — usually a deploy or scaling action.';
        case 'UserInitiated':
            return 'Someone (or an automation) stopped this task explicitly.';
        default:
            return 'Inspect the full stoppedReason for the underlying cause.';

}

}

function targetGroupSignals(groups: TargetHealthSnapshot[]): Diagnostic[] {

    const out: Diagnostic[] = [];

    for (const g of groups) {

        const unhealthy = g.targets.filter((t) => t.state === 'unhealthy');
        const draining = g.targets.filter((t) => t.state === 'draining');

        if (unhealthy.length > 0) {

            const reasons = [...new Set(unhealthy.map((t) => `${t.reason ?? '?'}: ${t.description ?? '?'}`))];

            out.push({
                id: `tg-unhealthy-${g.targetGroupName}`,
                severity: 'error',
                title: `${unhealthy.length} unhealthy target${unhealthy.length === 1 ? '' : 's'} in ${g.targetGroupName}`,
                detail: reasons.join(' | '),
                suggestion: unhealthy.some((t) => (t.reason ?? '').includes('FailedHealthChecks'))
                    ? 'Container is reachable but the health check endpoint is returning non-200. Verify the app started and is serving the health path.'
                    : 'Target may not be reachable from the ALB security group — check ingress + container port.',
            });

}
        if (draining.length > 0) {

            out.push({
                id: `tg-draining-${g.targetGroupName}`,
                severity: 'info',
                title: `${draining.length} draining target${draining.length === 1 ? '' : 's'} in ${g.targetGroupName}`,
                detail: 'Normal during a deployment — old tasks finishing in-flight requests before stopping.',
            });

}

}
    return out;

}
