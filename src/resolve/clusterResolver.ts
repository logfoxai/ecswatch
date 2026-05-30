// Cluster resolution + caching.
//
// ECS addresses a service as (cluster, service). When the caller doesn't pass
// --cluster, we discover which cluster a service lives in by scanning every
// cluster in the account/region and building a `service -> [clusters]` map.
// That scan is N+1 API calls (ListClusters + ListServices per cluster), so we
// persist the map to disk and reuse it across invocations.
//
// Cache shape (on disk, JSON):
//   {
//     "<accountId>:<region>": {
//       "scannedAt": <epoch ms>,
//       "clusters": ["clusterA", "clusterB"],
//       "services": { "phone-audit": ["clusterA"], "web": ["clusterA","clusterB"] }
//     }
//   }
//
// Keyed by accountId:region so different AWS profiles / regions never collide.
// Entries older than TTL_MS are ignored (services come and go). A cache miss
// for the requested service also triggers a rescan — so a freshly-created
// service is found without needing --refresh.

import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import path from 'node:path';

import {listAllClusters, listAllServices} from '../aws/ecs.js';
import {getAccountId} from '../aws/sts.js';

const TTL_MS = 12 * 60 * 60 * 1000; // 12h
const SCAN_CONCURRENCY = 8;

interface CacheEntry {
    scannedAt: number;
    clusters: string[];
    services: Record<string, string[]>;
}

type CacheFile = Record<string, CacheEntry>;

export interface ResolveResult {
    cluster: string;
    accountId: string;
    /** How we arrived at the answer — surfaced as a dim status line. */
    source: 'cache' | 'scan';
    /** Number of clusters scanned (0 on a cache hit). */
    clustersScanned: number;
}

export class ClusterResolutionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ClusterResolutionError';
    }
}

function cacheDir(): string {
    const base = process.env.XDG_CACHE_HOME?.trim() || path.join(homedir(), '.cache');
    return path.join(base, 'ecswatch');
}

function cachePath(): string {
    return path.join(cacheDir(), 'clusters.json');
}

async function loadCache(): Promise<CacheFile> {
    try {
        const raw = await readFile(cachePath(), 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        return (parsed && typeof parsed === 'object') ? (parsed as CacheFile) : {};
    } catch {
        // Missing / unreadable / corrupt cache is non-fatal — we just rescan.
        return {};
    }
}

async function saveCache(cache: CacheFile): Promise<void> {
    try {
        await mkdir(cacheDir(), {recursive: true});
        await writeFile(cachePath(), JSON.stringify(cache, null, 2) + '\n', 'utf8');
    } catch {
        // A failed cache write should never break the command — worst case we
        // rescan next time.
    }
}

/** Scan every cluster, building the service->clusters map. */
async function scan(region: string): Promise<CacheEntry> {
    const clusters = await listAllClusters(region);
    const services: Record<string, string[]> = {};

    for (let i = 0; i < clusters.length; i += SCAN_CONCURRENCY) {
        const batch = clusters.slice(i, i + SCAN_CONCURRENCY);
        const results = await Promise.all(batch.map(async (cluster) => ({
            cluster,
            services: await listAllServices(region, cluster).catch(() => [] as string[]),
        })));
        for (const {cluster, services: svcNames} of results) {
            for (const name of svcNames) {
                (services[name] ??= []).push(cluster);
            }
        }
    }

    return {scannedAt: Date.now(), clusters, services};
}

function isFresh(entry: CacheEntry | undefined): entry is CacheEntry {
    return Boolean(entry) && Date.now() - (entry as CacheEntry).scannedAt < TTL_MS;
}

function pick(entry: CacheEntry, service: string): {hit: boolean; clusters: string[]} {
    const clusters = entry.services[service] ?? [];
    return {hit: clusters.length > 0, clusters};
}

export interface ResolveOptions {
    /** Force a fresh scan even if a valid cache entry exists. */
    refresh?: boolean;
}

/**
 * Resolve which cluster `service` lives in. Throws ClusterResolutionError when
 * the service is found in zero clusters (after a scan) or in more than one
 * (ambiguous — caller must pass --cluster).
 */
export async function resolveCluster(
    region: string,
    service: string,
    opts: ResolveOptions = {},
): Promise<ResolveResult> {
    const accountId = await getAccountId(region);
    const key = `${accountId}:${region}`;
    const cache = await loadCache();

    // 1. Try the cache unless --refresh.
    if (!opts.refresh && isFresh(cache[key])) {
        const {hit, clusters} = pick(cache[key]!, service);
        if (hit) {
            return finalize(service, clusters, accountId, 'cache', 0);
        }
        // Fresh cache but service absent → it may be newly created. Fall through
        // to a rescan rather than erroring on stale data.
    }

    // 2. Scan, cache, and resolve.
    const entry = await scan(region);
    cache[key] = entry;
    await saveCache(cache);

    const {hit, clusters} = pick(entry, service);
    if (!hit) {
        throw new ClusterResolutionError(
            `Service "${service}" was not found in any of the ${entry.clusters.length} cluster(s) `
            + `in account ${accountId} (${region}). Check the name, your AWS profile/region, or pass --cluster.`,
        );
    }
    return finalize(service, clusters, accountId, 'scan', entry.clusters.length);
}

function finalize(
    service: string,
    clusters: string[],
    accountId: string,
    source: 'cache' | 'scan',
    clustersScanned: number,
): ResolveResult {
    if (clusters.length > 1) {
        throw new ClusterResolutionError(
            `Service "${service}" exists in multiple clusters: ${clusters.join(', ')}. `
            + 'Disambiguate with --cluster <name>.',
        );
    }
    return {cluster: clusters[0]!, accountId, source, clustersScanned};
}
