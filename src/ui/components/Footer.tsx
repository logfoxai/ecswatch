// Bottom keybind hint bar. Lives outside any panel so it's always visible.

import {Box, Text} from 'ink';
import React from 'react';
import {colors} from '../theme.js';

interface Key {
    keys: string;
    label: string;
}

const KEYS: Key[] = [
    {keys: '1-6', label: 'panel'},
    {keys: 'r', label: 'refresh'},
    {keys: 'a', label: 'analyze (LLM)'},
    {keys: 'p', label: 'pause logs'},
    {keys: '↑↓', label: 'scroll logs'},
    {keys: '?', label: 'help'},
    {keys: 'q', label: 'quit'},
];

export function Footer(): React.ReactElement {
    return (
        <Box paddingX={1}>
            {KEYS.map((k, i) => (
                <Box key={k.keys}>
                    <Text color={colors.primary} bold>{k.keys}</Text>
                    <Text color={colors.muted}> {k.label}</Text>
                    {i < KEYS.length - 1 ? <Text color={colors.dim}>   ·   </Text> : null}
                </Box>
            ))}
        </Box>
    );
}
