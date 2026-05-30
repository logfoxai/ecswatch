// Tiny helper for GitHub Actions log annotations. These commands appear
// inline in the Actions web UI as collapsible groups (`::group::`),
// surface as PR check annotations (`::error::`, `::warning::`,
// `::notice::`), and trigger the "View detail" link from a failed step.
//
// We strip these commands cleanly when not running in CI so local users
// get plain colored output. Detection follows the convention used by
// most tools: `CI=true` or `GITHUB_ACTIONS=true`.
//
// Note on colors: GitHub Actions' web log viewer renders 24-bit ANSI
// faithfully — we still emit colored text inside groups; the annotation
// commands are separate from the colored body.

const IN_GITHUB = process.env.GITHUB_ACTIONS === 'true';
const IN_CI = process.env.CI === 'true' || IN_GITHUB;

export const ci = {
    inCi: IN_CI,
    inGithub: IN_GITHUB,
};

function escape(value: string): string {
    return value.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function escapeProp(value: string): string {
    return escape(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
}

export function group(title: string): void {
    if (IN_GITHUB) process.stdout.write(`::group::${escape(title)}\n`);
}

export function endGroup(): void {
    if (IN_GITHUB) process.stdout.write('::endgroup::\n');
}

interface AnnotationProps {
    title?: string;
    file?: string;
    line?: number;
    col?: number;
}

function fmtProps(props: AnnotationProps | undefined): string {
    if (!props) return '';
    const parts: string[] = [];
    if (props.title) parts.push(`title=${escapeProp(props.title)}`);
    if (props.file) parts.push(`file=${escapeProp(props.file)}`);
    if (props.line) parts.push(`line=${props.line}`);
    if (props.col) parts.push(`col=${props.col}`);
    return parts.length === 0 ? '' : ` ${parts.join(',')}`;
}

export function notice(message: string, props?: AnnotationProps): void {
    if (IN_GITHUB) process.stdout.write(`::notice${fmtProps(props)}::${escape(message)}\n`);
}

export function warning(message: string, props?: AnnotationProps): void {
    if (IN_GITHUB) process.stdout.write(`::warning${fmtProps(props)}::${escape(message)}\n`);
}

export function error(message: string, props?: AnnotationProps): void {
    if (IN_GITHUB) process.stdout.write(`::error${fmtProps(props)}::${escape(message)}\n`);
}

/** Wrap a chunk of work in a collapsible CI group; safe no-op outside CI. */
export async function withGroup<T>(title: string, fn: () => Promise<T> | T): Promise<T> {
    group(title);
    try {
        return await fn();
    } finally {
        endGroup();
    }
}
