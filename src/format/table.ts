// Minimal table renderer for snapshot/CI output.
//
// Designed to mimic the `kubectl get` / `docker ps` / `top` style: muted
// uppercase column headers, fixed-width columns, one row per record, no
// border chrome. Two-pass layout:
//
//   1. Each column declares a `text(row)` that returns the *plain* string
//      used to measure column width and (optionally) truncate.
//   2. The optional `color(row, text)` wraps the truncated plain text in
//      ANSI color. Column widths are computed from plain text so coloring
//      never throws off alignment.
//
// We intentionally don't use any third-party table library — none of them
// know how to measure width through chalk's ANSI escapes without help,
// and rolling our own is ~40 lines.

import {c} from '../theme.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Visible character count, ignoring ANSI SGR escapes. */
export function visibleLen(s: string): number {
    return s.replace(ANSI_RE, '').length;
}

export interface Column<T> {
    /** Column header label. Always rendered uppercase + muted. */
    header: string;
    /** Plain text for a cell — used for width measurement + truncation. */
    text: (row: T) => string;
    /** Optional color wrapper. Receives the (possibly truncated) plain text. */
    color?: (row: T, text: string) => string;
    align?: 'left' | 'right';
    /** Hard cap on column width; longer values get truncated with `…`. */
    maxWidth?: number;
    /** Soft minimum — useful when a column would otherwise collapse. */
    minWidth?: number;
}

export interface TableOptions {
    /** Leading indent applied to every row. Default `  `. */
    indent?: string;
    /** Inter-column gap. Default `  `. */
    gap?: string;
    /** Hide the header row (rarely useful). */
    noHeader?: boolean;
}

/** Returns the formatted lines (no trailing newline). */
export function table<T>(rows: T[], cols: Column<T>[], opts: TableOptions = {}): string[] {
    const indent = opts.indent ?? '  ';
    const gap = opts.gap ?? '  ';

    const widths: number[] = cols.map((col) => {
        let w = col.header.length;
        for (const row of rows) {
            const len = col.text(row).length;
            if (len > w) w = len;
        }
        if (col.minWidth && w < col.minWidth) w = col.minWidth;
        if (col.maxWidth && w > col.maxWidth) w = col.maxWidth;
        return w;
    });

    const lines: string[] = [];

    if (!opts.noHeader) {
        const lastIdx = cols.length - 1;
        const headers = cols.map((col, i) => {
            const w = widths[i] ?? 0;
            const text = col.header.toUpperCase();
            if (i === lastIdx && (col.align ?? 'left') === 'left') return c.muted(text);
            return c.muted(padPlain(text, w, col.align ?? 'left'));
        });
        lines.push(indent + headers.join(gap));
    }

    const last = cols.length - 1;
    for (const row of rows) {
        const cells = cols.map((col, i) => {
            const w = widths[i] ?? 0;
            const plain = truncate(col.text(row), w);
            const colored = col.color ? col.color(row, plain) : plain;
            // Skip trailing padding on the last left-aligned column — keeps
            // grep/diff output clean and avoids visible blank rectangles in
            // terminals that show whitespace.
            if (i === last && (col.align ?? 'left') === 'left') return colored;
            return padColored(colored, plain.length, w, col.align ?? 'left');
        });
        lines.push(indent + cells.join(gap));
    }

    return lines;
}

function padPlain(text: string, width: number, align: 'left' | 'right'): string {
    const pad = ' '.repeat(Math.max(0, width - text.length));
    return align === 'right' ? pad + text : text + pad;
}

function padColored(colored: string, plainLen: number, width: number, align: 'left' | 'right'): string {
    const pad = ' '.repeat(Math.max(0, width - plainLen));
    return align === 'right' ? pad + colored : colored + pad;
}

function truncate(text: string, width: number): string {
    if (text.length <= width) return text;
    if (width <= 1) return text.slice(0, width);
    return text.slice(0, width - 1) + '…';
}

/** Truncate a plain string to fit `width` (used outside tables). */
export function trunc(text: string, width: number): string {
    return truncate(text, width);
}

/** Available terminal width, with a sane fallback for piped output. */
export function termWidth(): number {
    return process.stdout.columns ?? 120;
}
