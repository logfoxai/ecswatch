import {test} from 'kizu';

import {evaluateRollout} from './rollout.js';
import type {DeploymentSnapshot, DeploymentStatus, RolloutState, ServiceSnapshot} from '../types.js';

function dep(
    status: DeploymentStatus,
    rolloutState: RolloutState,
    taskDefinitionArn: string,
    rolloutStateReason = '',
): DeploymentSnapshot {

    return {
        id: taskDefinitionArn,
        status,
        taskDefinition: taskDefinitionArn.split('/').pop() ?? taskDefinitionArn,
        taskDefinitionArn,
        desiredCount: 1,
        runningCount: rolloutState === 'COMPLETED' ? 1 : 0,
        pendingCount: 0,
        failedTasks: 0,
        rolloutState,
        rolloutStateReason,
        createdAt: null,
        updatedAt: null,
    };

}

function svc(deployments: DeploymentSnapshot[]): ServiceSnapshot {

    return {
        serviceName: 'hermes',
        serviceArn: '',
        clusterName: 'platform-prod-fargate',
        region: 'us-east-2',
        status: 'ACTIVE',
        desiredCount: 1,
        runningCount: 1,
        pendingCount: 0,
        primaryTaskDefinition: '',
        primaryTaskDefinitionArn: '',
        launchType: 'FARGATE',
        platformVersion: null,
        capacityProviderStrategy: [],
        deployments,
        events: [],
        targetGroupArns: [],
        loadBalancerNames: [],
        fetchedAt: new Date(),
    };

}

const NEW = 'arn:aws:ecs:us-east-2:1:task-definition/hermes:5';
const OLD = 'arn:aws:ecs:us-east-2:1:task-definition/hermes:3';

test('evaluateRollout is pending while PRIMARY is IN_PROGRESS', (assert) => {

    const outcome = evaluateRollout(svc([dep('PRIMARY', 'IN_PROGRESS', NEW)]), {
        sawInProgress: true,
        targetTaskDefinitionArn: NEW,
    });

    assert.equal(outcome.kind, 'pending');

});

test('evaluateRollout succeeds when PRIMARY completes on the target task-def', (assert) => {

    const outcome = evaluateRollout(svc([dep('PRIMARY', 'COMPLETED', NEW)]), {
        sawInProgress: true,
        targetTaskDefinitionArn: NEW,
    });

    assert.equal(outcome, {kind: 'success', taskDefinition: 'hermes:5'});

});

test('evaluateRollout fails when PRIMARY rollout state is FAILED', (assert) => {

    const outcome = evaluateRollout(svc([dep('PRIMARY', 'FAILED', NEW, 'tasks failed to start')]), {
        sawInProgress: true,
        targetTaskDefinitionArn: NEW,
    });

    assert.equal(outcome, {kind: 'failed', reason: 'tasks failed to start'});

});

test('evaluateRollout fails on circuit-breaker rollback (failed deployment still listed)', (assert) => {

    // New deployment failed; rollback deployment on the OLD task-def is becoming
    // PRIMARY and will reach steady state. This must be a failure, not success.
    const outcome = evaluateRollout(svc([
        dep('PRIMARY', 'IN_PROGRESS', OLD),
        dep('ACTIVE', 'FAILED', NEW, 'circuit breaker triggered'),
    ]), {sawInProgress: true, targetTaskDefinitionArn: NEW});

    assert.equal(outcome, {kind: 'failed', reason: 'circuit breaker triggered'});

});

test('evaluateRollout fails when PRIMARY settles on a non-target task-def (rollback cleaned up)', (assert) => {

    // The failed deployment is already gone; only the rolled-back PRIMARY remains,
    // COMPLETED on the OLD task-def. Detect via the target mismatch.
    const outcome = evaluateRollout(svc([dep('PRIMARY', 'COMPLETED', OLD)]), {
        sawInProgress: true,
        targetTaskDefinitionArn: NEW,
    });

    assert.equal(outcome.kind, 'failed');

});

test('evaluateRollout does not fail on a stale FAILED deployment before we saw IN_PROGRESS', (assert) => {

    const outcome = evaluateRollout(svc([
        dep('PRIMARY', 'COMPLETED', OLD),
        dep('ACTIVE', 'FAILED', NEW),
    ]), {sawInProgress: false, targetTaskDefinitionArn: NEW});

    assert.equal(outcome.kind, 'pending');

});
