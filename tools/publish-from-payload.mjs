#!/usr/bin/env node
/**
 * Publish a playbook provided as a JSON file (used by the publish-dispatch
 * workflow — the app sends the playbook via repository_dispatch). Validates,
 * re-ids to srv-<slug>, writes the playbook file + manifest entry. The workflow
 * then opens a PR; merging publishes.
 *
 * Usage: node tools/publish-from-payload.mjs <playbook.json>
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const src = process.argv[2];
if (!src) { console.error('Usage: node tools/publish-from-payload.mjs <playbook.json>'); process.exit(1); }

function slugify(s) {
  return String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}
function validate(pb) {
  const errs = [];
  if (!pb?.meta?.title) errs.push('meta.title missing');
  if (!Array.isArray(pb?.cards) || pb.cards.length === 0) errs.push('cards[] missing/empty');
  (pb?.cards ?? []).forEach((c, i) => {
    const ref = `card ${i + 1} (${c?.title ?? 'untitled'})`;
    if (c?.id == null) errs.push(`${ref}: missing id`);
    if (!c?.title) errs.push(`${ref}: missing title`);
    if (!c?.script) errs.push(`${ref}: missing script`);
    if (!c?.principle?.trim?.()) errs.push(`${ref}: missing principle`);
    if (!c?.counter?.trim?.()) errs.push(`${ref}: missing counter`);
  });
  return errs;
}

const pb = JSON.parse(readFileSync(src, 'utf8'));
const errs = validate(pb);
if (errs.length) {
  console.error('Validation failed:\n  - ' + errs.slice(0, 12).join('\n  - '));
  process.exit(1);
}

const id = `srv-${slugify(pb.meta.title)}`;
const now = new Date().toISOString();
pb.meta.id = id;
pb.meta.isSeeded = true;
pb.meta.fromServer = true;
pb.meta.createdAt = now;
pb.meta.totalCards = pb.cards.length;

const relUrl = `playbooks/playbook-${id}.json`;
const pbDir = join(REPO, 'playbooks');
if (!existsSync(pbDir)) mkdirSync(pbDir, { recursive: true });
writeFileSync(join(REPO, relUrl), JSON.stringify(pb, null, 2) + '\n');

const manifestPath = join(REPO, 'manifest.json');
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { manifestVersion: 0, playbooks: [] };
const existing = (manifest.playbooks || []).find(p => p.id === id);
const contentVersion = existing ? (existing.contentVersion ?? 1) + 1 : 1;
manifest.playbooks = (manifest.playbooks || []).filter(p => p.id !== id);
manifest.playbooks.push({
  id,
  title: pb.meta.title,
  theme: pb.meta.tags?.[0] || 'admin',
  topic: pb.meta.generation?.topic || '',
  cardCount: pb.cards.length,
  contentVersion,
  coverColor: pb.meta.coverColor || '',
  coverIcon: pb.meta.coverIcon || '',
  url: relUrl,
  addedAt: existing?.addedAt || now,
  minTier: 'pro',
});
manifest.manifestVersion = (manifest.manifestVersion || 0) + 1;
manifest.generatedAt = now;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT, `pb_id=${id}\npb_title=${pb.meta.title.replace(/\n/g, ' ')}\n`, { flag: 'a' });
}
console.log(`Published ${id} — "${pb.meta.title}" (${pb.cards.length} cards, v${contentVersion}). manifestVersion ${manifest.manifestVersion}.`);
