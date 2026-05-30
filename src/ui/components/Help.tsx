// Modal-ish help overlay rendered when the user presses `?`.

import {Box, Text} from 'ink';
import React from 'react';
import {colors, Pill} from '../theme.js';

interface Row {
    keys: string;
    desc: string;
}

const ROWS: Row[] = [
    {keys: '1 / 2 / 3 / 4 / 5 / 6', desc: 'focus diagnostics · target health · tasks · deployments · events · logs'},
    {keys: 'r', desc: 'manual refresh now (otherwise polls every 5s)'},
    {keys: 'a', desc: 'run LLM-assisted root-cause analysis (falls back to heuristic if unavailable)'},
    {keys: 'p', desc: 'pause / resume log streaming'},
    {keys: '↑ / ↓', desc: 'when logs focused (4): scroll the log buffer one line'},
    {keys: 'PgUp / PgDn', desc: 'when logs focused: scroll the log buffer one page'},
    {keys: 'g / G', desc: 'when logs focused: jump to oldest (g) / live tail (G)'},
    {keys: 'Esc', desc: 'when logs focused: jump back to the live tail'},
    {keys: '?', desc: 'toggle this help overlay'},
    {keys: 'q / ctrl-c', desc: 'quit'},
];

export function Help(): React.ReactElement {
    return (
        <Box flexDirection="column" borderStyle="double" borderColor={colors.primary} paddingX={2} paddingY={1}>
            <Box>
                <Pill kind="primary"> ecswatch help </Pill>
                <Text color={colors.muted}>  · live ECS service inspection</Text>
            </Box>
            <Box marginTop={1} flexDirection="column">
                {ROWS.map((r) => (
                    <Box key={r.keys}>
                        <Box width={28}>
                            <Text color={colors.accent} bold>{r.keys}</Text>
                        </Box>
                        <Text color={colors.fg}>{r.desc}</Text>
                    </Box>
                ))}
            </Box>
            <Box marginTop={1} flexDirection="column">
                <Text color={colors.muted}>Tip: set <Text color={colors.primary}>ANTHROPIC_API_KEY</Text> or <Text color={colors.primary}>OPENAI_API_KEY</Text> to enable LLM root-cause.</Text>
                <Text color={colors.muted}>Tip: override the chain with <Text color={colors.primary}>ECSWATCH_LLM_MODELS=anthropic:claude-sonnet-4-6,openai:gpt-5</Text>.</Text>
            </Box>
        </Box>
    );
}
