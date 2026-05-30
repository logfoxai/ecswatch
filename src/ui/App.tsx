// Root Ink component. Owns:
//   - The two data hooks (service state + log stream),
//   - Keyboard input wiring (focus, refresh, LLM analysis, help, quit),
//   - The layout: header, two columns of panels, footer.
//
// Each panel is independently focusable. Focus mainly affects which
// panel has the highlighted border and which one grows on screen. We
// keep behaviour minimal — no full-on tab-traversal modal stacks — so
// the TUI stays snappy and easy to reason about.

import {Box, useApp, useInput, useStdout} from 'ink';
import React, {useEffect, useMemo, useRef, useState} from 'react';

import type {CliContext} from '../types.js';
import {llmConfigured} from '../analyze/llm.js';

import {HeaderBar} from './components/HeaderBar.js';
import {DeploymentPanel} from './components/DeploymentPanel.js';
import {TasksPanel} from './components/TasksPanel.js';
import {EventsPanel} from './components/EventsPanel.js';
import {LogsPanel} from './components/LogsPanel.js';
import {HealthPanel} from './components/HealthPanel.js';
import {DiagnosticsPanel} from './components/DiagnosticsPanel.js';
import {Footer} from './components/Footer.js';
import {AdBar} from './components/AdBar.js';
import {Help} from './components/Help.js';

import {useServiceState} from './hooks/useServiceState.js';
import {useLogStream} from './hooks/useLogStream.js';

type Focus = 'deployments' | 'tasks' | 'events' | 'logs' | 'health' | 'diagnostics';

interface AppProps {
    ctx: CliContext;
}

export function App({ctx}: AppProps): React.ReactElement {
    const {exit} = useApp();
    const {stdout} = useStdout();
    const [focus, setFocus] = useState<Focus>('deployments');
    const [showHelp, setShowHelp] = useState(false);
    const [logsPaused, setLogsPaused] = useState(false);
    // Logs scroll offset, measured in lines *up from the live tail*.
    //   0           → following the newest line (LIVE)
    //   n > 0       → viewport bottom is n lines above the newest line
    const [logScroll, setLogScroll] = useState(0);

    const state = useServiceState(ctx, {pollIntervalMs: 5_000});
    const logs = useLogStream(ctx.region, logsPaused ? null : state.logGroup);

    const rows = stdout?.rows ?? 40;
    const eventsRows = Math.max(6, Math.floor((rows - 10) / 4));
    const logRows = Math.max(8, Math.floor((rows - 10) / 2));

    // Keep the viewport anchored to the same lines when new logs stream in.
    // If the user has scrolled up (offset > 0), bump the offset by however many
    // new lines arrived so the content under their eyes doesn't jump. At offset
    // 0 we stay live and let the tail advance.
    const prevLogLen = useRef(logs.lines.length);
    useEffect(() => {
        const delta = logs.lines.length - prevLogLen.current;
        prevLogLen.current = logs.lines.length;
        if (delta > 0 && logScroll > 0) {
            setLogScroll((s) => clampScroll(s + delta, logs.lines.length, logRows));
        }
    }, [logs.lines.length, logScroll, logRows]);

    useInput((input, key) => {
        if (key.ctrl && input === 'c') { exit(); return; }
        if (input === 'q') { exit(); return; }

        // Log scrolling — only when the logs panel is focused, so the arrow keys
        // are free for other uses elsewhere later.
        if (focus === 'logs') {
            const max = maxScroll(logs.lines.length, logRows);
            if (key.upArrow) { setLogScroll((s) => clampScroll(s + 1, logs.lines.length, logRows)); return; }
            if (key.downArrow) { setLogScroll((s) => Math.max(0, s - 1)); return; }
            if (key.pageUp) { setLogScroll((s) => clampScroll(s + logRows, logs.lines.length, logRows)); return; }
            if (key.pageDown) { setLogScroll((s) => Math.max(0, s - logRows)); return; }
            if (key.escape) { setLogScroll(0); return; } // jump back to live tail
            if (input === 'g') { setLogScroll(max); return; } // oldest buffered
            if (input === 'G') { setLogScroll(0); return; } // newest / live
        }

        if (input === 'r') { void state.refresh(); return; }
        if (input === '?') { setShowHelp((v) => !v); return; }
        if (input === 'p') { setLogsPaused((v) => !v); return; }
        if (input === 'a') {
            // Manually trigger an analysis with the current log buffer.
            void state.refreshRootCause(logs.lines);
            return;
        }
        if (input === '1') { setFocus('deployments'); return; }
        if (input === '2') { setFocus('tasks'); return; }
        if (input === '3') { setFocus('events'); return; }
        if (input === '4') { setFocus('logs'); return; }
        if (input === '5') { setFocus('health'); return; }
        if (input === '6') { setFocus('diagnostics'); return; }
    });

    // Auto-run analysis once on the first FAILED rollout we see. We do this
    // without prompting because the operator is almost certainly here for
    // exactly this reason and waiting for them to press `a` is silly.
    const failedRolloutId = state.service?.deployments.find((d) => d.status === 'PRIMARY' && d.rolloutState === 'FAILED')?.id;
    useEffect(() => {
        if (!failedRolloutId) return;
        if (state.rootCauseAnalysis) return;
        if (state.rootCauseLoading) return;
        void state.refreshRootCause(logs.lines);
        // We intentionally depend only on failedRolloutId so it triggers once.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [failedRolloutId]);

    const llmReady = useMemo(() => llmConfigured(), []);

    // height={rows} + the flexGrow body makes the app occupy the full alt-screen
    // viewport and pins the footer to the bottom.
    return (
        <Box flexDirection="column" height={rows}>
            <HeaderBar service={state.service} lastFetchedAt={state.lastFetchedAt} error={state.error} />
            {showHelp ? <Help /> : null}
            <Box flexDirection="row" flexGrow={1}>
                <Box flexDirection="column" width="50%">
                    <DeploymentPanel
                        deployments={state.service?.deployments ?? []}
                        focused={focus === 'deployments'}
                    />
                    <TasksPanel
                        running={state.runningTasks}
                        stopped={state.stoppedTasks}
                        focused={focus === 'tasks'}
                    />
                    <HealthPanel
                        groups={state.targetHealth}
                        focused={focus === 'health'}
                    />
                </Box>
                <Box flexDirection="column" width="50%">
                    <EventsPanel
                        events={state.service?.events ?? []}
                        focused={focus === 'events'}
                        maxRows={eventsRows}
                    />
                    <LogsPanel
                        lines={logs.lines}
                        focused={focus === 'logs'}
                        maxRows={logRows}
                        scroll={logScroll}
                        started={logs.started}
                        error={logs.error}
                        logGroup={state.logGroup}
                    />
                    <DiagnosticsPanel
                        diagnostics={state.diagnostics}
                        analysis={state.rootCauseAnalysis}
                        analyzing={state.rootCauseLoading}
                        focused={focus === 'diagnostics'}
                        llmAvailable={llmReady}
                    />
                </Box>
            </Box>
            <Footer />
            <AdBar />
        </Box>
    );
}

/** Largest meaningful scroll offset: enough to reveal the oldest buffered line. */
function maxScroll(total: number, viewport: number): number {
    return Math.max(0, total - viewport);
}

function clampScroll(value: number, total: number, viewport: number): number {
    return Math.min(Math.max(0, value), maxScroll(total, viewport));
}
