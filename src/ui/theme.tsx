// Ink-flavoured theme. Ink's `<Text color>` accepts hex strings or named
// colors but we want the exact RGB triples we defined in `src/theme.ts`,
// so we expose hex strings derived from the same palette and a small set
// of styled wrappers that match the chalk-flavoured helpers in CI mode.
//
// Keeping both palettes in sync matters: a service that looks "warning
// yellow" in CI mode should look identical in the TUI so screenshots
// match what reviewers see in PR logs.

import {Text, Box, type TextProps} from 'ink';
import React from 'react';
import {palette} from '../theme.js';

function hex(rgb: readonly [number, number, number]): string {
    return `#${rgb.map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

export const colors = {
    fg: hex(palette.fg),
    muted: hex(palette.fgMuted),
    dim: hex(palette.fgDim),
    primary: hex(palette.primary),
    accent: hex(palette.accent),
    success: hex(palette.success),
    warning: hex(palette.warning),
    error: hex(palette.error),
    info: hex(palette.info),
    pending: hex(palette.pending),
    rolling: hex(palette.rolling),
    border: hex(palette.border),
    badgeBg: hex(palette.badgeBg),
    bgPanel: hex(palette.bgPanel),
};

interface PillProps {
    children: React.ReactNode;
    kind?: 'success' | 'warning' | 'error' | 'info' | 'primary' | 'pending' | 'rolling' | 'muted';
}

export function Pill({children, kind = 'info'}: PillProps): React.ReactElement {
    const bg = (() => {
        switch (kind) {
            case 'success': return colors.success;
            case 'warning': return colors.warning;
            case 'error': return colors.error;
            case 'primary': return colors.primary;
            case 'pending': return colors.pending;
            case 'rolling': return colors.rolling;
            case 'muted': return colors.badgeBg;
            case 'info':
            default: return colors.info;
        }
    })();
    return (
        <Text backgroundColor={bg} color="#0f0f19" bold>
            {' '}{children}{' '}
        </Text>
    );
}

interface PanelProps {
    title: string;
    focused?: boolean;
    children: React.ReactNode;
    flexGrow?: number;
    minHeight?: number;
    accentKind?: 'primary' | 'accent' | 'success' | 'warning' | 'error';
}

/** Standard panel chrome: bordered Box with a colored title pill. */
export function Panel(props: PanelProps): React.ReactElement {
    const borderColor = props.focused ? colors.primary : colors.border;
    const accent = (() => {
        switch (props.accentKind) {
            case 'success': return colors.success;
            case 'warning': return colors.warning;
            case 'error': return colors.error;
            case 'primary': return colors.primary;
            case 'accent':
            default: return colors.accent;
        }
    })();
    return (
        <Box flexDirection="column" borderStyle="round" borderColor={borderColor} paddingX={1} flexGrow={props.flexGrow} minHeight={props.minHeight}>
            <Box marginBottom={0}>
                <Text color={accent} bold>{props.title}</Text>
                {props.focused
                    ? <Text color={colors.primary}>{'  '}● focused</Text>
                    : <Text color={colors.dim}>{'  '}○</Text>}
            </Box>
            {props.children}
        </Box>
    );
}

export function Dim({children, ...rest}: TextProps & {children: React.ReactNode}): React.ReactElement {
    return <Text color={colors.dim} {...rest}>{children}</Text>;
}

export function Muted({children, ...rest}: TextProps & {children: React.ReactNode}): React.ReactElement {
    return <Text color={colors.muted} {...rest}>{children}</Text>;
}

interface ProgressProps {
    value: number;
    max: number;
    width?: number;
}

export function Progress({value, max, width = 24}: ProgressProps): React.ReactElement {
    // We use ▰/▱ (filled/outline pill glyphs) and a `primary` blue rather than
    // `success` green so the bar can never be mistaken for a green status pill
    // sitting directly above or below it (e.g. COMPLETED). U+2588 FULL BLOCK +
    // success green caused a visual "color bleed" where the bar looked
    // contiguous with the pill chrome even though escapes were clean.
    if (max <= 0) return <Text color={colors.dim}>{'▱'.repeat(width)}</Text>;
    const filled = Math.min(width, Math.round((value / max) * width));
    const empty = width - filled;
    return (
        <Text>
            <Text color={colors.primary}>{'▰'.repeat(filled)}</Text>
            <Text color={colors.dim}>{'▱'.repeat(empty)}</Text>
        </Text>
    );
}
