// Tasks panel — running tasks first (split by primary vs old deployment),
// then a brief tail of recently stopped tasks with their stopCode +
// exit codes. This is the panel ops folks live in: it's where you see
// "the new task came up healthy" or "exit 137 every 30 seconds".

import {Box, Text} from 'ink';
import React from 'react';
import {Panel, Pill, colors, Muted} from '../theme.js';
import type {TaskSnapshot} from '../../types.js';

interface Props {
    running: TaskSnapshot[];
    stopped: TaskSnapshot[];
    focused: boolean;
    flexGrow?: number;
}

export function TasksPanel({running, stopped, focused, flexGrow}: Props): React.ReactElement {

    const showStopped = stopped.slice(0, 3);

    return (
        <Panel title="3 · Tasks" focused={focused} accentKind="accent" flexGrow={flexGrow}>
            {running.length === 0
                ? <Muted>(no running tasks)</Muted>
                : running.map((t) => (
                    <Box flexDirection="column" key={t.arn}>
                        <Box>
                            <Pill kind={t.onPrimaryDeployment ? 'primary' : 'warning'}>
                                {t.onPrimaryDeployment ? 'NEW' : 'OLD'}
                            </Pill>
                            <Text>  </Text>
                            <Text color={colors.fg} bold>{t.shortId}</Text>
                            <Text>  </Text>
                            <Text color={statusColor(t.lastStatus)}>{t.lastStatus}</Text>
                            <Text>  </Text>
                            <Text color={healthColor(t.healthStatus)}>● {t.healthStatus}</Text>
                            <Text>  </Text>
                            <Muted>{t.cpu} cpu / {t.memory} MB</Muted>
                        </Box>
                        <Text color={colors.muted}>  {t.taskDefinition} · {t.availabilityZone ?? '?'}{t.startedAt ? ` · up ${relTime(t.startedAt)}` : ''}</Text>
                    </Box>
                ))}
            {showStopped.length > 0
                ? <Box marginTop={1} flexDirection="column">
                    <Text color={colors.warning} bold>Recently stopped</Text>
                    {showStopped.map((t) => {

                        const exits = t.containers
                            .map((c) => c.exitCode === null ? '—' : String(c.exitCode))
                            .join(' ');

                        return (
                            <Box flexDirection="column" key={t.arn}>
                                <Box>
                                    <Text color={colors.warning}>● </Text>
                                    <Text color={colors.fg}>{t.shortId}</Text>
                                    <Text color={colors.muted}> {t.taskDefinition} </Text>
                                    <Text color={colors.error}>{t.stopCode ?? '?'}</Text>
                                    <Muted> exit </Muted>
                                    <Text color={colors.error}>{exits}</Text>
                                    {t.stoppedAt ? <Muted> · {relTime(t.stoppedAt)}</Muted> : null}
                                </Box>
                                {t.stoppedReason
                                    ? <Text color={colors.muted}>    {truncate(t.stoppedReason, 100)}</Text>
                                    : null}
                            </Box>
                        );

})}
                </Box>
                : null}
        </Panel>
    );

}

function statusColor(status: string): string {

    switch (status) {

        case 'RUNNING': return colors.success;
        case 'PENDING':
        case 'PROVISIONING':
        case 'ACTIVATING': return colors.pending;
        case 'STOPPED':
        case 'DEPROVISIONING': return colors.warning;
        default: return colors.muted;

}

}

function healthColor(status: string): string {

    switch (status) {

        case 'HEALTHY': return colors.success;
        case 'UNHEALTHY': return colors.error;
        case 'UNKNOWN': return colors.dim;
        default: return colors.muted;

}

}

function relTime(d: Date): string {

    const diff = Date.now() - d.getTime();
    const s = Math.round(diff / 1000);

    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    if (s < 86400) return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 86400)}d`;

}

function truncate(s: string, n: number): string {

    return s.length <= n ? s : `${s.slice(0, n - 1)}…`;

}
