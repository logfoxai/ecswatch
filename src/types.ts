// Shared types for ecswatch. We deliberately keep these dependency-free —
// the AWS SDK types leak too much (optional everywhere, nullable in odd
// places) and we don't want every UI component juggling `?? ''`. The
// `aws/ecs.ts` boundary normalizes SDK responses into these shapes.

export type RolloutState =
    | 'IN_PROGRESS'
    | 'COMPLETED'
    | 'FAILED'
    | 'UNKNOWN';

export type DeploymentStatus = 'PRIMARY' | 'ACTIVE' | 'INACTIVE';

export interface DeploymentSnapshot {
    id: string;
    status: DeploymentStatus;
    /** Truncated task-definition family:revision (e.g. `phone-audit:142`). */
    taskDefinition: string;
    /** Full task-definition ARN — used by the orchestrator. */
    taskDefinitionArn: string;
    desiredCount: number;
    runningCount: number;
    pendingCount: number;
    failedTasks: number;
    rolloutState: RolloutState;
    rolloutStateReason: string;
    createdAt: Date | null;
    updatedAt: Date | null;
    /** Container image of the `app` (or configured) container, if resolvable. */
    image?: string;
}

export interface ServiceEventSnapshot {
    id: string;
    createdAt: Date;
    message: string;
    /** Categorised severity for color choice + grouping. */
    severity: 'info' | 'warn' | 'error' | 'success';
}

export interface ServiceSnapshot {
    serviceName: string;
    serviceArn: string;
    clusterName: string;
    region: string;
    status: string;
    desiredCount: number;
    runningCount: number;
    pendingCount: number;
    primaryTaskDefinition: string;
    primaryTaskDefinitionArn: string;
    launchType: string;
    platformVersion: string | null;
    capacityProviderStrategy: string[];
    deployments: DeploymentSnapshot[];
    events: ServiceEventSnapshot[];
    targetGroupArns: string[];
    loadBalancerNames: string[];
    fetchedAt: Date;
}

export interface TaskSnapshot {
    arn: string;
    /** Short id (last 8 chars of the task uuid). */
    shortId: string;
    taskDefinitionArn: string;
    taskDefinition: string;
    lastStatus: string;
    desiredStatus: string;
    healthStatus: string;
    cpu: string;
    memory: string;
    startedAt: Date | null;
    createdAt: Date | null;
    stoppedAt: Date | null;
    stoppedReason: string | null;
    stopCode: string | null;
    availabilityZone: string | null;
    connectivity: string | null;
    containers: ContainerSnapshot[];
    /** True when the task belongs to the current PRIMARY deployment. */
    onPrimaryDeployment: boolean;
}

export interface ContainerSnapshot {
    name: string;
    image: string;
    lastStatus: string;
    healthStatus: string | null;
    exitCode: number | null;
    reason: string | null;
    runtimeId: string | null;
}

export interface TargetHealthSnapshot {
    targetGroupArn: string;
    targetGroupName: string;
    targets: Array<{
        id: string;
        port: number | null;
        state: string;
        reason: string | null;
        description: string | null;
    }>;
}

export interface LogLine {
    timestamp: Date;
    message: string;
    stream: string;
    /** A best-effort category derived from the message — colored in UI. */
    severity: 'info' | 'warn' | 'error' | 'debug';
}

export interface Diagnostic {
    id: string;
    severity: 'info' | 'warn' | 'error';
    /** Short headline (e.g. `Image pull failure`). */
    title: string;
    /** Longer detail with context (event message, exit code, etc.). */
    detail: string;
    /** Heuristic suggestion text — distinct from LLM analysis below. */
    suggestion?: string;
    /** Refs to the source data so UI can link / focus. */
    sourceEventIds?: string[];
    sourceTaskArns?: string[];
}

export interface RootCauseAnalysis {
    /** "llm" or "heuristic" — UI shows a small badge. */
    source: 'llm' | 'heuristic';
    /** Provider/model used when source = "llm". */
    model?: string;
    summary: string;
    likelyCauses: string[];
    suggestedFixes: string[];
    /** Latency of the analysis call (ms). */
    elapsedMs: number;
}

export interface CliContext {
    service: string;
    cluster: string;
    region: string;
    containerName: string;
    logGroup: string | null;
}
