// Streaming log tail panel. Shows a window of the buffered CloudWatch log
// lines, colored by parsed severity. When focused, the panel grows to fill
// the available height.
//
// Scrolling: `scroll` is the offset (in lines) up from the live tail, owned
// by App. 0 = following the newest line (LIVE); >0 = the viewport bottom is
// `scroll` lines above the newest line. We slice the visible window from that
// and show a LIVE / "↑ +N" indicator so it's obvious when you've detached
// from the tail.

import {Box, Text} from 'ink';
import React from 'react';
import {Panel, colors, Muted} from '../theme.js';
import type {LogLine} from '../../types.js';

interface Props {
    lines: LogLine[];
    focused: boolean;
    maxRows: number;
    scroll: number;
    started: boolean;
    error: string | null;
    logGroup: string | null;
}

export function LogsPanel({lines, focused, maxRows, scroll, started, error, logGroup}: Props): React.ReactElement {
    // viewport bottom is `scroll` lines up from the end; window is maxRows tall.
    const end = Math.max(0, lines.length - scroll);
    const start = Math.max(0, end - maxRows);
    const visible = lines.slice(start, end);
    const hiddenAbove = start;
    const live = scroll === 0;

    return (
        <Panel
            title={`4 · Logs${logGroup ? '  ' + dim(logGroup) : ''}`}
            focused={focused}
            accentKind="accent"
            flexGrow={focused ? 2 : 1}
        >
            {!logGroup
                ? <Muted>no log group resolved yet · check task definition</Muted>
                : null}
            {logGroup && !started ? <Muted>connecting to CloudWatch Logs…</Muted> : null}
            {error ? <Text color={colors.error}>error: {error}</Text> : null}
            {logGroup && started ? (
                <Box>
                    {live
                        ? <Text color={colors.success}>● LIVE</Text>
                        : <Text color={colors.pending}>⏸ ↑ +{scroll}</Text>}
                    {hiddenAbove > 0 ? <Muted>  {hiddenAbove} older above</Muted> : null}
                    {!live ? <Muted>  · Esc/G live · ↑↓ PgUp/PgDn scroll</Muted> : null}
                </Box>
            ) : null}
            {logGroup && started && lines.length === 0
                ? <Muted>no log lines in the last few minutes — waiting for new output…</Muted>
                : null}
            {visible.map((line, idx) => (
                <Box key={`${line.timestamp.getTime()}-${start + idx}`}>
                    <Text color={colors.dim}>{line.timestamp.toISOString().slice(11, 19)} </Text>
                    <Text color={severityColor(line.severity)}>{truncate(line.message, 160)}</Text>
                </Box>
            ))}
        </Panel>
    );
}

function severityColor(s: LogLine['severity']): string {
    switch (s) {
        case 'error': return colors.error;
        case 'warn': return colors.warning;
        case 'debug': return colors.dim;
        default: return colors.fg;
    }
}

function dim(s: string): string {
    return `· ${s}`;
}

function truncate(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
