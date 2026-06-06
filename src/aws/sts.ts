// STS helper. We use the caller's account id for two things:
//
//   1. As part of the cluster-resolution cache key — the same service name
//      can exist in different accounts, and you switch accounts by swapping
//      AWS profiles. Keying the cache by `accountId:region` keeps a `prod`
//      profile's map from colliding with a `dev` profile's.
//   2. To show *which* account we're actually talking to. ECS targets are
//      resolved from ambient credentials, so printing the account id catches
//      the classic "oops, wrong profile" footgun.
//
// Cached in-module: account id never changes within a single process run.

import {GetCallerIdentityCommand} from '@aws-sdk/client-sts';

import {sts} from './clients.js';

let cachedAccountId: string | null = null;

export async function getAccountId(region: string): Promise<string> {

    if (cachedAccountId) return cachedAccountId;
    const out = await sts(region).send(new GetCallerIdentityCommand({}));

    if (!out.Account) {

        throw new Error('Could not resolve AWS account id from STS GetCallerIdentity.');

}
    cachedAccountId = out.Account;
    return cachedAccountId;

}
