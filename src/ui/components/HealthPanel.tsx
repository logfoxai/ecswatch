// Target group health panel — small but high-signal. If targets are
// unhealthy, this is usually the first place we find out (before ECS
// even posts an event).

import {Box, Text} from 'ink';
import React from 'react';
import {Panel, colors, Muted} from '../theme.js';
import type {TargetHealthSnapshot} from '../../types.js';

interface Props {
    groups: TargetHealthSnapshot[];
    focused: boolean;
}

export function HealthPanel({groups, focused}: Props): React.ReactElement {
    return (
        <Panel title="2 · Target health" focused={focused} accentKind="success" flexGrow={1}>
            {groups.length === 0 ? <Muted>(no target groups attached)</Muted> : null}
            {groups.map((g) => {
                const counts: Record<string, number> = {};
                for (const t of g.targets) counts[t.state] = (counts[t.state] ?? 0) + 1;
                const unhealthy = g.targets.filter((t) => t.state !== 'healthy');
                return (
                    <Box flexDirection="column" key={g.targetGroupArn} marginBottom={1}>
                        <Box>
                            <Text color={colors.fg} bold>{g.targetGroupName}</Text>
                            <Text>  </Text>
                            {Object.entries(counts).map(([state, n]) => (
                                <Text key={state} color={stateColor(state)}>{state}={n}  </Text>
                            ))}
                        </Box>
                        {unhealthy.map((t) => (
                            <Box key={`${t.id}-${t.port}`}>
                                <Text color={colors.error}>● </Text>
                                <Text color={colors.fg}>{t.id}{t.port ? ':' + t.port : ''}</Text>
                                <Text>  </Text>
                                <Text color={colors.error}>{t.state}</Text>
                                {t.reason ? <Muted>  {t.reason}</Muted> : null}
                                {t.description ? <Muted>  {truncate(t.description, 60)}</Muted> : null}
                            </Box>
                        ))}
                    </Box>
                );
            })}
        </Panel>
    );
}

function stateColor(state: string): string {
    if (state === 'healthy') return colors.success;
    if (state === 'unhealthy') return colors.error;
    if (state === 'draining' || state === 'initial') return colors.warning;
    return colors.muted;
}

function truncate(s: string, n: number): string {
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
