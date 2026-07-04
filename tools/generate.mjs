#!/usr/bin/env node
/**
 * Daily playbook generator (Phase 2b). Runs in GitHub Actions, generates ONE
 * playbook with our keys, validates it, and writes the playbook file + manifest
 * entry. The workflow then opens a PR for review — nothing reaches customers
 * until a human merges.
 *
 * Env: ANTHROPIC_API_KEY (required), TAVILY_API_KEY (optional — skips web
 * grounding if absent), MODEL (default claude-sonnet-4-6), TOPIC_INDEX (optional
 * override; default = day-of-year % topics.length).
 *
 * system-prompt.txt mirrors the app's SYSTEM_PROMPT (src/services/aiService.ts).
 * Re-copy it if the app prompt changes. The PR review gate catches any drift.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const MODEL = process.env.MODEL || 'claude-sonnet-4-6';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const TAVILY_KEY = process.env.TAVILY_API_KEY;

if (!ANTHROPIC_KEY) {
  console.error('ANTHROPIC_API_KEY is required.');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: ANTHROPIC_KEY });

// Structured-output schema (mirrors the app's PLAYBOOK_JSON_SCHEMA). Guarantees
// schema-valid JSON so the invalid-JSON / dropped-required-field failure classes
// can't reach the PR. Exact card count is still enforced in validate() below —
// structured outputs can't constrain array length.
const PLAYBOOK_SCHEMA = JSON.parse(readFileSync(join(HERE, 'playbook-schema.json'), 'utf8'));

// Adaptive thinking + effort aren't supported on Haiku (both 400 there); every
// other current model takes them. Match the app's anthropicTuning() guard.
const supportsTuning = !MODEL.startsWith('claude-haiku');

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0);
  return Math.floor((d - start) / 86400000);
}
function stripFence(s) {
  return String(s).replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

// --- pick today's topic ---
const topics = JSON.parse(readFileSync(join(HERE, 'topics.json'), 'utf8'));
// GitHub Actions passes an unset dispatch input / schedule event as an EMPTY
// STRING, and Number('') is 0 — which used to pin every run to topics[0]. Only
// honor TOPIC_INDEX when it's a real number; otherwise rotate by day-of-year.
const rawIdx = process.env.TOPIC_INDEX;
const hasIdx = rawIdx != null && rawIdx.trim() !== '' && Number.isFinite(Number(rawIdx));
const idx = (hasIdx ? Number(rawIdx) : dayOfYear(new Date())) % topics.length;
const { topic, cardCount, tone } = topics[idx];
console.log(`Topic [${idx}]: "${topic}" (${cardCount} cards, ${tone})`);

// --- Tavily web grounding (optional) ---
async function tavily(query) {
  if (!TAVILY_KEY) return '';
  try {
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TAVILY_KEY}` },
      body: JSON.stringify({ query, max_results: 6, search_depth: 'advanced' }),
    });
    if (!res.ok) { console.warn(`Tavily ${res.status} — generating without sources.`); return ''; }
    const json = await res.json();
    const results = Array.isArray(json.results) ? json.results : [];
    if (!results.length) return '';
    const body = results
      .map((r, i) => `[Source ${i + 1}] ${(r.title || '').trim()}\nURL: ${r.url}\n${(r.content || '').replace(/\s+/g, ' ').trim()}`)
      .join('\n\n---\n\n');
    return `Source material gathered from web search for: "${query}". Ground the playbook in the tactics, examples, and frameworks below — do not invent material not supported here.\n\n${body}`;
  } catch (e) {
    console.warn('Tavily failed — generating without sources:', e.message);
    return '';
  }
}

// --- build prompts (mirrors the app's buildUserPrompt) ---
const SYSTEM = readFileSync(join(HERE, 'system-prompt.txt'), 'utf8');
function buildUser(sourceTranscript) {
  const parts = [
    `Topic: ${topic}`,
    `Generate EXACTLY ${cardCount} cards. The "cards" array MUST contain ${cardCount} entries — count them. Do NOT return fewer.`,
    `Categories: pick 5-7 categories that fit the topic. Use whichever organization works best.`,
    `Tone: ${tone}`,
    '',
    `createdAt should be: ${new Date().toISOString()}`,
    '',
  ];
  if (sourceTranscript) {
    parts.push(
      'SOURCE MATERIAL — ground every card in the tactics, examples, frameworks, and moves described below. If the source repeats itself, deduplicate. Do not invent stories the source did not tell.',
      '---BEGIN SOURCE---', sourceTranscript, '---END SOURCE---', '',
    );
  }
  parts.push('Output the JSON only. No markdown fences, no preamble.');
  return parts.join('\n');
}

// --- Anthropic call (official SDK, streaming) ---
// Streaming keeps the connection alive during the multi-minute generation so it
// can't hit an HTTP idle timeout, and lets max_tokens grow without risk.
// finalMessage() reassembles the whole response — no per-event handling needed.
//
// This bot generates the WHOLE playbook in one call (unlike the app, which
// batches ~3 cards per request). With adaptive thinking on, the thinking phase
// and the full JSON output share max_tokens — so the budget must be generous or
// the model spends it all thinking and returns a thinking block with no text
// ("Empty completion"). Hence 32k tokens + medium (not high) effort: plenty for
// a reviewed daily card, and it leaves ample room for the output.
async function generate(userPrompt) {
  const outputConfig = { format: { type: 'json_schema', schema: PLAYBOOK_SCHEMA } };
  if (supportsTuning) outputConfig.effort = 'medium';

  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: 32000,
    ...(supportsTuning ? { thinking: { type: 'adaptive' } } : {}),
    output_config: outputConfig,
    system: SYSTEM,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const final = await stream.finalMessage();

  // Safety classifiers can decline (HTTP 200, stop_reason "refusal"). Surface it
  // as a hard failure so the run stops instead of writing an empty playbook.
  if (final.stop_reason === 'refusal') {
    throw new Error('Model refused this topic (stop_reason=refusal).');
  }
  // With adaptive thinking on, content[0] is a thinking block — select the text
  // block, don't index [0].
  const text = (final.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('');
  if (!text) {
    // Diagnose the common cause (ran out of budget mid-thinking) instead of a
    // bare "empty" — surface stop_reason + how many output tokens were spent.
    const stop = final.stop_reason ?? 'unknown';
    const out = final.usage?.output_tokens ?? '?';
    throw new Error(
      `Empty completion (stop_reason=${stop}, output_tokens=${out}). ` +
        `If stop_reason=max_tokens, raise max_tokens or lower effort.`,
    );
  }
  return text;
}

// --- validation (mirrors validateAiPlaybook's hard rules) ---
function validate(pb) {
  const errs = [];
  if (!pb?.meta?.title) errs.push('meta.title missing');
  if (!Array.isArray(pb?.cards) || pb.cards.length === 0) errs.push('cards[] missing/empty');
  else {
    if (pb.cards.length !== cardCount) errs.push(`expected ${cardCount} cards, got ${pb.cards.length}`);
    pb.cards.forEach((c, i) => {
      const ref = `card ${i + 1} (${c?.title ?? 'untitled'})`;
      if (c?.id == null) errs.push(`${ref}: missing id`);
      if (!c?.title) errs.push(`${ref}: missing title`);
      if (!c?.script) errs.push(`${ref}: missing script`);
      if (!c?.principle?.trim?.()) errs.push(`${ref}: missing principle`);
      if (!c?.counter?.trim?.()) errs.push(`${ref}: missing counter`);
    });
  }
  return errs;
}

// --- run ---
const source = await tavily(topic);
const raw = await generate(buildUser(source));
let pb;
try {
  pb = JSON.parse(stripFence(raw));
} catch (e) {
  console.error('Model did not return valid JSON:', e.message);
  console.error(raw.slice(0, 500));
  process.exit(1);
}
const errs = validate(pb);
if (errs.length) {
  console.error('Validation failed:\n  - ' + errs.slice(0, 12).join('\n  - '));
  process.exit(1);
}

// --- stamp server-content fields + write ---
const id = `srv-${slugify(pb.meta.title)}`;
const now = new Date().toISOString();
pb.meta.id = id;
pb.meta.isSeeded = true;
pb.meta.fromServer = true;
pb.meta.createdAt = now;
pb.meta.totalCards = pb.cards.length;
if (!pb.meta.generation) pb.meta.generation = { topic, cardCount: pb.cards.length, categories: [], tone };

const relUrl = `playbooks/playbook-${id}.json`;
const pbDir = join(REPO, 'playbooks');
if (!existsSync(pbDir)) mkdirSync(pbDir, { recursive: true });
writeFileSync(join(REPO, relUrl), JSON.stringify(pb, null, 2) + '\n');

const manifestPath = join(REPO, 'manifest.json');
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { manifestVersion: 0, playbooks: [] };
manifest.playbooks = (manifest.playbooks || []).filter(p => p.id !== id);
manifest.playbooks.push({
  id,
  title: pb.meta.title,
  theme: pb.meta.tags?.[0] || 'defense',
  topic,
  cardCount: pb.cards.length,
  contentVersion: 1,
  coverColor: pb.meta.coverColor || '',
  coverIcon: pb.meta.coverIcon || '',
  url: relUrl,
  addedAt: now,
  minTier: 'pro',
});
manifest.manifestVersion = (manifest.manifestVersion || 0) + 1;
manifest.generatedAt = now;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// Expose the title/id to the workflow (for the PR title) via GITHUB_OUTPUT.
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `pb_id=${id}\npb_title=${pb.meta.title.replace(/\n/g, ' ')}\n`, { flag: 'a' });
}
console.log(`Generated ${id} — "${pb.meta.title}" (${pb.cards.length} cards). manifestVersion ${manifest.manifestVersion}.`);
