// Tiny LLM fallback client. Modeled on phone-audit's `llmClient.ts` — same
// `provider:model` chain idea, same graceful degradation. Differences:
//
//   - We don't depend on brek (ecswatch is a standalone CLI that should run
//     on any laptop or CI runner). Config comes from env vars only:
//       ECSWATCH_LLM_MODELS=anthropic:claude-sonnet-4-6,openai:gpt-5
//       ANTHROPIC_API_KEY=…
//       OPENAI_API_KEY=…
//   - We never throw — callers always get a {status, ...} result. The CLI
//     should never blow up because Claude is down; degraded heuristic
//     diagnostics are the floor.

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

export type LlmProvider = 'anthropic' | 'openai';

export interface LlmRequest {
    systemPrompt: string;
    userPrompt: string;
    maxOutputTokens: number;
    timeoutMs: number;
}

export type LlmResult =
    | {status: 'ok'; provider: LlmProvider; model: string; text: string; elapsedMs: number}
    | {status: 'unavailable'; reason: string}
    | {status: 'failed'; attempts: Array<{provider: LlmProvider; model: string; error: string}>};

interface ModelSpec {
    provider: LlmProvider;
    model: string;
}

const DEFAULT_CHAIN: ModelSpec[] = [
    {provider: 'anthropic', model: 'claude-sonnet-4-6'},
    {provider: 'openai', model: 'gpt-5'},
];

function parseChain(raw: string | undefined): ModelSpec[] {
    if (!raw?.trim()) return DEFAULT_CHAIN;
    const out: ModelSpec[] = [];
    for (const piece of raw.split(',')) {
        const trimmed = piece.trim();
        const idx = trimmed.indexOf(':');
        if (idx <= 0 || idx === trimmed.length - 1) continue;
        const provider = trimmed.slice(0, idx).trim().toLowerCase();
        const model = trimmed.slice(idx + 1).trim();
        if (provider !== 'anthropic' && provider !== 'openai') continue;
        out.push({provider: provider as LlmProvider, model});
    }
    return out.length > 0 ? out : DEFAULT_CHAIN;
}

function apiKeyFor(provider: LlmProvider): string | null {
    if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY?.trim() || null;
    return process.env.OPENAI_API_KEY?.trim() || null;
}

function isReasoningModel(model: string): boolean {
    return model.startsWith('gpt-5')
        || model.startsWith('o1')
        || model.startsWith('o3')
        || model.startsWith('o4');
}

async function callAnthropic(apiKey: string, model: string, req: LlmRequest): Promise<string> {
    const client = new Anthropic({apiKey});
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    try {
        const msg = await client.messages.create({
            model,
            max_tokens: req.maxOutputTokens,
            system: req.systemPrompt,
            messages: [{role: 'user', content: req.userPrompt}],
        }, {signal: ctrl.signal});
        const text = msg.content
            .filter((b): b is Anthropic.TextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n')
            .trim();
        if (!text) throw new Error('empty_completion');
        return text;
    } finally {
        clearTimeout(timer);
    }
}

async function callOpenAI(apiKey: string, model: string, req: LlmRequest): Promise<string> {
    const client = new OpenAI({apiKey});
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), req.timeoutMs);
    const reasoning = isReasoningModel(model);
    const maxTokens = reasoning ? req.maxOutputTokens * 4 : req.maxOutputTokens;
    try {
        const resp = await client.responses.create({
            model,
            instructions: req.systemPrompt,
            input: req.userPrompt,
            max_output_tokens: maxTokens,
            ...(reasoning ? {reasoning: {effort: 'low'}} : {}),
        }, {signal: ctrl.signal});
        const text = (resp.output_text ?? '').trim();
        if (!text) throw new Error('empty_completion');
        return text;
    } finally {
        clearTimeout(timer);
    }
}

export async function callLlm(req: LlmRequest): Promise<LlmResult> {
    const chain = parseChain(process.env.ECSWATCH_LLM_MODELS);
    const attempts: Array<{provider: LlmProvider; model: string; error: string}> = [];
    let usable = 0;

    for (const spec of chain) {
        const key = apiKeyFor(spec.provider);
        if (!key) continue;
        usable++;
        const start = Date.now();
        try {
            const text = spec.provider === 'anthropic'
                ? await callAnthropic(key, spec.model, req)
                : await callOpenAI(key, spec.model, req);
            return {
                status: 'ok',
                provider: spec.provider,
                model: spec.model,
                text,
                elapsedMs: Date.now() - start,
            };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            attempts.push({provider: spec.provider, model: spec.model, error: msg});
        }
    }

    if (usable === 0) {
        return {
            status: 'unavailable',
            reason: 'no API key set for any provider in chain '
                + `(${chain.map((s) => `${s.provider}:${s.model}`).join(',')}). `
                + 'Set ANTHROPIC_API_KEY or OPENAI_API_KEY to enable LLM analysis.',
        };
    }
    return {status: 'failed', attempts};
}

/** True iff the user has set at least one usable API key. Cheap, no network. */
export function llmConfigured(): boolean {
    return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim());
}
