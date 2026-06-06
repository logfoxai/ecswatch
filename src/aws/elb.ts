// ALB target group health. We use this both for the snapshot view and
// for diagnosing "service is rolling but tasks keep flapping" failures —
// target health reasons (Target.Timeout, Target.FailedHealthChecks, etc.)
// are the most actionable signal when the container starts but the LB
// won't promote it.

import {
    DescribeTargetGroupsCommand,
    DescribeTargetHealthCommand,
} from '@aws-sdk/client-elastic-load-balancing-v2';

import {elb} from './clients.js';
import type {TargetHealthSnapshot} from '../types.js';

export async function describeTargetHealth(
    region: string,
    targetGroupArns: string[],
): Promise<TargetHealthSnapshot[]> {

    if (targetGroupArns.length === 0) return [];

    // Look up names in one shot; we want them for display.
    const groups = await elb(region).send(new DescribeTargetGroupsCommand({
        TargetGroupArns: targetGroupArns,
    }));
    const arnToName = new Map<string, string>();

    for (const tg of groups.TargetGroups ?? []) {

        if (tg.TargetGroupArn && tg.TargetGroupName) {

            arnToName.set(tg.TargetGroupArn, tg.TargetGroupName);

}

}

    const snapshots: TargetHealthSnapshot[] = [];

    for (const arn of targetGroupArns) {

        const out = await elb(region).send(new DescribeTargetHealthCommand({
            TargetGroupArn: arn,
        }));

        snapshots.push({
            targetGroupArn: arn,
            targetGroupName: arnToName.get(arn) ?? arn.split('/').slice(-2, -1)[0] ?? arn,
            targets: (out.TargetHealthDescriptions ?? []).map((t) => ({
                id: t.Target?.Id ?? '?',
                port: t.Target?.Port ?? null,
                state: t.TargetHealth?.State ?? 'unknown',
                reason: t.TargetHealth?.Reason ?? null,
                description: t.TargetHealth?.Description ?? null,
            })),
        });

}
    return snapshots;

}
