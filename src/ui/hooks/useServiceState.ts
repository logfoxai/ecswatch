// Single source of truth for the TUI. Polls ECS describe-services on a
// timer, tracks new vs seen events, lazily loads stopped tasks + target
// health + task definition log group, and exposes a stable snapshot to
// the UI.
//
// We keep this hook in plain TS (no TSX) so it's easy to unit test
// without spinning up Ink's React reconciler.

import {useEffect, useMemo, useRef, useState, useCallback} from 'react';

import {describeService, getRecentStoppedTasks, listTasksDetailed, primaryDeployment, describeTaskDef} from '../../aws/ecs.js';
import {describeTargetHealth} from '../../aws/elb.js';
import {analyze} from '../../analyze/diagnostics.js';
import {rootCause} from '../../analyze/rootCause.js';
import type {
    CliContext,
    DeploymentSnapshot,
    Diagnostic,
    LogLine,
    RootCauseAnalysis,
    ServiceSnapshot,
    TargetHealthSnapshot,
    TaskSnapshot,
} from '../../types.js';

export interface ServiceState {
    loading: boolean;
    error: string | null;
    /** True when we have at least one successful describe-services response. */
    hasInitialData: boolean;
    service: ServiceSnapshot | null;
    runningTasks: TaskSnapshot[];
    stoppedTasks: TaskSnapshot[];
    targetHealth: TargetHealthSnapshot[];
    diagnostics: Diagnostic[];
    rootCauseAnalysis: RootCauseAnalysis | null;
    rootCauseLoading: boolean;
    lastFetchedAt: Date | null;
    logGroup: string | null;
    /** Manual refresh; returns when the next refresh resolves. */
    refresh: () => Promise<void>;
    /** Re-run the LLM/heuristic root-cause analysis on demand. */
    refreshRootCause: (recentLogs: LogLine[]) => Promise<void>;
}

interface Options {
    pollIntervalMs?: number;
}

export function useServiceState(ctx: CliContext, opts: Options = {}): ServiceState {

    const intervalMs = opts.pollIntervalMs ?? 5_000;

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [hasInitialData, setHasInitialData] = useState(false);
    const [service, setService] = useState<ServiceSnapshot | null>(null);
    const [runningTasks, setRunningTasks] = useState<TaskSnapshot[]>([]);
    const [stoppedTasks, setStoppedTasks] = useState<TaskSnapshot[]>([]);
    const [targetHealth, setTargetHealth] = useState<TargetHealthSnapshot[]>([]);
    const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
    const [rootCauseAnalysis, setRootCauseAnalysis] = useState<RootCauseAnalysis | null>(null);
    const [rootCauseLoading, setRootCauseLoading] = useState(false);
    const [logGroup, setLogGroup] = useState<string | null>(ctx.logGroup);
    const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null);

    const mounted = useRef(true);
    const inFlight = useRef(false);

    const refresh = useCallback(async () => {

        if (inFlight.current) return;
        inFlight.current = true;
        try {

            const svc = await describeService(ctx.region, ctx.cluster, ctx.service);

            if (!mounted.current) return;
            setService(svc);
            setError(null);
            setHasInitialData(true);
            setLastFetchedAt(new Date());

            // Fan out the secondary queries; failures here shouldn't surface as
            // an error banner — they degrade gracefully (empty arrays).
            const [running, stopped, tgHealth, td] = await Promise.all([
                safe(() => listTasksDetailed(ctx.region, ctx.cluster, ctx.service, {desiredStatus: 'RUNNING'}, svc.primaryTaskDefinitionArn), []),
                safe(
                    () => getRecentStoppedTasks(ctx.region, ctx.cluster, ctx.service, svc.primaryTaskDefinitionArn),
                    [],
                ),
                safe(() => describeTargetHealth(ctx.region, svc.targetGroupArns), []),
                logGroup
                    ? Promise.resolve(null)
                    : safe(() => describeTaskDef(ctx.region, svc.primaryTaskDefinitionArn), null),
            ]);

            if (!mounted.current) return;
            setRunningTasks(running);
            setStoppedTasks(stopped);
            setTargetHealth(tgHealth);
            if (td?.logGroup && !logGroup) setLogGroup(td.logGroup);

            const diag = analyze({service: svc, runningTasks: running, stoppedTasks: stopped, targetHealth: tgHealth});

            setDiagnostics(diag);

} catch (err) {

            if (!mounted.current) return;
            setError(err instanceof Error ? err.message : String(err));

} finally {

            inFlight.current = false;
            if (mounted.current) setLoading(false);

}

}, [ctx.region, ctx.cluster, ctx.service, logGroup]);

    const refreshRootCause = useCallback(async (recentLogs: LogLine[]) => {

        if (!service) return;
        setRootCauseLoading(true);
        try {

            const analysis = await rootCause({
                service,
                diagnostics,
                stoppedTasks,
                targetHealth,
                recentLogs,
            });

            if (mounted.current) setRootCauseAnalysis(analysis);

} finally {

            if (mounted.current) setRootCauseLoading(false);

}

}, [service, diagnostics, stoppedTasks, targetHealth]);

    useEffect(() => {

        mounted.current = true;
        void refresh();
        const id = setInterval(() => {

 void refresh();

}, intervalMs);

        return () => {

            mounted.current = false;
            clearInterval(id);

};

}, [refresh, intervalMs]);

    return useMemo<ServiceState>(() => ({
        loading,
        error,
        hasInitialData,
        service,
        runningTasks,
        stoppedTasks,
        targetHealth,
        diagnostics,
        rootCauseAnalysis,
        rootCauseLoading,
        lastFetchedAt,
        logGroup,
        refresh,
        refreshRootCause,
    }), [
        loading, error, hasInitialData, service, runningTasks, stoppedTasks, targetHealth, diagnostics,
        rootCauseAnalysis, rootCauseLoading, lastFetchedAt, logGroup, refresh, refreshRootCause,
    ]);

}

function primary(svc: ServiceSnapshot | null): DeploymentSnapshot | null | undefined {

    return svc ? primaryDeployment(svc) : null;

}

export {primary as primaryFromSnapshot};

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {

    try {

        return await fn();

} catch {

        return fallback;

}

}
