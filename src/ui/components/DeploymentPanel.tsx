// Deployment panel — shows current and previous deployments with a
// progress bar each. The PRIMARY deployment also surfaces rolloutState
// reason; ACTIVE deployments are old tasks that are still draining.

import {Box, Text} from 'ink';
import React from 'react';
import {Panel, Pill, Progress, colors, Muted} from '../theme.js';
import type {DeploymentSnapshot} from '../../types.js';

interface Props {
    deployments: DeploymentSnapshot[];
    focused: boolean;
    flexGrow?: number;
}

export function DeploymentPanel({deployments, focused, flexGrow}: Props): React.ReactElement {
    return (
        <Panel title="4 · Deployments" focused={focused} accentKind="primary" flexGrow={flexGrow}>
            {deployments.length === 0 ? <Muted>(no deployments)</Muted> : null}
            {deployments.map((d) => (
                <Box flexDirection="column" key={d.id} marginBottom={1}>
                    <Box>
                        <Pill kind={statusKind(d.status)}>{d.status}</Pill>
                        <Text>  </Text>
                        <Text color={colors.fg}>{d.taskDefinition}</Text>
                        <Text>  </Text>
                        <Pill kind={rolloutKind(d.rolloutState)}>{d.rolloutState}</Pill>
                    </Box>
                    <Box>
                        <Progress value={d.runningCount} max={d.desiredCount} width={20} />
                        <Text>  </Text>
                        <Text color={colors.fg}>{d.runningCount}/{d.desiredCount}</Text>
                        <Text>  </Text>
                        <Muted>pending </Muted><Text color={colors.pending}>{d.pendingCount}</Text>
                        <Text>  </Text>
                        <Muted>failed </Muted>
                        <Text color={d.failedTasks > 0 ? colors.error : colors.dim}>{d.failedTasks}</Text>
                        <Text>  </Text>
                        {d.createdAt
                            ? <Muted>· {relTime(d.createdAt)}</Muted>
                            : null}
                    </Box>
                    {d.rolloutStateReason
                        ? <Text color={colors.muted}>  {d.rolloutStateReason}</Text>
                        : null}
                </Box>
            ))}
        </Panel>
    );
}

function statusKind(s: string): 'primary' | 'info' | 'warning' {
    if (s === 'PRIMARY') return 'primary';
    if (s === 'ACTIVE') return 'info';
    return 'warning';
}

function rolloutKind(s: string): 'success' | 'rolling' | 'error' | 'warning' {
    switch (s) {
        case 'COMPLETED': return 'success';
        case 'IN_PROGRESS': return 'rolling';
        case 'FAILED': return 'error';
        default: return 'warning';
    }
}

function relTime(d: Date): string {
    const diff = Date.now() - d.getTime();
    const s = Math.round(diff / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}
