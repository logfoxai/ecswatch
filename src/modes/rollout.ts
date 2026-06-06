// Pure rollout-outcome decision logic, split out from the CI poll loop so it
// can be unit-tested without AWS. Given a service snapshot + what we've observed
// so far, decide whether the rollout is still pending, succeeded, or failed.
//
// The subtle case this exists for: the ECS deployment circuit breaker. When a
// new deployment can't start, ECS marks it FAILED and (if rollback is enabled)
// spins up a rollback deployment on the previous task-def that then reaches
// steady state. If you only watch the PRIMARY deployment's rolloutState, you
// see it go COMPLETED and wrongly report success — which is exactly how a failed
// deploy slips through CI as green.

import type {ServiceSnapshot} from '../types.js';

export type RolloutOutcome =
    | {kind: 'pending'}
    | {kind: 'success'; taskDefinition: string}
    | {kind: 'failed'; reason: string};

export interface RolloutWatchState {
    /**
     * True once we've observed the PRIMARY deployment IN_PROGRESS. Guards against
     * treating a stale, pre-existing FAILED/old deployment as *our* failure.
     */
    sawInProgress: boolean;
    /**
     * The task-def ARN we expect the rollout to land on (the new revision).
     * If PRIMARY settles on anything else, the circuit breaker rolled us back.
     */
    targetTaskDefinitionArn?: string;
}

function shortArn(arn: string): string {

    return arn.split('/').pop() ?? arn;

}

export function evaluateRollout(svc: ServiceSnapshot, state: RolloutWatchState): RolloutOutcome {

    const primary = svc.deployments.find((d) => d.status === 'PRIMARY');

    if (!primary) return {kind: 'pending'};

    if (state.sawInProgress) {

        // Any deployment in a FAILED rollout state means the rollout failed —
        // e.g. the circuit breaker tripped on the new deployment while a
        // rollback deployment is taking over as PRIMARY.
        const failed = svc.deployments.find((d) => d.rolloutState === 'FAILED');

        if (failed) {

            return {
                kind: 'failed',
                reason: failed.rolloutStateReason
                    || `deployment ${failed.taskDefinition} failed to reach steady state`,
            };

}

}

    if (primary.rolloutState === 'COMPLETED' && state.sawInProgress) {

        // PRIMARY completed — but on a *different* task-def than the one we were
        // deploying means the circuit breaker already rolled back and cleaned up
        // the failed deployment. Still a failure.
        if (state.targetTaskDefinitionArn
            && primary.taskDefinitionArn !== state.targetTaskDefinitionArn) {

            return {
                kind: 'failed',
                reason: `rolled back: PRIMARY settled on ${primary.taskDefinition}, expected `
                    + `${shortArn(state.targetTaskDefinitionArn)} (deployment circuit breaker)`,
            };

}

        return {kind: 'success', taskDefinition: primary.taskDefinition};

}

    return {kind: 'pending'};

}
