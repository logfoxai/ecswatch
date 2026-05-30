// Subtle Logfox ad pinned to the bottom of the TUI — mirrors the open-prs
// ad bar (a dim full-width rule + a clickable OSC 8 link). Purely cosmetic;
// never shown in CI / snapshot output.

import {Box, Text, useStdout} from 'ink';
import React from 'react';
import {colors} from '../theme.js';
import {AD_URL, AD_TEXT, osc8} from '../../ad.js';

export function AdBar(): React.ReactElement {
    const {stdout} = useStdout();
    const cols = stdout?.columns ?? 80;
    return (
        <Box flexDirection="column">
            <Text color={colors.dim}>{'─'.repeat(cols)}</Text>
            <Text color={colors.dim}>{'  ' + osc8(AD_URL, AD_TEXT)}</Text>
        </Box>
    );
}
