// Long-running log stream hook. Wraps the `aws/logs.ts` follow() async
// generator and pushes new lines into a bounded ring buffer kept in
// component state.
//
// Why a ring buffer (and not infinite array): an active production
// service can emit tens of thousands of lines per minute. Rendering
// them all in Ink kills the terminal — so we cap at 1000 lines and
// rely on the LLM root-cause analysis (which picks the most interesting
// lines) for the bigger picture.

import {useEffect, useRef, useState} from 'react';

import {follow} from '../../aws/logs.js';
import type {LogLine} from '../../types.js';

const MAX_LINES = 1000;

export interface LogStreamState {
    lines: LogLine[];
    /** True once the first poll cycle has completed (connected, even if idle). */
    started: boolean;
    error: string | null;
}

export function useLogStream(region: string, logGroup: string | null): LogStreamState {
    const [lines, setLines] = useState<LogLine[]>([]);
    const [started, setStarted] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const bufferRef = useRef<LogLine[]>([]);
    const flushTimer = useRef<NodeJS.Timeout | null>(null);

    useEffect(() => {
        if (!logGroup) return;
        const ctrl = new AbortController();

        // Batch flushes so we don't trigger a React render per log line —
        // a noisy app can produce 100s/sec and Ink will choke if we re-render
        // each time. 250ms gives the feel of "live" without the cost.
        const flush = () => {
            if (bufferRef.current.length === 0) return;
            const next = bufferRef.current;
            bufferRef.current = [];
            setLines((prev) => {
                const combined = prev.concat(next);
                return combined.length > MAX_LINES ? combined.slice(combined.length - MAX_LINES) : combined;
            });
        };
        flushTimer.current = setInterval(flush, 250);

        (async () => {
            try {
                // onPoll flips `started` after the first completed poll cycle —
                // so idle log groups (no lines yet) still show as connected
                // instead of a permanent "connecting…". setStarted(true) is
                // idempotent; React bails the re-render when the value is unchanged.
                const stream = follow(region, logGroup, {
                    signal: ctrl.signal,
                    intervalMs: 2500,
                    sinceMs: Date.now() - 5 * 60_000,
                    onPoll: () => setStarted(true),
                });
                for await (const line of stream) {
                    bufferRef.current.push(line);
                }
            } catch (err) {
                setError(err instanceof Error ? err.message : String(err));
            } finally {
                setStarted(true);
            }
        })();

        return () => {
            ctrl.abort();
            if (flushTimer.current) clearInterval(flushTimer.current);
            flushTimer.current = null;
            bufferRef.current = [];
        };
    }, [region, logGroup]);

    return {lines, started, error};
}
