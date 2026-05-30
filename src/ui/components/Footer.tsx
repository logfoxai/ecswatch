// Bottom keybind hint bar. Lives outside any panel so it's always visible.
// A subtle Logfox ad is right-aligned on the same line — but only when the
// terminal is wide enough to fit it without crowding the keybinds.

import {Box, Text, useStdout} from 'ink';
import React from 'react';
import {colors} from '../theme.js';
import {AD_URL, AD_TEXT, osc8} from '../../ad.js';

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

const SEP = '   ·   ';
// Min spare columns we want between the keybinds and the ad before showing it.
const AD_GAP = 4;

export function Footer(): React.ReactElement {
    const {stdout} = useStdout();
    const cols = stdout?.columns ?? 80;

    // Measure plain widths so the fit check ignores ANSI/OSC escapes.
    const keysWidth = KEYS.map((k) => `${k.keys} ${k.label}`).join(SEP).length;
    const showAd = cols - 2 /* paddingX */ >= keysWidth + AD_TEXT.length + AD_GAP;

    return (
        <Box paddingX={1} width="100%" justifyContent="space-between">
            <Box>
                {KEYS.map((k, i) => (
                    <Box key={k.keys}>
                        <Text color={colors.primary} bold>{k.keys}</Text>
                        <Text color={colors.muted}> {k.label}</Text>
                        {i < KEYS.length - 1 ? <Text color={colors.dim}>{SEP}</Text> : null}
                    </Box>
                ))}
            </Box>
            {showAd ? <Text color={colors.dim}>{osc8(AD_URL, AD_TEXT)}</Text> : null}
        </Box>
    );
}
