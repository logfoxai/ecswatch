// TUI mode runner. Boots the Ink app in the terminal's *alternate screen
// buffer* so it behaves like a real full-screen TUI (vim / htop / k9s):
// the screen is cleared and taken over on entry, and your original
// scrollback is restored verbatim on exit.
//
// Ink renders inline by default (into normal scrollback), which is why the
// app otherwise just appends frames and never "clears". We switch buffers
// manually with the standard DECSET sequences:
//   ESC [ ? 1049 h   enter alternate screen
//   ESC [ ? 1049 l   leave alternate screen
//
// We register the restore on `process.on('exit')` too, so an unexpected
// teardown can't strand the terminal in the alt buffer.

import {render} from 'ink';
import React from 'react';

import {App} from '../ui/App.js';
import type {CliContext} from '../types.js';

const ENTER_ALT_SCREEN = '\x1b[?1049h';
const LEAVE_ALT_SCREEN = '\x1b[?1049l';

export async function runTui(ctx: CliContext): Promise<number> {
    let restored = false;
    const restore = (): void => {
        if (restored) return;
        restored = true;
        process.stdout.write(LEAVE_ALT_SCREEN);
    };

    process.stdout.write(ENTER_ALT_SCREEN);
    process.on('exit', restore);

    const {waitUntilExit} = render(<App ctx={ctx} />, {
        exitOnCtrlC: false, // Ink swallows ctrl-c gracefully via our useInput hook.
    });

    try {
        await waitUntilExit();
    } finally {
        restore();
        process.removeListener('exit', restore);
    }
    return 0;
}
