// Logfox ad — shown at the bottom of the interactive TUI (mirrors the
// open-prs ad bar). Kept out of CI / snapshot output to avoid polluting
// logs. Single source of truth for the copy + link.

export const AD_URL = 'https://app.logfox.ai';
export const AD_TEXT = 'Logfox — Sniff out issues. AI-powered log observability →';

/** Wrap text in an OSC 8 hyperlink (clickable in modern terminals). */
export function osc8(url: string, text: string): string {

    return `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

}
