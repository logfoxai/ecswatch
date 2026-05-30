// CloudWatch Logs helper. Two responsibilities:
//
//   1. tail() — return a one-shot batch of recent log events for a log
//      group, optionally filtered to a stream prefix (used by the snapshot
//      and the TUI's "first paint" of the logs panel).
//   2. follow() — async iterator that polls FilterLogEventsCommand on a
//      timer and yields new events as they arrive. We don't use the
//      StartLiveTail subscription API because (a) it requires bumping the
//      service quota for many accounts and (b) it doesn't play well with
//      AWS SSO short-term credentials in the way a poll loop does.

import {
    FilterLogEventsCommand,
    type FilterLogEventsCommandOutput,
} from '@aws-sdk/client-cloudwatch-logs';

import {logs} from './clients.js';
import type {LogLine} from '../types.js';

function classify(message: string): LogLine['severity'] {
    const m = message.toLowerCase();
    if (m.includes('error') || m.includes('exception') || m.includes('fatal') || m.includes('panic')) return 'error';
    if (m.includes('warn') || m.includes('warning')) return 'warn';
    if (m.includes('debug') || m.includes('trace')) return 'debug';
    return 'info';
}

export interface TailOptions {
    /** ISO timestamp / epoch ms — defaults to the last 10 minutes. */
    sinceMs?: number;
    /** Hard cap on returned events; default 200. */
    limit?: number;
    /** Optional log stream name prefix (CloudWatch supports prefix-match). */
    streamPrefix?: string;
}

export async function tail(
    region: string,
    logGroup: string,
    opts: TailOptions = {},
): Promise<LogLine[]> {
    const start = opts.sinceMs ?? Date.now() - 10 * 60_000;
    const limit = opts.limit ?? 200;
    const lines: LogLine[] = [];
    let nextToken: string | undefined;
    let collected = 0;

    do {
        const out: FilterLogEventsCommandOutput = await logs(region).send(new FilterLogEventsCommand({
            logGroupName: logGroup,
            startTime: start,
            limit: Math.min(10_000, limit - collected),
            nextToken,
            ...(opts.streamPrefix ? {logStreamNamePrefix: opts.streamPrefix} : {}),
        }));
        for (const ev of out.events ?? []) {
            const message = (ev.message ?? '').trimEnd();
            lines.push({
                timestamp: new Date(ev.timestamp ?? Date.now()),
                message,
                stream: ev.logStreamName ?? '',
                severity: classify(message),
            });
            collected++;
            if (collected >= limit) break;
        }
        nextToken = collected >= limit ? undefined : out.nextToken;
    } while (nextToken);

    return lines.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

export interface FollowOptions {
    /** Poll cadence (ms). Defaults to 3s — same ballpark as ECS rollout polling. */
    intervalMs?: number;
    /** Start from this epoch ms (default = now). */
    sinceMs?: number;
    /** Optional log stream name prefix. */
    streamPrefix?: string;
    /** Abort signal that breaks the poll loop on next iteration. */
    signal?: AbortSignal;
    /**
     * Called once per completed poll cycle (whether or not it returned lines,
     * and even if the request errored and was swallowed). Lets consumers flip a
     * "connected" flag for idle log groups that never produce a first line.
     */
    onPoll?: () => void;
}

/**
 * Async generator that yields fresh log lines as they show up. The caller
 * is responsible for break/return; we honour `signal` between polls.
 */
export async function * follow(
    region: string,
    logGroup: string,
    opts: FollowOptions = {},
): AsyncGenerator<LogLine, void, void> {
    const interval = opts.intervalMs ?? 3_000;
    let cursor = opts.sinceMs ?? Date.now();
    const seen = new Set<string>();

    while (!opts.signal?.aborted) {
        try {
            const out = await logs(region).send(new FilterLogEventsCommand({
                logGroupName: logGroup,
                startTime: cursor,
                limit: 10_000,
                ...(opts.streamPrefix ? {logStreamNamePrefix: opts.streamPrefix} : {}),
            }));

            const fresh: LogLine[] = [];
            for (const ev of out.events ?? []) {
                const key = ev.eventId ?? `${ev.timestamp}-${ev.message?.slice(0, 32) ?? ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const message = (ev.message ?? '').trimEnd();
                fresh.push({
                    timestamp: new Date(ev.timestamp ?? Date.now()),
                    message,
                    stream: ev.logStreamName ?? '',
                    severity: classify(message),
                });
                if (ev.timestamp && ev.timestamp >= cursor) {
                    cursor = ev.timestamp; // advance cursor past newest event
                }
            }

            // Trim the seen-set so it doesn't grow unbounded over hours of streaming.
            if (seen.size > 5000) {
                const drop = seen.size - 2500;
                let i = 0;
                for (const k of seen) {
                    if (i++ >= drop) break;
                    seen.delete(k);
                }
            }

            fresh.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
            for (const line of fresh) yield line;
        } catch {
            // Swallow transient errors (throttling, expired creds mid-refresh).
            // Next iteration will retry; the AWS SDK has its own backoff.
        }

        // Signal that a poll cycle finished — connected, even if idle.
        opts.onPoll?.();

        await new Promise<void>((resolve) => setTimeout(resolve, interval));
    }
}
