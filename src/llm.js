import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

// LLM_PROVIDER=anthropic (default) speaks Anthropic's Messages API.
// LLM_PROVIDER=openai speaks the OpenAI-compatible chat/completions shape
// that OpenRouter, Groq, Together, and self-hosted Ollama/vLLM/llama.cpp
// servers all implement - so any open-weight model (Llama, DeepSeek, Qwen,
// Mistral, ...) works here too. See .env.example for the exact variables.

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_PATH = path.join(root, 'config/settings.json');
const SETTINGS_KEYS = [
  'provider', 'base_url', 'api_key', 'model',
  'anthropic_api_key', 'anthropic_model',
  'score_model', 'tailor_model', 'voyage_api_key',
];

/**
 * Provider config editable from the web Settings page, mirroring config.js's
 * profile.json pattern. Read fresh every call (no caching) so a save takes
 * effect on the next LLM call - no server restart. Missing file = {} = every
 * field falls through to the matching process.env var, same as before this
 * existed.
 */
export async function loadSettings() {
  try {
    return JSON.parse(await fs.readFile(SETTINGS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveSettings(patch) {
  const next = {};
  for (const k of SETTINGS_KEYS) {
    if (patch[k] !== undefined) next[k] = String(patch[k]).trim();
  }
  await fs.mkdir(path.dirname(SETTINGS_PATH), { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2) + '\n');
  return next;
}

/** settings.json value if set, else the env var - for one-off overrides like SCORE_MODEL/TAILOR_MODEL. */
export async function setting(settingsKey, envKey) {
  const settings = await loadSettings();
  return settings[settingsKey] || process.env[envKey] || '';
}

const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// `system` and a message's `content` may be a plain string or an array of
// Anthropic content blocks (used for prompt caching). OpenAI-compatible servers
// only understand strings, so flatten blocks to their concatenated text there.
const flatten = (v) =>
  typeof v === 'string' ? v : (v || []).map((b) => b.text ?? '').join('\n');

async function callAnthropic({ system, messages, maxTokens, temperature, model }, settings) {
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': settings.anthropic_api_key || process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: model || settings.anthropic_model || process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      temperature,
      system,
      messages,
    }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  return data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function callOpenAICompatible({ system, messages, maxTokens, temperature, model, json }, settings) {
  const base = (settings.base_url || process.env.LLM_BASE_URL || '').replace(/\/+$/, '');
  if (!base) throw new Error('LLM_BASE_URL is required when LLM_PROVIDER=openai (see .env.example, or set it in Settings)');
  const effModel = model || settings.model || process.env.LLM_MODEL;
  if (!effModel) throw new Error('LLM_MODEL is required when LLM_PROVIDER=openai (see .env.example, or set it in Settings)');
  system = flatten(system);
  messages = messages.map((m) => ({ ...m, content: flatten(m.content) }));

  // Reasoning models (Groq gpt-oss / qwen3) otherwise leak <think> blocks into
  // `content` and blow the token budget before the JSON closes. `reasoning_effort`
  // is a Groq/vLLM extension; harmless key on servers that ignore it.
  const reasoningEffort = process.env.LLM_REASONING_EFFORT || 'low';

  // Free tiers (esp. Groq) enforce a low tokens-per-minute cap and answer 429
  // with how long to wait. Honor it: sleep the suggested time and retry a few
  // times rather than dropping the job.
  const maxRetries = Number(process.env.LLM_MAX_RETRIES ?? 5);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Groq (and some others) sit behind Cloudflare, which 1010-bans the default
        // undici/node UA. Send a real one.
        'user-agent': 'job-agent/0.1 (personal job search)',
        // A local/self-hosted server (Ollama, vLLM, llama.cpp) usually needs no
        // key at all; a hosted one (OpenRouter, Groq, ...) does.
        ...((settings.api_key || process.env.LLM_API_KEY)
          ? { authorization: `Bearer ${settings.api_key || process.env.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: effModel,
        max_tokens: maxTokens,
        temperature,
        reasoning_effort: reasoningEffort,
        ...(json ? { response_format: { type: 'json_object' } } : {}),
        messages: [{ role: 'system', content: system }, ...messages],
      }),
      // Free-tier and self-hosted inference can be a lot slower than a paid API.
      signal: AbortSignal.timeout(Number(process.env.LLM_TIMEOUT_MS) || 180000),
    });
    if (res.ok) {
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }
    const body = (await res.text()).slice(0, 300);
    // 429 = rate limit (Groq); 503 = "high demand" (Gemini free tier). Both transient.
    if ((res.status === 429 || res.status === 503) && attempt < maxRetries) {
      const header = Number(res.headers.get('retry-after'));
      const fromMsg = Number(body.match(/try again in ([\d.]+)s/)?.[1]);
      const waitMs = Math.min((header || fromMsg || 2 ** attempt) * 1000 + 500, 60000);
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    throw new Error(`llm ${res.status}: ${body}`);
  }
}

/** One chat call, routed by settings.json's provider (falling back to LLM_PROVIDER). Returns plain text. */
export async function chat(opts) {
  const settings = await loadSettings();
  const provider = (settings.provider || process.env.LLM_PROVIDER || 'anthropic').toLowerCase();
  return provider === 'anthropic' ? callAnthropic(opts, settings) : callOpenAICompatible(opts, settings);
}

/** Same, but insists on parseable JSON and strips any stray fences. */
export async function chatJSON(opts) {
  const raw = await chat({ ...opts, json: true });
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')      // reasoning models that ignore reasoning_effort
    .replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error(`model did not return JSON: ${cleaned.slice(0, 200)}`);
  }
}

/** Voyage embeddings, optional. Returns null if no key is configured. */
export async function embed(texts) {
  const settings = await loadSettings();
  const voyageKey = settings.voyage_api_key || process.env.VOYAGE_API_KEY;
  if (!voyageKey) return null;
  const res = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${voyageKey}`,
    },
    body: JSON.stringify({
      input: texts.map((t) => t.slice(0, 8000)),
      model: process.env.VOYAGE_MODEL || 'voyage-3',
      output_dimension: 1024,
    }),
  });
  if (!res.ok) throw new Error(`voyage ${res.status}`);
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}
