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
import {Help} from './components/Help.js';

import {useServiceState} from './hooks/useServiceState.js';
import {useLogStream} from './hooks/useLogStream.js';

type Focus = 'deployments' | 'tasks' | 'events' | 'logs' | 'health' | 'diagnostics';

// Rough vertical budget consumed by the header, the two short top-grid rows,
// and the footer — the leftover height goes to the Events/Logs row. Tuned so
// the bottom panels don't overflow on a standard-height terminal; resize-safe
// because it's derived from the live row count.
const TOP_CHROME = 24;

// In the stacked (narrow) layout the four short panels are full-height-stacked
// above Events/Logs, so the overhead before the bottom two is larger.
const NARROW_TOP_CHROME = 34;

// Width breakpoint: below this we stack panels into a single column.
const NARROW_COLS = 100;

interface AppProps {
    ctx: CliContext;
}

export function App({ctx}: AppProps): React.ReactElement {

    const {exit} = useApp();
    const {stdout} = useStdout();
    const [focus, setFocus] = useState<Focus>('deployments');
    const [showHelp, setShowHelp] = useState(false);
    const [showMenu, setShowMenu] = useState(false);
    const [logsPaused, setLogsPaused] = useState(false);
    // Logs scroll offset, measured in lines *up from the live tail*.
    //   0           → following the newest line (LIVE)
    //   n > 0       → viewport bottom is n lines above the newest line
    const [logScroll, setLogScroll] = useState(0);

    const state = useServiceState(ctx, {pollIntervalMs: 5_000});
    const logs = useLogStream(ctx.region, logsPaused ? null : state.logGroup);

    const rows = stdout?.rows ?? 40;
    const cols = stdout?.columns ?? 80;
    // Below NARROW_COLS the 2×2 grid can't hold readable columns, so we stack
    // every panel into a single full-width column instead.
    const narrow = cols < NARROW_COLS;
    // Events + Logs share the remaining vertical space. In the wide grid they
    // sit side-by-side (one bottom row), so each gets `rows - TOP_CHROME`. When
    // stacked, the four short panels eat more height and Events/Logs split
    // what's left, so each gets roughly half.
    const bottomRows = narrow
        ? Math.max(4, Math.floor((rows - NARROW_TOP_CHROME) / 2))
        : Math.max(6, rows - TOP_CHROME);

    // Keep the viewport anchored to the same lines when new logs stream in.
    // If the user has scrolled up (offset > 0), bump the offset by however many
    // new lines arrived so the content under their eyes doesn't jump. At offset
    // 0 we stay live and let the tail advance.
    const prevLogLen = useRef(logs.lines.length);

    useEffect(() => {

        const delta = logs.lines.length - prevLogLen.current;

        prevLogLen.current = logs.lines.length;
        if (delta > 0 && logScroll > 0) {

            setLogScroll((s) => clampScroll(s + delta, logs.lines.length, bottomRows));

}

}, [logs.lines.length, logScroll, bottomRows]);

    useInput((input, key) => {

        if (key.ctrl && input === 'c') {

 exit(); return;

}
        if (input === 'q') {

 exit(); return;

}

        // Log scrolling — only when the logs panel is focused, so the arrow keys
        // are free for other uses elsewhere later.
        if (focus === 'logs') {

            const max = maxScroll(logs.lines.length, bottomRows);

            if (key.upArrow) {

 setLogScroll((s) => clampScroll(s + 1, logs.lines.length, bottomRows)); return;

}
            if (key.downArrow) {

 setLogScroll((s) => Math.max(0, s - 1)); return;

}
            if (key.pageUp) {

 setLogScroll((s) => clampScroll(s + bottomRows, logs.lines.length, bottomRows)); return;

}
            if (key.pageDown) {

 setLogScroll((s) => Math.max(0, s - bottomRows)); return;

}
            if (key.escape) {

 setLogScroll(0); return;

} // jump back to live tail
            if (input === 'g') {

 setLogScroll(max); return;

} // oldest buffered
            if (input === 'G') {

 setLogScroll(0); return;

} // newest / live

}

        if (input === 'r') {

 void state.refresh(); return;

}
        if (input === '?') {

 setShowHelp((v) => !v); return;

}
        if (input === 'm') {

 setShowMenu((v) => !v); return;

}
        if (input === 'p') {

 setLogsPaused((v) => !v); return;

}
        if (input === 'a') {

            // Manually trigger an analysis with the current log buffer.
            void state.refreshRootCause(logs.lines);
            return;

}
        // Focus keys, numbered left→right, top→bottom across the layout.
        if (input === '1') {

 setFocus('diagnostics'); return;

}
        if (input === '2') {

 setFocus('health'); return;

}
        if (input === '3') {

 setFocus('tasks'); return;

}
        if (input === '4') {

 setFocus('deployments'); return;

}
        if (input === '5') {

 setFocus('events'); return;

}
        if (input === '6') {

 setFocus('logs'); return;

}

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

}, [failedRolloutId]); // eslint-disable-line react-hooks/exhaustive-deps

    const llmReady = useMemo(() => llmConfigured(), []);

    // Panel elements built once; the layout below arranges them as a 2×2 grid
    // over a wide Events/Logs row (wide) or a single stacked column (narrow).
    // In the grid, the four short panels flexGrow to match their row sibling's
    // height; stacked, they stay at natural height and only Events/Logs grow.
    const shortGrow = narrow ? undefined : 1;
    const diagnostics = (
        <DiagnosticsPanel
            diagnostics={state.diagnostics}
            analysis={state.rootCauseAnalysis}
            analyzing={state.rootCauseLoading}
            focused={focus === 'diagnostics'}
            llmAvailable={llmReady}
            flexGrow={shortGrow}
        />
    );
    const health = (
        <HealthPanel groups={state.targetHealth} focused={focus === 'health'} flexGrow={shortGrow} />
    );
    const tasks = (
        <TasksPanel running={state.runningTasks} stopped={state.stoppedTasks} focused={focus === 'tasks'} flexGrow={shortGrow} />
    );
    const deployments = (
        <DeploymentPanel deployments={state.service?.deployments ?? []} focused={focus === 'deployments'} flexGrow={shortGrow} />
    );
    const events = (
        <EventsPanel events={state.service?.events ?? []} focused={focus === 'events'} maxRows={bottomRows} flexGrow={1} />
    );
    const logs2 = (
        <LogsPanel
            lines={logs.lines}
            focused={focus === 'logs'}
            maxRows={bottomRows}
            scroll={logScroll}
            started={logs.started}
            error={logs.error}
            logGroup={state.logGroup}
            flexGrow={1}
        />
    );

    // height={rows} makes the app own the full alt-screen viewport; the bottom
    // (flexGrow) region eats the remaining height and pins the footer down.
    return (
        <Box flexDirection="column" height={rows}>
            <HeaderBar service={state.service} lastFetchedAt={state.lastFetchedAt} error={state.error} />
            {showHelp ? <Help /> : null}

            {narrow ? (
                // Stacked single column. Events/Logs grow to fill leftover height.
                <Box flexDirection="column" flexGrow={1}>
                    {diagnostics}
                    {health}
                    {tasks}
                    {deployments}
                    {events}
                    {logs2}
                </Box>
            ) : (
                <>
                    <Box flexDirection="row">
                        <GridCell>{diagnostics}</GridCell>
                        <GridCell>{health}</GridCell>
                    </Box>
                    <Box flexDirection="row">
                        <GridCell>{tasks}</GridCell>
                        <GridCell>{deployments}</GridCell>
                    </Box>
                    <Box flexDirection="row" flexGrow={1}>
                        <GridCell>{events}</GridCell>
                        <GridCell>{logs2}</GridCell>
                    </Box>
                </>
            )}

            <Footer showMenu={showMenu} />
        </Box>
    );

}

/** Equal-width grid column wrapper. flexBasis:0 + flexGrow:1 makes the two
 *  columns split the row evenly; overflow hidden guards against any stray
 *  content from widening a cell past its half. */
function GridCell({children}: {children: React.ReactNode}): React.ReactElement {

    return (
        <Box flexBasis={0} flexGrow={1} flexDirection="column" overflow="hidden">
            {children}
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
