// Lazy AWS client cache. Two reasons we don't construct these at module load:
//
//   1. The default credentials chain (SSO / env / IMDS) is async and we'd
//      rather surface "no credentials" as a normal error inside command
//      handlers than a thrown top-level rejection.
//   2. Different commands target different regions (CloudWatch Logs is in the
//      ECS region too, but ELB target health calls need the same client and
//      we want to construct once per region).

import {ECSClient} from '@aws-sdk/client-ecs';
import {CloudWatchLogsClient} from '@aws-sdk/client-cloudwatch-logs';
import {ElasticLoadBalancingV2Client} from '@aws-sdk/client-elastic-load-balancing-v2';
import {STSClient} from '@aws-sdk/client-sts';

const ecsClients = new Map<string, ECSClient>();
const logsClients = new Map<string, CloudWatchLogsClient>();
const elbClients = new Map<string, ElasticLoadBalancingV2Client>();
const stsClients = new Map<string, STSClient>();

export function ecs(region: string): ECSClient {

    let c = ecsClients.get(region);

    if (!c) {

        c = new ECSClient({region, maxAttempts: 3});
        ecsClients.set(region, c);

}
    return c;

}

export function logs(region: string): CloudWatchLogsClient {

    let c = logsClients.get(region);

    if (!c) {

        c = new CloudWatchLogsClient({region, maxAttempts: 3});
        logsClients.set(region, c);

}
    return c;

}

export function elb(region: string): ElasticLoadBalancingV2Client {

    let c = elbClients.get(region);

    if (!c) {

        c = new ElasticLoadBalancingV2Client({region, maxAttempts: 3});
        elbClients.set(region, c);

}
    return c;

}

export function sts(region: string): STSClient {

    let c = stsClients.get(region);

    if (!c) {

        c = new STSClient({region, maxAttempts: 3});
        stsClients.set(region, c);

}
    return c;

}
