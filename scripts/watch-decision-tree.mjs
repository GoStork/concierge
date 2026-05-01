#!/usr/bin/env node
/**
 * Watches server/ai-prompt-defaults.ts and regenerates decision-tree.html on every save.
 * Run: node scripts/watch-decision-tree.mjs
 */

import { watch } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'server/ai-prompt-defaults.ts');
const GEN = resolve(__dirname, 'generate-decision-tree.mjs');

function generate() {
  try {
    execFileSync(process.execPath, [GEN], { stdio: 'inherit' });
  } catch (e) {
    console.error('[decision-tree] Generation failed:', e.message);
  }
}

// Generate immediately on start
console.log('[decision-tree] Generating on startup...');
generate();

// Debounce - fs.watch can fire multiple times per save
let debounceTimer = null;

console.log(`[decision-tree] Watching ${SRC}`);
console.log('[decision-tree] Edit ai-prompt-defaults.ts and save - decision-tree.html will update automatically.');
console.log('[decision-tree] Press Ctrl+C to stop.\n');

watch(SRC, (eventType) => {
  if (eventType !== 'change') return;
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    console.log(`[decision-tree] Change detected - regenerating...`);
    generate();
  }, 300);
});
