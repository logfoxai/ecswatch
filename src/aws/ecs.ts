// ECS data access. This is the single boundary between AWS SDK shapes and
// ecswatch's normalized snapshot types. Every UI/CI module talks to these
// helpers instead of raw SDK clients so we have one place to:
//
//   - default optional fields,
//   - sort/limit results,
//   - and classify events into a stable severity scheme.

import {
    DescribeServicesCommand,
    DescribeTaskDefinitionCommand,
    DescribeTasksCommand,
    ListClustersCommand,
    ListServicesCommand,
    ListTasksCommand,
    type DescribeServicesCommandOutput,
    type Service,
    type Task,
} from '@aws-sdk/client-ecs';

import {ecs} from './clients.js';
import type {
    DeploymentSnapshot,
    DeploymentStatus,
    RolloutState,
    ServiceEventSnapshot,
    ServiceSnapshot,
    TaskSnapshot,
} from '../types.js';

const KNOWN_ROLLOUT_STATES = new Set<RolloutState>(['IN_PROGRESS', 'COMPLETED', 'FAILED', 'UNKNOWN']);

function asRolloutState(raw: string | undefined): RolloutState {

    if (!raw) return 'UNKNOWN';
    return KNOWN_ROLLOUT_STATES.has(raw as RolloutState) ? (raw as RolloutState) : 'UNKNOWN';

}

function truncTd(arn: string | undefined): {family: string; full: string} {

    if (!arn) return {family: '?', full: ''};
    const tail = arn.split('/').pop() ?? arn;

    return {family: tail, full: arn};

}

function classifyEvent(message: string): ServiceEventSnapshot['severity'] {

    const m = message.toLowerCase();

    if (m.includes('failed') || m.includes('unhealthy') || m.includes('error')
        || m.includes('unable to') || m.includes('cannotpull') || m.includes('out of memory')) {

        return 'error';

}
    if (m.includes('stopped') || m.includes('draining') || m.includes('deregistered')) {

        return 'warn';

}
    if (m.includes('has started') || m.includes('registered')
        || m.includes('reached a steady state') || m.includes('has completed')) {

        return 'success';

}
    return 'info';

}

function normalizeService(svc: Service, region: string): ServiceSnapshot {

    const primary = (svc.deployments ?? []).find((d) => d.status === 'PRIMARY');
    const td = truncTd(primary?.taskDefinition ?? svc.taskDefinition);
    const events: ServiceEventSnapshot[] = (svc.events ?? []).map((e) => ({
        id: e.id ?? `${e.createdAt?.toISOString() ?? ''}-${(e.message ?? '').slice(0, 16)}`,
        createdAt: e.createdAt ?? new Date(0),
        message: e.message ?? '',
        severity: classifyEvent(e.message ?? ''),
    }));
    const deployments: DeploymentSnapshot[] = (svc.deployments ?? []).map((d) => {

        const dtd = truncTd(d.taskDefinition);

        return {
            id: d.id ?? '',
            status: (d.status ?? 'INACTIVE') as DeploymentStatus,
            taskDefinition: dtd.family,
            taskDefinitionArn: dtd.full,
            desiredCount: d.desiredCount ?? 0,
            runningCount: d.runningCount ?? 0,
            pendingCount: d.pendingCount ?? 0,
            failedTasks: d.failedTasks ?? 0,
            rolloutState: asRolloutState(d.rolloutState),
            rolloutStateReason: d.rolloutStateReason ?? '',
            createdAt: d.createdAt ?? null,
            updatedAt: d.updatedAt ?? null,
        };

});

    return {
        serviceName: svc.serviceName ?? '?',
        serviceArn: svc.serviceArn ?? '',
        clusterName: (svc.clusterArn ?? '').split('/').pop() ?? '?',
        region,
        status: svc.status ?? 'UNKNOWN',
        desiredCount: svc.desiredCount ?? 0,
        runningCount: svc.runningCount ?? 0,
        pendingCount: svc.pendingCount ?? 0,
        primaryTaskDefinition: td.family,
        primaryTaskDefinitionArn: td.full,
        launchType: svc.launchType ?? '',
        platformVersion: svc.platformVersion ?? null,
        capacityProviderStrategy:
            (svc.capacityProviderStrategy ?? []).map((s) => `${s.capacityProvider ?? '?'}:${s.weight ?? 0}`),
        deployments,
        events,
        targetGroupArns: (svc.loadBalancers ?? [])
            .map((lb) => lb.targetGroupArn)
            .filter((a): a is string => Boolean(a)),
        loadBalancerNames: (svc.loadBalancers ?? [])
            .map((lb) => lb.loadBalancerName)
            .filter((n): n is string => Boolean(n)),
        fetchedAt: new Date(),
    };

}

export async function describeService(
    region: string,
    cluster: string,
    service: string,
): Promise<ServiceSnapshot> {

    const out: DescribeServicesCommandOutput = await ecs(region).send(
        new DescribeServicesCommand({cluster, services: [service]}),
    );
    const svc = out.services?.[0];

    if (!svc || svc.status === 'MISSING') {

        throw new Error(
            `ECS service "${service}" not found on cluster "${cluster}" (${region}). `
            + 'Check the service name, --cluster, your region, and AWS credentials.',
        );

}
    return normalizeService(svc, region);

}

export interface TaskListOptions {
    /** Limit to a specific deployment id (handy when isolating the PRIMARY tasks). */
    startedBy?: string;
    /** RUNNING | PENDING | STOPPED — STOPPED is a separate ECS API surface. */
    desiredStatus?: 'RUNNING' | 'PENDING' | 'STOPPED';
}

export async function listTasksDetailed(
    region: string,
    cluster: string,
    service: string,
    opts: TaskListOptions = {},
    primaryTaskDefArn?: string,
): Promise<TaskSnapshot[]> {

    const list = await ecs(region).send(new ListTasksCommand({
        cluster,
        serviceName: service,
        startedBy: opts.startedBy,
        desiredStatus: opts.desiredStatus,
    }));
    const arns = list.taskArns ?? [];

    if (arns.length === 0) return [];
    const detail = await ecs(region).send(new DescribeTasksCommand({
        cluster,
        tasks: arns,
    }));

    return (detail.tasks ?? []).map((t) => normalizeTask(t, primaryTaskDefArn));

}

function normalizeTask(t: Task, primaryTdArn?: string): TaskSnapshot {

    const arn = t.taskArn ?? '';
    const shortId = arn.split('/').pop()?.slice(-12) ?? '';
    const tdArn = t.taskDefinitionArn ?? '';
    const td = truncTd(tdArn);

    return {
        arn,
        shortId,
        taskDefinitionArn: tdArn,
        taskDefinition: td.family,
        lastStatus: t.lastStatus ?? 'UNKNOWN',
        desiredStatus: t.desiredStatus ?? 'UNKNOWN',
        healthStatus: t.healthStatus ?? 'UNKNOWN',
        cpu: t.cpu ?? '',
        memory: t.memory ?? '',
        startedAt: t.startedAt ?? null,
        createdAt: t.createdAt ?? null,
        stoppedAt: t.stoppedAt ?? null,
        stoppedReason: t.stoppedReason ?? null,
        stopCode: t.stopCode ?? null,
        availabilityZone: t.availabilityZone ?? null,
        connectivity: t.connectivity ?? null,
        containers: (t.containers ?? []).map((c) => ({
            name: c.name ?? '',
            image: c.image ?? '',
            lastStatus: c.lastStatus ?? '',
            healthStatus: c.healthStatus ?? null,
            exitCode: c.exitCode ?? null,
            reason: c.reason ?? null,
            runtimeId: c.runtimeId ?? null,
        })),
        onPrimaryDeployment: primaryTdArn !== undefined && tdArn === primaryTdArn,
    };

}

export async function getRecentStoppedTasks(
    region: string,
    cluster: string,
    service: string,
    primaryTdArn?: string,
): Promise<TaskSnapshot[]> {

    return listTasksDetailed(region, cluster, service, {desiredStatus: 'STOPPED'}, primaryTdArn);

}

export async function describeTaskDef(region: string, arn: string): Promise<{
    family: string;
    revision: number;
    cpu: string;
    memory: string;
    runtimePlatform: string;
    containers: {name: string; image: string; environment: {name: string; value: string}[]}[];
    logGroup: string | null;
}> {

    const out = await ecs(region).send(new DescribeTaskDefinitionCommand({taskDefinition: arn}));
    const td = out.taskDefinition;

    if (!td) throw new Error(`Task definition not found: ${arn}`);
    const containers = (td.containerDefinitions ?? []).map((c) => ({
        name: c.name ?? '',
        image: c.image ?? '',
        environment: (c.environment ?? [])
            .map((e) => ({name: e.name ?? '', value: e.value ?? ''}))
            .filter((e) => e.name),
    }));
    const firstWithLogs = (td.containerDefinitions ?? []).find((c) => c.logConfiguration?.options?.['awslogs-group']);
    const logGroup = firstWithLogs?.logConfiguration?.options?.['awslogs-group'] ?? null;

    return {
        family: td.family ?? '?',
        revision: td.revision ?? 0,
        cpu: td.cpu ?? '?',
        memory: td.memory ?? '?',
        runtimePlatform: `${td.runtimePlatform?.operatingSystemFamily ?? 'LINUX'}/${td.runtimePlatform?.cpuArchitecture ?? 'X86_64'}`,
        containers,
        logGroup,
    };

}

/** Convenience: fetch the PRIMARY deployment from a service snapshot. */
export function primaryDeployment(svc: ServiceSnapshot): DeploymentSnapshot | undefined {

    return svc.deployments.find((d) => d.status === 'PRIMARY');

}

// ---------------------------------------------------------------------------
// Cluster / service discovery (used by the cluster resolver)
// ---------------------------------------------------------------------------

/** All cluster *names* in the account/region (paginated). */
export async function listAllClusters(region: string): Promise<string[]> {

    const names: string[] = [];
    let nextToken: string | undefined;

    do {

        const out = await ecs(region).send(new ListClustersCommand({nextToken}));

        for (const arn of out.clusterArns ?? []) {

            const name = arn.split('/').pop();

            if (name) names.push(name);

}
        nextToken = out.nextToken;

} while (nextToken);
    return names;

}

/**
 * All service *names* in a cluster (paginated). Service ARNs look like
 * `arn:aws:ecs:<region>:<acct>:service/<cluster>/<service>` (or the older
 * `.../service/<service>`), so the trailing path segment is always the name.
 */
export async function listAllServices(region: string, cluster: string): Promise<string[]> {

    const names: string[] = [];
    let nextToken: string | undefined;

    do {

        const out = await ecs(region).send(new ListServicesCommand({cluster, nextToken, maxResults: 100}));

        for (const arn of out.serviceArns ?? []) {

            const name = arn.split('/').pop();

            if (name) names.push(name);

}
        nextToken = out.nextToken;

} while (nextToken);
    return names;

}
