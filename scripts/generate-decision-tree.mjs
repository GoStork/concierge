#!/usr/bin/env node
/**
 * Reads server/ai-prompt-defaults.ts and generates decision-tree.html.
 * Fully structure-aware: auto-discovers every phase, cycle, step, and question.
 * Adding a new === PHASE ===, --- MATCH CYCLE ---, or STEP X / A1 / D3 to the
 * source file will automatically produce a new section + question card.
 *
 * Run:   node scripts/generate-decision-tree.mjs
 * Watch: node scripts/watch-decision-tree.mjs
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT   = resolve(__dirname, '..');
const SRC    = resolve(ROOT, 'server/ai-prompt-defaults.ts');
const OUT    = resolve(ROOT, 'decision-tree.html');

// ─────────────────────────────────────────────
// 1. EXTRACT conversation_flow CONTENT
// ─────────────────────────────────────────────

function extractConversationFlow(raw) {
  const idx = raw.indexOf('key: "conversation_flow"');
  if (idx === -1) return '';
  const backtickStart = raw.indexOf('content: `', idx);
  if (backtickStart === -1) return '';
  const start = backtickStart + 10;
  // Find the closing backtick: next ` followed (after optional spaces/newlines) by a comma
  let pos = start + 10;
  while (pos < raw.length) {
    const tick = raw.indexOf('`', pos);
    if (tick === -1) break;
    const after = raw.slice(tick + 1, tick + 10).trimStart();
    if (after.startsWith(',') || after.startsWith('}')) return raw.slice(start, tick);
    pos = tick + 1;
  }
  return raw.slice(start);
}

// ─────────────────────────────────────────────
// 2. PARSE STRUCTURAL MARKERS
// ─────────────────────────────────────────────

function findMarkers(content) {
  const markers = [];

  // === ... === markers
  const phaseRe = /^(===+)\s*([^=\n]+?)\s*\1/gm;
  let m;
  while ((m = phaseRe.exec(content)) !== null) {
    markers.push({ type: 'phase', title: m[2].trim(), index: m.index, endIndex: m.index + m[0].length });
  }

  // --- ... --- markers (match cycles only – skip pure separator lines)
  const cycleRe = /^(---+)\s*([^-\n]+?)\s*\1/gm;
  while ((m = cycleRe.exec(content)) !== null) {
    const title = m[2].trim();
    if (title && !/^-+$/.test(title)) {
      markers.push({ type: 'cycle', title, index: m.index, endIndex: m.index + m[0].length });
    }
  }

  markers.sort((a, b) => a.index - b.index);
  return markers;
}

// ─────────────────────────────────────────────
// 3. EXTRACT QUESTIONS FROM A CONTENT BLOCK
// ─────────────────────────────────────────────

// Save fields that can't be auto-detected from [[SAVE:...]] tags because they're described
// in prose rather than tagged syntax. Keyed by a pattern matched against section title.
const SECTION_SAVE_OVERRIDES = {
  'PHASE 1': ['gender', 'sexualOrientation', 'relationshipStatus', 'sameSexCouple'],
};

function extractQuestions(text, sectionTitle = '') {
  const lines = text.split('\n');

  // Patterns
  const stepRe   = /^(STEP\s+\d+[a-zA-Z]*)(?:\s*-[^:]+)?:\s*(.*)/i;
  const cycleQRe = /^\s{0,6}([A-D]\d+[a-zA-Z]*):\s+(.*)/;
  const qrRe     = /\[\[QUICK_REPLY:([^\]]+)\]\]/;
  const msRe     = /\[\[MULTI_SELECT:([^\]]+)\]\]/;
  const arrowRe  = /^[ \t]*→\s*(.*)/;
  const skipRe   = /^[ \t]*(SKIP|Skip)\s+(this|if|only|entirely|when)[\s:]+(.+)/i;

  function parseSaveFields(str) {
    const fields = new Set();
    const re = /\[\[SAVE:\{([^}]+)\}\]\]/g;
    let m;
    while ((m = re.exec(str)) !== null) {
      for (const km of m[1].matchAll(/"([^"]+)"\s*:/g)) fields.add(km[1]);
    }
    return [...fields];
  }

  function cleanText(raw) {
    let t = raw
      .replace(/^\s*[A-D]\d+[a-zA-Z]?:\s*/, '')
      .replace(/^STEP\s+\d+[a-zA-Z]*:\s*/i, '');
    const quoted = t.match(/"([^"]{4,}[?.])"/);
    if (quoted) t = quoted[1];
    return t.replace(/\[\[[^\]]+\]\]/g, '').trim();
  }

  function parseOptions(raw) {
    const qr = raw.match(qrRe);
    const ms = raw.match(msRe);
    return {
      quickReplies: qr ? qr[1].split('|').map(s => s.trim()) : null,
      multiSelect:  ms ? ms[1].split('|').map(s => s.trim()) : null,
    };
  }

  // ── PASS 1: single-pass extraction tracking line indices per question
  const rawQuestions = [];   // { ...question, startLine, endLine (exclusive) }
  let cur = null;
  // Saves collected from non-qualifying STEP headers (e.g. "STEP 2 - EGGS:")
  // These apply to all questions that follow until the next qualifying STEP resets them.
  let stepGroupSaves = [];

  function flush(nextLineIdx) {
    if (!cur) return;
    const hasOptions  = cur.quickReplies || cur.multiSelect;
    const hasQuote    = /"[^"]{5,}"/.test(cur.rawText);
    const hasQuestion = /\?/.test(cur.text);
    if (hasOptions || hasQuote || (hasQuestion && cur.label)) {
      cur.endLine = nextLineIdx;
      rawQuestions.push(cur);
    } else {
      // Non-qualifying step header - save its own accumulated saves as step-group context
      stepGroupSaves = [...new Set([...stepGroupSaves, ...cur.saveFields])];
    }
    cur = null;
  }

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();

    const stepMatch = trimmed.match(stepRe);
    if (stepMatch) {
      flush(i);
      // A qualifying step with a question (has quoted text or options) resets the step group.
      // A section header like "STEP 2 - EGGS:" doesn't reset – variants share those saves.
      const hasContent = stepMatch[2].trim().length > 0;
      if (!hasContent) stepGroupSaves = [];  // reset on section-header-style STEP
      const opts = parseOptions(stepMatch[2]);
      cur = {
        label: stepMatch[1].replace(/\s+/, ' ').toUpperCase(),
        rawText: stepMatch[2], text: cleanText(stepMatch[2]),
        ...opts, branches: [], skipConditions: [],
        saveFields: [...new Set([...stepGroupSaves, ...parseSaveFields(stepMatch[2])])],
        startLine: i, endLine: lines.length,
      };
      continue;
    }

    const cqMatch = trimmed.match(cycleQRe);
    if (cqMatch && /^[A-D]\d/.test(cqMatch[1])) {
      flush(i);
      let rest = cqMatch[2];
      if (!qrRe.test(rest) && !msRe.test(rest)) {
        for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
          const next = lines[j].trim();
          if (qrRe.test(next) || msRe.test(next)) { rest += ' ' + next; break; }
          if (next && !next.startsWith('→') && !next.startsWith('SKIP')) break;
        }
      }
      const opts = parseOptions(rest);
      cur = {
        label: cqMatch[1].toUpperCase(), rawText: rest, text: cleanText(rest),
        ...opts, branches: [], skipConditions: [],
        saveFields: [...new Set([...stepGroupSaves, ...parseSaveFields(rest)])],
        startLine: i, endLine: lines.length,
      };
      continue;
    }

    if ((qrRe.test(trimmed) || msRe.test(trimmed)) && !stepMatch && !cqMatch) {
      if (cur && !cur.quickReplies && !cur.multiSelect) {
        const opts = parseOptions(trimmed);
        cur.quickReplies = opts.quickReplies;
        cur.multiSelect  = opts.multiSelect;
        if (!cur.text) cur.text = cleanText(trimmed);
      } else {
        flush(i);
        const opts = parseOptions(trimmed);
        const text = cleanText(trimmed);
        if (text || opts.quickReplies || opts.multiSelect) {
          cur = {
            label: null, rawText: trimmed, text, ...opts,
            branches: [], skipConditions: [],
            saveFields: [...new Set([...stepGroupSaves, ...parseSaveFields(trimmed)])],
            startLine: i, endLine: lines.length,
          };
        }
      }
      continue;
    }

    // Collect saves + branches + skips into current question
    if (cur) {
      // FIX 1: scan EVERY line (not just → lines) for [[SAVE:...]] tags
      for (const f of parseSaveFields(trimmed)) {
        if (!cur.saveFields.includes(f)) cur.saveFields.push(f);
      }

      const arrowMatch = trimmed.match(arrowRe);
      if (arrowMatch) {
        const branch = arrowMatch[1]
          .replace(/\[\[SAVE:[^\]]+\]\]/g, '')
          .replace(/\[\[QUICK_REPLY:[^\]]+\]\]/g, '')
          .trim();
        if (branch) cur.branches.push(branch);
        continue;
      }

      const skipMatch = trimmed.match(skipRe);
      if (skipMatch) {
        cur.skipConditions.push((skipMatch[2] + ' ' + skipMatch[3]).trim());
      }
    } else {
      // No active question - accumulate saves into stepGroupSaves for upcoming questions
      for (const f of parseSaveFields(trimmed)) {
        if (!stepGroupSaves.includes(f)) stepGroupSaves.push(f);
      }
    }
  }
  flush(lines.length);

  // ── PASS 2: for each question, also scan lines AFTER it (up to the next question start)
  // This catches saves that appear at the END of a STEP section (after all variants).
  // FIX 2: propagate those end-of-section saves back to all questions in the same section.
  for (let i = 0; i < rawQuestions.length; i++) {
    const q = rawQuestions[i];
    const scanEnd = i + 1 < rawQuestions.length ? rawQuestions[i + 1].startLine : lines.length;
    for (let ln = q.endLine; ln < scanEnd; ln++) {
      for (const f of parseSaveFields(lines[ln])) {
        if (!q.saveFields.includes(f)) q.saveFields.push(f);
      }
    }
  }

  // FIX 3: propagate saves backward within anonymous question groups (same-step variants).
  // E.g. the egg-source question has 4 phrasings; only the last gets the [[SAVE:...]] tag.
  // All of them semantically save the same field, so spread saves across the group.
  for (let i = rawQuestions.length - 1; i >= 0; i--) {
    const q = rawQuestions[i];
    if (!q.label && q.saveFields.length > 0) {
      // Walk backward as long as questions are also unlabeled (same step variants)
      for (let j = i - 1; j >= 0 && !rawQuestions[j].label; j--) {
        for (const f of q.saveFields) {
          if (!rawQuestions[j].saveFields.includes(f)) rawQuestions[j].saveFields.push(f);
        }
      }
    }
  }

  // FIX 4: apply section-level save overrides for sections whose saves are in prose
  const overrideKey = Object.keys(SECTION_SAVE_OVERRIDES).find(k =>
    sectionTitle.toUpperCase().includes(k)
  );
  if (overrideKey) {
    const extraFields = SECTION_SAVE_OVERRIDES[overrideKey];
    for (const q of rawQuestions) {
      for (const f of extraFields) {
        if (!q.saveFields.includes(f)) q.saveFields.push(f);
      }
    }
  }

  // Strip internal tracking fields before returning
  return rawQuestions.map(({ startLine, endLine, ...q }) => q);
}

// ─────────────────────────────────────────────
// 4. BUILD TAB STRUCTURE
// ─────────────────────────────────────────────

function buildTabs(content, markers) {
  // Categorise each marker into top-level tabs vs sub-sections
  // Top-level tabs: numbered phases (PHASE 1, 2, 3, 4) and named cycles (MATCH CYCLE A/B/C/D)
  // Sub-sections:   PATH A/B, COUNTRY ROUTING, PROCESS TIMELINE, etc.

  const isMainPhase  = t => /^PHASE\s+\d/i.test(t);
  const isMainCycle  = t => /^MATCH CYCLE\s+[A-D]/i.test(t);
  const isPathOrSub  = t => !isMainPhase(t) && !isMainCycle(t);

  // Pre-Phase-1 content (the greeting, PATH A, PATH B, etc.) → "AI Intro" pseudo-tab
  const firstPhaseIdx = markers.findIndex(m => isMainPhase(m.title) && /PHASE\s+1/i.test(m.title));
  const introContent  = firstPhaseIdx > 0 ? content.slice(0, markers[firstPhaseIdx].index).trim() : '';
  const introMarkers  = firstPhaseIdx > 0 ? markers.slice(0, firstPhaseIdx) : [];

  const tabs = [];

  // AI Intro synthetic tab (Phase 0 equivalent)
  if (introContent || introMarkers.length) {
    const subsections = [];
    for (let i = 0; i < introMarkers.length; i++) {
      const start = introMarkers[i].endIndex;
      const end   = i + 1 < introMarkers.length ? introMarkers[i + 1].index : (firstPhaseIdx > 0 ? markers[firstPhaseIdx].index : content.length);
      subsections.push({
        title:     introMarkers[i].title,
        questions: extractQuestions(content.slice(start, end), introMarkers[i].title),
      });
    }
    const preContent = introMarkers.length ? content.slice(0, introMarkers[0].index) : introContent;
    tabs.push({
      id:           'phase-0',
      title:        'AI Intro (Phase 0)',
      description:  'Service confirmation, GoStork education, and engagement question. Always runs first.',
      questions:    extractQuestions(preContent, 'PHASE 0'),
      subsections,
    });
  }

  // Walk remaining markers to build main tabs
  const remaining = firstPhaseIdx >= 0 ? markers.slice(firstPhaseIdx) : markers;
  let currentTab = null;

  for (let i = 0; i < remaining.length; i++) {
    const marker      = remaining[i];
    const nextIndex   = i + 1 < remaining.length ? remaining[i + 1].index : content.length;
    const sectionText = content.slice(marker.endIndex, nextIndex).trim();

    if (isMainPhase(marker.title)) {
      currentTab = {
        id:          slugify(marker.title),
        title:       titleCase(marker.title),
        description: '',
        questions:   [],
        subsections: [],
      };
      tabs.push(currentTab);
      // Extract questions directly in this phase block (before any sub-marker)
      const firstSubIdx = remaining.slice(i + 1).findIndex(m => isPathOrSub(m.title));
      const firstCycleIdx = remaining.slice(i + 1).findIndex(m => isMainCycle(m.title));
      const stopAt = Math.min(
        firstSubIdx >= 0   ? remaining[i + 1 + firstSubIdx].index   : Infinity,
        firstCycleIdx >= 0 ? remaining[i + 1 + firstCycleIdx].index : Infinity,
        nextIndex
      );
      currentTab.questions = extractQuestions(content.slice(marker.endIndex, stopAt), marker.title);

    } else if (isMainCycle(marker.title)) {
      const phase3Tab = tabs.find(t => /phase.*3/i.test(t.id));
      const targetTab = phase3Tab || currentTab;
      if (targetTab) {
        targetTab.subsections.push({
          title:     titleCase(marker.title),
          questions: extractQuestions(sectionText, marker.title),
        });
      }

    } else if (isPathOrSub(marker.title) && currentTab) {
      currentTab.subsections.push({
        title:     titleCase(marker.title),
        questions: extractQuestions(sectionText, marker.title),
      });
    }
  }

  return tabs;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function titleCase(s) {
  // PHASE 2: BIOLOGICAL BASELINE → Phase 2: Biological Baseline
  return s
    .toLowerCase()
    .replace(/\b(ivf|pgt|usa|a|b|c|d|or|and|of|the|to|in|for)\b/g, m => m)
    .replace(/\b\w/g, c => c.toUpperCase());
}

// ─────────────────────────────────────────────
// 5. HTML RENDERING HELPERS
// ─────────────────────────────────────────────

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function chipsHTML(options, type = 'qr') {
  if (!options || !options.length) return '';
  const cls = type === 'ms' ? 'chip chip-ms' : 'chip';
  return `<div class="chips">${options.map(o => `<span class="${cls}">${esc(o)}</span>`).join('')}</div>`;
}

function renderQuestion(q, idx) {
  const labelBadge = q.label
    ? `<span class="qlabel">${esc(q.label)}</span>`
    : `<span class="qlabel qlabel-unlabeled">Q${idx + 1}</span>`;

  const hasText    = q.text && q.text.length > 3;
  const textHTML   = hasText ? `<div class="qtext">${esc(q.text)}</div>` : '';

  const optionsHTML = (q.quickReplies ? chipsHTML(q.quickReplies, 'qr') : '')
                    + (q.multiSelect  ? chipsHTML(q.multiSelect,  'ms') : '');

  const branchesHTML = q.branches.length
    ? `<div class="qbranches">${q.branches.map(b => `<div class="branch-item">→ ${esc(b)}</div>`).join('')}</div>`
    : '';

  const skipHTML = q.skipConditions.length
    ? `<div class="qskip">${q.skipConditions.map(s => `<span>Skip if: ${esc(s)}</span>`).join('')}</div>`
    : '';

  const saveHTML = q.saveFields && q.saveFields.length
    ? `<div class="qsave"><span class="save-label">Saves →</span>${q.saveFields.map(f => `<span class="save-field">${esc(f)}</span>`).join('')}</div>`
    : '';

  const nodeClass = q.multiSelect ? 'q-card q-multi' : (q.label ? 'q-card q-step' : 'q-card q-anon');

  return `
<div class="${nodeClass}">
  <div class="q-header">${labelBadge}${textHTML}</div>
  ${optionsHTML}
  ${saveHTML}
  ${branchesHTML}
  ${skipHTML}
</div>`;
}

function renderSection(section, depth = 0) {
  const hTag  = depth === 0 ? 'h3' : 'h4';
  const qHTML = section.questions.map((q, i) => renderQuestion(q, i)).join('\n<div class="q-arrow">▼</div>\n');

  return `
<div class="subsection depth-${depth}">
  <${hTag} class="sub-title">${esc(section.title)}</${hTag}>
  ${qHTML || '<div class="empty-section">No user-facing questions in this section - rules and logic only.</div>'}
</div>`;
}

function renderTab(tab) {
  const directQHTML = tab.questions.length
    ? tab.questions.map((q, i) => renderQuestion(q, i)).join('\n<div class="q-arrow">▼</div>\n')
    : '';
  const subHTML = tab.subsections.map(s => renderSection(s, 1)).join('\n');
  const hasContent = directQHTML || subHTML;

  return `
<div id="${esc(tab.id)}" class="section">
  <div class="sec-hdr">
    <h2>${esc(tab.title)}</h2>
    ${tab.description ? `<p>${esc(tab.description)}</p>` : ''}
  </div>
  <div class="tab-content">
    ${directQHTML}
    ${subHTML}
    ${!hasContent ? '<div class="empty-section">No questions found in this section.</div>' : ''}
  </div>
</div>`;
}

// ─────────────────────────────────────────────
// 6. STATIC TABS (Onboarding + Overview)
// ─────────────────────────────────────────────

function overviewTab(tabs) {
  const cards = [
    { tag: 't-ob', label: 'Onboarding', title: '6 screens before chat', body: 'Service selection, name, location, phone, OTP, account creation. Not in ai-prompt-defaults.ts.' },
    ...tabs.map(t => ({ tag: 't-phase', label: 'AI Prompt', title: t.title, body: `${countQuestions(t)} user-facing questions` })),
    { tag: 't-ru', label: 'Key Rule', title: 'One question per message', body: 'Never ask multiple questions in a single AI message. Wait for a response before the next.' },
    { tag: 't-ru', label: 'Key Rule', title: 'MATCH_CARD required', body: 'Every donor/surrogate recommendation MUST include [[MATCH_CARD:ID]]. Plain-text-only is forbidden.' },
  ];
  return `
<div id="overview" class="section active">
  <div class="sec-hdr">
    <h2>Full Flow Overview</h2>
    <p>All user-facing questions discovered automatically from <code>server/ai-prompt-defaults.ts</code>. Questions in order. Phases skip based on context.</p>
  </div>
  <div class="cards">
    ${cards.map(c => `<div class="card"><span class="ctag ${esc(c.tag)}">${esc(c.label)}</span><h4>${esc(c.title)}</h4><p>${esc(c.body)}</p></div>`).join('\n    ')}
  </div>
</div>`;
}

function onboardingTab() {
  return `
<div id="onboarding" class="section">
  <div class="sec-hdr"><h2>Onboarding Flow</h2><p>Defined in <code>client/src/pages/onboarding-page.tsx</code> - not in ai-prompt-defaults.ts.</p></div>
  <div class="tab-content">
    <div class="subsection depth-1"><h4 class="sub-title">Sequential Screens</h4>
    ${[
      { label: 'Screen 1', text: 'What are you looking for?', opts: ['Fertility Clinic', 'Egg Donor', 'Surrogate', 'Sperm Donor'], note: 'Multi-select', saves: ['selectedServices'] },
      { label: 'Screen 2', text: 'What is your name?', opts: [], note: 'First + Last. Providers will see it.', saves: ['firstName', 'lastName'] },
      { label: 'Screen 3', text: 'Where are you currently living?', opts: [], note: 'Autocomplete. Geolocation detects country.', saves: ['city', 'state', 'country'] },
      { label: 'Screen 4', text: 'What is your phone number?', opts: [], note: 'SMS or WhatsApp OTP.', saves: ['phoneNumber'] },
      { label: 'Screen 5', text: 'Enter the code you received', opts: [], note: '6-digit OTP. Loops on invalid.', saves: [] },
      { label: 'Screen 6', text: 'Create your account', opts: [], note: 'Email + Password. Error if email exists.', saves: ['email', 'password'] },
    ].map((s, i) => `
    ${i > 0 ? '<div class="q-arrow">▼</div>' : ''}
    <div class="q-card q-step">
      <div class="q-header"><span class="qlabel">${s.label}</span><div class="qtext">${s.text}</div></div>
      ${s.opts.length ? chipsHTML(s.opts) : ''}
      ${s.saves.length ? `<div class="qsave"><span class="save-label">Saves →</span>${s.saves.map(f => `<span class="save-field">${f}</span>`).join('')}</div>` : ''}
      ${s.note ? `<div class="qbranches"><div class="branch-item">${s.note}</div></div>` : ''}
    </div>`).join('')}
    </div>
  </div>
</div>`;
}

function countQuestions(tab) {
  let n = tab.questions.length;
  for (const s of tab.subsections) n += s.questions.length;
  return n;
}

// ─────────────────────────────────────────────
// 7. CSS + FULL HTML TEMPLATE
// ─────────────────────────────────────────────

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d12;color:#e5e7eb;min-height:100vh}
code{font-family:monospace;font-size:11px;background:#1a1a24;padding:1px 5px;border-radius:3px;color:#a78bfa}
header{background:#111118;border-bottom:1px solid #252535;padding:14px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
header h1{font-size:17px;font-weight:700;color:#fff}
header p{font-size:11px;color:#6b7280;margin-top:2px}
.gen-badge{background:#162b1f;color:#34d399;font-size:10px;font-weight:700;padding:4px 10px;border-radius:4px;border:1px solid #34d399;white-space:nowrap;flex-shrink:0;margin-left:16px}
nav{background:#111118;border-bottom:1px solid #252535;padding:0 28px;display:flex;gap:2px;overflow-x:auto}
nav button{background:none;border:none;padding:10px 13px;font-size:12px;font-weight:500;color:#6b7280;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;transition:color .12s}
nav button:hover{color:#d1d5db}
nav button.active{color:#a78bfa;border-bottom-color:#a78bfa}
.legend{display:flex;flex-wrap:wrap;gap:14px;padding:9px 28px;background:#111118;border-bottom:1px solid #252535}
.li{display:flex;align-items:center;gap:6px;font-size:11px;color:#9ca3af}
.ls{width:14px;height:10px;border-radius:2px}
main{padding:24px 28px;max-width:1300px;margin:0 auto}
.section{display:none}.section.active{display:block}
.sec-hdr{margin-bottom:20px}
.sec-hdr h2{font-size:19px;font-weight:700;color:#f3f4f6;margin-bottom:4px}
.sec-hdr p{font-size:13px;color:#6b7280;line-height:1.5}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-bottom:20px}
.card{background:#111118;border:1px solid #252535;border-radius:10px;padding:12px 15px}
.ctag{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;border-radius:3px;margin-bottom:6px}
.t-ob{background:#1e3a5f;color:#60a5fa}.t-phase{background:#2d1b4e;color:#a78bfa}.t-ru{background:#3b1f1f;color:#f87171}
.card h4{font-size:13px;font-weight:600;color:#e5e7eb;margin-bottom:3px}.card p{font-size:12px;color:#9ca3af;line-height:1.4}
/* ── FLOW LAYOUT */
.tab-content{display:flex;flex-direction:column;gap:0}
.subsection{margin-bottom:24px}
.subsection.depth-1{background:#111118;border:1px solid #252535;border-radius:10px;padding:18px 20px;margin-bottom:16px}
.sub-title{font-size:13px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.07em;margin-bottom:14px;padding-bottom:10px;border-bottom:1px solid #252535}
.q-arrow{display:flex;justify-content:center;align-items:center;height:22px;color:#4b5563;font-size:11px;position:relative}
.q-arrow::before{content:'';position:absolute;top:0;bottom:0;left:50%;width:2px;background:#252535;transform:translateX(-50%)}
.q-arrow span{position:relative;z-index:1;background:#0d0d12;padding:0 4px}
/* ── QUESTION CARDS */
.q-card{border-radius:8px;padding:12px 14px;margin:0 auto;width:100%;max-width:680px;border-left-width:4px;border-left-style:solid}
.q-step{background:#162b1f;border-color:#34d399;border-top-color:#252535;border-right-color:#252535;border-bottom-color:#252535}
.q-multi{background:#1e1535;border-color:#a78bfa;border-top-color:#252535;border-right-color:#252535;border-bottom-color:#252535}
.q-anon{background:#12181e;border-color:#3b82f6;border-top-color:#252535;border-right-color:#252535;border-bottom-color:#252535}
.q-header{display:flex;align-items:flex-start;gap:10px;margin-bottom:6px}
.qlabel{flex-shrink:0;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:4px;background:#1a3a2a;color:#34d399;margin-top:1px;white-space:nowrap}
.qlabel-unlabeled{background:#1e2a3a;color:#60a5fa}
.q-multi .qlabel{background:#2d1b4e;color:#a78bfa}
.qtext{font-size:13px;font-weight:600;color:#e5e7eb;line-height:1.4}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
.chip{background:rgba(52,211,153,.1);border:1px solid rgba(52,211,153,.25);border-radius:20px;padding:3px 9px;font-size:11px;color:#6ee7b7}
.chip-ms{background:rgba(167,139,250,.1);border-color:rgba(167,139,250,.25);color:#c4b5fd}
.qbranches{margin-top:8px;display:flex;flex-direction:column;gap:3px}
.branch-item{font-size:11px;color:#9ca3af;padding-left:8px;border-left:2px solid #252535;line-height:1.5}
.qskip{margin-top:6px;display:flex;flex-wrap:wrap;gap:4px}
.qskip span{font-size:10px;background:#2a1515;color:#f87171;padding:2px 8px;border-radius:4px;border:1px solid rgba(248,113,113,.2)}
.qsave{margin-top:7px;display:flex;flex-wrap:wrap;align-items:center;gap:5px}
.save-label{font-size:10px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;flex-shrink:0}
.save-field{font-size:11px;font-family:monospace;background:#1a1220;color:#f0abfc;padding:2px 8px;border-radius:4px;border:1px solid rgba(240,171,252,.25)}
.empty-section{font-size:12px;color:#4b5563;padding:12px;text-align:center;border:1px dashed #252535;border-radius:6px}
/* ── STAT BADGE */
.stat{font-size:11px;color:#6b7280;margin-left:8px;font-weight:normal}
`;

// ─────────────────────────────────────────────
// 8. MAIN – PARSE + GENERATE
// ─────────────────────────────────────────────

function generate() {
  const raw     = readFileSync(SRC, 'utf-8');
  const content = extractConversationFlow(raw);

  if (!content) {
    console.error('[decision-tree] Could not find conversation_flow section in', SRC);
    process.exit(1);
  }

  const markers = findMarkers(content);
  const tabs    = buildTabs(content, markers);

  const timestamp = new Date().toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const totalQ = tabs.reduce((n, t) => n + countQuestions(t), 0);

  // Build nav buttons
  const navButtons = [
    `<button class="active" onclick="show('overview',this)">Overview</button>`,
    `<button onclick="show('onboarding',this)">Onboarding</button>`,
    ...tabs.map(t => {
      const count = countQuestions(t);
      return `<button onclick="show('${esc(t.id)}',this)">${esc(t.title)}<span class="stat">${count}q</span></button>`;
    }),
  ].join('\n  ');

  const sectionHTML = [
    overviewTab(tabs),
    onboardingTab(),
    ...tabs.map(renderTab),
  ].join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>GoStork - Question Decision Tree</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div>
    <h1>GoStork &mdash; Question Decision Tree</h1>
    <p>Auto-generated from <code>server/ai-prompt-defaults.ts</code> &mdash; ${timestamp} &mdash; ${totalQ} questions discovered</p>
  </div>
  <span class="gen-badge">&#9889; Live from source</span>
</header>
<nav>
  ${navButtons}
</nav>
<div class="legend">
  <div class="li"><div class="ls" style="background:#162b1f;border:1px solid #34d399"></div>Question with quick replies</div>
  <div class="li"><div class="ls" style="background:#1e1535;border:1px solid #a78bfa"></div>Multi-select question</div>
  <div class="li"><div class="ls" style="background:#12181e;border:1px solid #3b82f6"></div>Open-ended question</div>
  <div class="li"><div class="ls" style="background:#2a1515;border:1px solid #f87171"></div>Skip condition</div>
</div>
<main>
${sectionHTML}
</main>
<script>
function show(id, btn) {
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
  document.getElementById(id).classList.add('active');
  btn.classList.add('active');
}
</script>
</body>
</html>`;

  writeFileSync(OUT, html, 'utf-8');
  console.log(`[decision-tree] Generated ${OUT}`);
  console.log(`[decision-tree] ${tabs.length} tabs, ${totalQ} questions from ${markers.length} structural markers`);
}

generate();
