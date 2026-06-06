// Top status bar — service identity + at-a-glance counts. Updates on
// every snapshot poll so the operator always sees the latest desired /
// running / pending without having to focus a specific panel.

import {Box, Text} from 'ink';
import React from 'react';
import {Pill, Muted, colors} from '../theme.js';
import type {ServiceSnapshot} from '../../types.js';
import {primaryDeployment} from '../../aws/ecs.js';

interface Props {
    service: ServiceSnapshot | null;
    lastFetchedAt: Date | null;
    error: string | null;
}

export function HeaderBar({service, lastFetchedAt, error}: Props): React.ReactElement {

    if (!service) {

        return (
            <Box paddingX={1}>
                <Pill kind="primary"> ecswatch </Pill>
                <Text>  </Text>
                <Muted>{error ? `error: ${error}` : 'loading…'}</Muted>
            </Box>
        );

}
    const primary = primaryDeployment(service);
    const ageMs = lastFetchedAt ? Date.now() - lastFetchedAt.getTime() : 0;

    return (
        <Box paddingX={1} flexDirection="row" justifyContent="space-between">
            <Box>
                <Pill kind="primary"> ecswatch </Pill>
                <Text>  </Text>
                <Text color={colors.accent} bold>{service.serviceName}</Text>
                <Text color={colors.muted}>  on  </Text>
                <Text color={colors.fg}>{service.clusterName}</Text>
                <Text color={colors.muted}>  ({service.region})</Text>
            </Box>
            <Box>
                <Pill kind={service.status === 'ACTIVE' ? 'success' : 'warning'}>{service.status}</Pill>
                <Text>  </Text>
                <Muted>desired </Muted><Text color={colors.fg} bold>{service.desiredCount}</Text>
                <Text>  </Text>
                <Muted>running </Muted><Text color={colors.success} bold>{service.runningCount}</Text>
                <Text>  </Text>
                <Muted>pending </Muted><Text color={colors.pending} bold>{service.pendingCount}</Text>
                <Text>  </Text>
                {primary ? <Pill kind={rolloutKind(primary.rolloutState)}>{primary.rolloutState}</Pill> : null}
                <Text>  </Text>
                <Muted>↻ {Math.max(0, Math.round(ageMs / 1000))}s</Muted>
            </Box>
        </Box>
    );

}

function rolloutKind(state: string): 'success' | 'rolling' | 'error' | 'warning' {

    switch (state) {

        case 'COMPLETED': return 'success';
        case 'IN_PROGRESS': return 'rolling';
        case 'FAILED': return 'error';
        default: return 'warning';

}

}
