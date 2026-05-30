// Recent ECS service events — most useful single panel for diagnosing
// placement / capacity / health-check problems because ECS narrates
// everything it does here.

import {Box, Text} from 'ink';
import React from 'react';
import {Panel, colors, Muted} from '../theme.js';
import type {ServiceEventSnapshot} from '../../types.js';

interface Props {
    events: ServiceEventSnapshot[];
    focused: boolean;
    maxRows: number;
    flexGrow?: number;
}

export function EventsPanel({events, focused, maxRows, flexGrow}: Props): React.ReactElement {
    const visible = events.slice(0, maxRows);
    return (
        <Panel title="5 · Events" focused={focused} accentKind="warning" flexGrow={flexGrow}>
            {visible.length === 0 ? <Muted>(no events)</Muted> : null}
            {visible.map((e) => (
                <Box key={e.id}>
                    <Text color={colors.dim}>{stamp(e.createdAt)}  </Text>
                    <Text color={severityColor(e.severity)}>{truncate(e.message, 110)}</Text>
                </Box>
            ))}
        </Panel>
    );
}

function severityColor(s: ServiceEventSnapshot['severity']): string {
    switch (s) {
        case 'error': return colors.error;
        case 'warn': return colors.warning;
        case 'success': return colors.success;
        case 'info':
        default: return colors.info;
    }
}

function stamp(d: Date): string {
    return d.toISOString().replace('T', ' ').slice(5, 19);
}

function truncate(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
