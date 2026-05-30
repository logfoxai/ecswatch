// Root-cause synthesis. Compose: heuristic diagnostics + recent events +
// stopped task details + tail of container logs → ask the LLM to produce
// a tight "what's broken, why, and how to fix it" answer. If the LLM is
// not configured / errors out, fall back to a heuristic summary built
// straight from the Diagnostic[] list.
//
// Output always conforms to RootCauseAnalysis. The TUI / CI mode renders
// the same shape regardless of source.

import type {
    Diagnostic,
    LogLine,
    RootCauseAnalysis,
    ServiceSnapshot,
    TargetHealthSnapshot,
    TaskSnapshot,
} from '../types.js';
import {callLlm, llmConfigured} from './llm.js';

interface AnalyzeInput {
    service: ServiceSnapshot;
    diagnostics: Diagnostic[];
    stoppedTasks: TaskSnapshot[];
    targetHealth: TargetHealthSnapshot[];
    /** Most recent log lines (we'll trim to a sane size before prompting). */
    recentLogs: LogLine[];
}

const SYSTEM_PROMPT = [
    'You are an SRE assistant analyzing an AWS ECS service deployment.',
    'You will receive a JSON snapshot containing the service state, ECS events,',
    'stopped task details, ALB target health, and a tail of CloudWatch logs.',
    '',
    'Output exactly three sections in this format and nothing else:',
    'SUMMARY: <one or two sentences naming the most likely root cause>',
    'CAUSES:',
    '- <bullet 1>',
    '- <bullet 2>',
    'FIXES:',
    '- <bullet 1>',
    '- <bullet 2>',
    '',
    'Rules:',
    '- Be specific: cite exit codes, error reasons, event messages, log lines.',
    '- If there is no clear failure, say "No failure detected" in SUMMARY and',
    '  give a brief health overview in CAUSES.',
    '- Never invent facts; if data is missing, say so.',
    '- Maximum 6 bullets total. Concise > exhaustive.',
].join('\n');

export async function rootCause(input: AnalyzeInput): Promise<RootCauseAnalysis> {
    // If nothing looks wrong, skip the LLM call entirely; we already know.
    const hasFailure = input.diagnostics.some((d) => d.severity === 'error');
    if (!hasFailure) {
        return heuristicSummary(input);
    }

    if (!llmConfigured()) return heuristicSummary(input);

    const start = Date.now();
    const result = await callLlm({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt: JSON.stringify(buildPromptPayload(input)),
        maxOutputTokens: 600,
        timeoutMs: 20_000,
    });

    if (result.status !== 'ok') {
        // Degrade silently — the heuristic summary always works.
        const fallback = heuristicSummary(input);
        return {
            ...fallback,
            // Leave a breadcrumb so the user knows we tried.
            summary: `${fallback.summary} (LLM unavailable; using heuristic analysis)`,
        };
    }

    const parsed = parseLlmResponse(result.text);
    return {
        source: 'llm',
        model: `${result.provider}:${result.model}`,
        summary: parsed.summary || 'No root cause produced.',
        likelyCauses: parsed.causes,
        suggestedFixes: parsed.fixes,
        elapsedMs: Date.now() - start,
    };
}

function buildPromptPayload(input: AnalyzeInput): unknown {
    const svc = input.service;
    return {
        service: {
            name: svc.serviceName,
            cluster: svc.clusterName,
            region: svc.region,
            status: svc.status,
            desired: svc.desiredCount,
            running: svc.runningCount,
            pending: svc.pendingCount,
            primaryTaskDefinition: svc.primaryTaskDefinition,
            deployments: svc.deployments.map((d) => ({
                status: d.status,
                taskDefinition: d.taskDefinition,
                rolloutState: d.rolloutState,
                rolloutStateReason: d.rolloutStateReason,
                desired: d.desiredCount,
                running: d.runningCount,
                pending: d.pendingCount,
                failed: d.failedTasks,
            })),
        },
        recentEvents: svc.events.slice(0, 12).map((e) => ({
            at: e.createdAt.toISOString(),
            severity: e.severity,
            message: e.message,
        })),
        diagnostics: input.diagnostics.map((d) => ({
            title: d.title,
            severity: d.severity,
            detail: d.detail,
        })),
        stoppedTasks: input.stoppedTasks.slice(0, 5).map((t) => ({
            shortId: t.shortId,
            taskDefinition: t.taskDefinition,
            stopCode: t.stopCode,
            stoppedReason: t.stoppedReason,
            stoppedAt: t.stoppedAt?.toISOString() ?? null,
            containers: t.containers.map((c) => ({
                name: c.name,
                exitCode: c.exitCode,
                reason: c.reason,
                image: c.image,
            })),
        })),
        targetHealth: input.targetHealth.map((g) => ({
            name: g.targetGroupName,
            targets: g.targets.map((t) => ({
                id: t.id,
                state: t.state,
                reason: t.reason,
                description: t.description,
            })),
        })),
        // Trim logs hard so we don't blow the prompt budget. Keep error/warn first.
        recentLogs: pickInterestingLogs(input.recentLogs, 50).map((l) => ({
            at: l.timestamp.toISOString(),
            severity: l.severity,
            message: l.message.slice(0, 500),
        })),
    };
}

function pickInterestingLogs(logs: LogLine[], cap: number): LogLine[] {
    const errors = logs.filter((l) => l.severity === 'error');
    const warns = logs.filter((l) => l.severity === 'warn');
    const rest = logs.filter((l) => l.severity !== 'error' && l.severity !== 'warn');
    const picked = [...errors, ...warns, ...rest.slice(-cap)];
    return picked.slice(-cap).sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
}

interface ParsedLlm {
    summary: string;
    causes: string[];
    fixes: string[];
}

function parseLlmResponse(text: string): ParsedLlm {
    let summary = '';
    const causes: string[] = [];
    const fixes: string[] = [];
    let section: 'summary' | 'causes' | 'fixes' | null = null;

    for (const rawLine of text.split('\n')) {
        const line = rawLine.trimEnd();
        if (!line.trim()) continue;
        const upper = line.toUpperCase();
        if (upper.startsWith('SUMMARY:')) {
            section = 'summary';
            summary = line.slice('SUMMARY:'.length).trim();
            continue;
        }
        if (upper.startsWith('CAUSES:')) { section = 'causes'; continue; }
        if (upper.startsWith('FIXES:')) { section = 'fixes'; continue; }

        if (section === 'summary' && !summary) {
            summary = line.trim();
            continue;
        }
        const bullet = line.replace(/^[-*•]\s*/, '').trim();
        if (!bullet) continue;
        if (section === 'causes') causes.push(bullet);
        else if (section === 'fixes') fixes.push(bullet);
    }

    return {summary, causes, fixes};
}

function heuristicSummary(input: AnalyzeInput): RootCauseAnalysis {
    const errors = input.diagnostics.filter((d) => d.severity === 'error');
    const warns = input.diagnostics.filter((d) => d.severity === 'warn');

    if (errors.length === 0 && warns.length === 0) {
        const svc = input.service;
        return {
            source: 'heuristic',
            summary: `${svc.serviceName} looks healthy — ${svc.runningCount}/${svc.desiredCount} running.`,
            likelyCauses: [],
            suggestedFixes: [],
            elapsedMs: 0,
        };
    }

    const summary = errors[0]?.title ?? warns[0]?.title ?? 'Service degraded.';
    const causes = [...errors, ...warns].slice(0, 5).map((d) => `${d.title}: ${d.detail}`);
    const fixes = [...errors, ...warns]
        .map((d) => d.suggestion)
        .filter((s): s is string => Boolean(s))
        .slice(0, 5);

    return {
        source: 'heuristic',
        summary,
        likelyCauses: causes,
        suggestedFixes: fixes,
        elapsedMs: 0,
    };
}
