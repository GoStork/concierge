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

// Extract a short destination label from a branch text line
function extractDest(branchText) {
  const m = branchText.match(/(?:go to|proceed to|skip to|start with|enter)\s+(STEP\s+\d+[a-zA-Z]*|[A-D]\d+[a-zA-Z]*|PROGRESSIVE MATCH CYCLES|PHASE\s+\d)/i);
  if (m) return m[1].toUpperCase();
  if (/PROGRESSIVE MATCH CYCLES/i.test(branchText)) return 'MATCH CYCLES';
  if (/proceed to match cycles/i.test(branchText)) return 'MATCH CYCLES';
  return null;
}

// Try to pair each quickReply with the branch that describes it
function pairBranches(quickReplies, branches) {
  if (!quickReplies || !quickReplies.length) return [];
  return quickReplies.map(reply => {
    const rLow = reply.toLowerCase().replace(/[^a-z0-9 ]/g, '');
    // Try direct substring match first
    let matched = branches.find(b => {
      const bLow = b.toLowerCase();
      return bLow.includes(`"${reply.toLowerCase()}"`) || bLow.includes(rLow.slice(0, 10));
    });
    // Fallback: keyword match for common yes/no patterns
    if (!matched) {
      if (/^yes/i.test(reply))         matched = branches.find(b => /\byes\b|\bif yes\b/i.test(b));
      else if (/^no[,\s]/i.test(reply) || reply.toLowerCase() === 'no') matched = branches.find(b => /\bno\b|\bif no\b/i.test(b));
      else if (/already have/i.test(reply)) matched = branches.find(b => /already have/i.test(b));
      else if (/need help|finding/i.test(reply)) matched = branches.find(b => /need|finding/i.test(b));
      else if (/solo/i.test(reply))    matched = branches.find(b => /solo/i.test(b));
      else if (/partner/i.test(reply)) matched = branches.find(b => /partner/i.test(b));
    }
    const dest = matched ? extractDest(matched) : null;
    return { reply, dest };
  });
}

function renderQuestion(q, idx) {
  const isStep  = !!q.label;
  const isMulti = !!q.multiSelect;
  const nodeColor = isMulti ? 'multi' : (isStep ? 'step' : 'anon');

  const labelHTML = q.label
    ? `<span class="nlabel nlabel-${nodeColor}">${esc(q.label)}</span>`
    : `<span class="nlabel nlabel-anon">Q${idx + 1}</span>`;

  const textHTML = (q.text && q.text.length > 3)
    ? `<div class="nquestion">${esc(q.text)}</div>`
    : '';

  const saveHTML = (q.saveFields && q.saveFields.length)
    ? `<div class="nsave">${q.saveFields.map(f => `<span class="nsave-field">${esc(f)}</span>`).join('')}</div>`
    : '';

  const skipHTML = q.skipConditions.length
    ? `<div class="nskip">${q.skipConditions.map(s => `<span class="nskip-pill">skip if: ${esc(s)}</span>`).join('')}</div>`
    : '';

  // Build the branch fork from answers
  const opts   = q.quickReplies || q.multiSelect;
  const paired = opts ? pairBranches(opts, q.branches) : [];
  const chipType = isMulti ? 'multi' : 'qr';

  let branchHTML = '';
  if (paired.length) {
    const branchItems = paired.map(({ reply, dest }) => `
      <div class="fork-branch">
        <div class="fork-line"></div>
        <div class="fork-chip fork-chip-${chipType}">${esc(reply)}</div>
        ${dest ? `<div class="fork-dest">→ ${esc(dest)}</div>` : ''}
      </div>`).join('');
    branchHTML = `<div class="fork-row">${branchItems}</div>`;
  } else if (q.branches.length) {
    // No chips but has branch logic - show as compact list
    const items = q.branches.map(b => `<div class="nbranch-item">${esc(b)}</div>`).join('');
    branchHTML = `<div class="nbranches">${items}</div>`;
  }

  return `
<div class="tree-node">
  <div class="node-box node-${nodeColor}">
    <div class="node-hdr">${labelHTML}${textHTML}</div>
    ${saveHTML}
    ${skipHTML}
  </div>
  ${branchHTML}
</div>`;
}

function renderSection(section, depth = 0) {
  const hTag = depth === 0 ? 'h3' : 'h4';
  const qHTML = section.questions
    .map((q, i) => renderQuestion(q, i))
    .join('\n<div class="tree-connector"></div>\n');

  return `
<div class="subsection depth-${depth}">
  <${hTag} class="sub-title">${esc(section.title)}</${hTag}>
  <div class="tree-flow">
    ${qHTML || '<div class="empty-section">No user-facing questions in this section - rules and logic only.</div>'}
  </div>
</div>`;
}

function renderTab(tab) {
  const directQHTML = tab.questions.length
    ? tab.questions.map((q, i) => renderQuestion(q, i)).join('\n<div class="tree-connector"></div>\n')
    : '';
  const subHTML = tab.subsections.map(s => renderSection(s, 1)).join('\n');
  const hasContent = directQHTML || subHTML;
  // Show persona banner on Phase 2 (biological baseline) tab
  const showPersonas = /phase.*2|biological/i.test(tab.id + tab.title);

  return `
<div id="${esc(tab.id)}" class="section">
  <div class="sec-hdr">
    <h2>${esc(tab.title)}</h2>
    ${tab.description ? `<p>${esc(tab.description)}</p>` : ''}
  </div>
  ${showPersonas ? personaBannerHTML() : ''}
  <div class="tab-content">
    ${directQHTML ? `<div class="tree-flow">${directQHTML}</div>` : ''}
    ${subHTML}
    ${!hasContent ? '<div class="empty-section">No questions found in this section.</div>' : ''}
  </div>
</div>`;
}


// ─────────────────────────────────────────────
// 6. STATIC TABS (Onboarding + Overview)
// ─────────────────────────────────────────────

const PERSONAS = [
  { icon: '👨', label: 'Solo Man',       bio: 'Sperm: own/donor\nEggs: always donor\nCarrier: always surrogate' },
  { icon: '👩', label: 'Solo Woman',     bio: 'Sperm: always donor\nEggs: own/donor\nCarrier: self or surrogate' },
  { icon: '👨‍👨‍👦', label: 'Two Dads',      bio: 'Sperm: Partner A/B/donor\nEggs: always donor\nCarrier: always surrogate' },
  { icon: '👩‍👩‍👦', label: 'Two Moms',      bio: 'Sperm: always donor\nEggs: A/B/donor\nCarrier: A/B/surrogate' },
  { icon: '👫', label: 'A Man & Woman',  bio: 'Sperm: own/donor\nEggs: own/donor\nCarrier: partner or surrogate' },
];

function personaBannerHTML() {
  return `
<div class="persona-banner">
  <div class="persona-banner-title">Family types - biology reference (from FERTILITY BIOLOGY prompt section)</div>
  ${PERSONAS.map((p, i) => `
  <div class="persona-card${i === 0 ? ' active' : ''}" onclick="selectPersona(this)">
    <div class="persona-icon">${p.icon}</div>
    <div class="persona-label">${p.label}</div>
    <div class="persona-bio">${p.bio.replace(/\n/g, '<br>')}</div>
  </div>`).join('')}
</div>`;
}

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
  ${personaBannerHTML()}
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
    ${i > 0 ? '<div class="tree-connector"></div>' : ''}
    <div class="tree-node">
      <div class="node-box node-step">
        <div class="node-hdr"><span class="nlabel nlabel-step">${s.label}</span><div class="nquestion">${s.text}</div></div>
        ${s.saves.length ? `<div class="nsave">${s.saves.map(f => `<span class="nsave-field">${f}</span>`).join('')}</div>` : ''}
        ${s.note ? `<div class="nbranches"><div class="nbranch-item">${s.note}</div></div>` : ''}
      </div>
      ${s.opts.length ? `<div class="fork-row">${s.opts.map(o => `<div class="fork-branch"><div class="fork-line"></div><div class="fork-chip fork-chip-qr">${o}</div></div>`).join('')}</div>` : ''}
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
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a10;color:#e5e7eb;min-height:100vh}
code{font-family:monospace;font-size:11px;background:#1a1a24;padding:1px 5px;border-radius:3px;color:#a78bfa}

/* ── HEADER */
header{background:#111118;border-bottom:1px solid #1e1e2e;padding:14px 28px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100}
header h1{font-size:17px;font-weight:700;color:#fff}
header p{font-size:11px;color:#6b7280;margin-top:2px}
.gen-badge{background:#162b1f;color:#34d399;font-size:10px;font-weight:700;padding:4px 10px;border-radius:4px;border:1px solid #34d399;white-space:nowrap;flex-shrink:0;margin-left:16px}

/* ── NAV */
nav{background:#111118;border-bottom:1px solid #1e1e2e;padding:0 28px;display:flex;gap:2px;overflow-x:auto}
nav button{background:none;border:none;padding:10px 13px;font-size:12px;font-weight:500;color:#6b7280;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap;transition:color .12s}
nav button:hover{color:#d1d5db}
nav button.active{color:#a78bfa;border-bottom-color:#a78bfa}
.stat{font-size:11px;color:#6b7280;margin-left:6px;font-weight:normal}

/* ── LEGEND */
.legend{display:flex;flex-wrap:wrap;gap:14px;padding:9px 28px;background:#111118;border-bottom:1px solid #1e1e2e}
.li{display:flex;align-items:center;gap:6px;font-size:11px;color:#9ca3af}
.ls{width:12px;height:12px;border-radius:3px}

/* ── LAYOUT */
main{padding:28px 28px 60px;max-width:1400px;margin:0 auto}
.section{display:none}.section.active{display:block}
.sec-hdr{margin-bottom:24px}
.sec-hdr h2{font-size:20px;font-weight:700;color:#f3f4f6;margin-bottom:4px}
.sec-hdr p{font-size:13px;color:#6b7280;line-height:1.5}

/* ── OVERVIEW CARDS */
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:10px;margin-bottom:24px}
.card{background:#111118;border:1px solid #1e1e2e;border-radius:10px;padding:14px 16px}
.ctag{display:inline-block;font-size:9px;font-weight:800;letter-spacing:.1em;text-transform:uppercase;padding:2px 7px;border-radius:3px;margin-bottom:8px}
.t-ob{background:#1e3a5f;color:#60a5fa}.t-phase{background:#2d1b4e;color:#a78bfa}.t-ru{background:#3b1f1f;color:#f87171}
.card h4{font-size:13px;font-weight:600;color:#e5e7eb;margin-bottom:4px}.card p{font-size:12px;color:#9ca3af;line-height:1.4}

/* ── PERSONA BANNER */
.persona-banner{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:32px;padding:18px 20px;background:#0f0f1a;border:1px solid #1e1e2e;border-radius:12px}
.persona-banner-title{width:100%;font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:4px}
.persona-card{display:flex;flex-direction:column;align-items:center;gap:8px;flex:1;min-width:120px;padding:14px 10px;background:#111118;border:1px solid #252535;border-radius:10px;cursor:pointer;transition:border-color .15s,background .15s}
.persona-card:hover{border-color:#4b5563;background:#161622}
.persona-card.active{border-color:#a78bfa;background:#1a1535}
.persona-icon{font-size:26px;line-height:1}
.persona-label{font-size:12px;font-weight:600;color:#d1d5db;text-align:center;line-height:1.3}
.persona-bio{font-size:10px;color:#6b7280;text-align:center;line-height:1.4}

/* ── SUBSECTION */
.tab-content{display:flex;flex-direction:column;gap:20px}
.subsection{margin-bottom:8px}
.subsection.depth-1{background:#0f0f1a;border:1px solid #1e1e2e;border-radius:12px;padding:20px 24px;margin-bottom:4px}
.sub-title{font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;margin-bottom:18px;padding-bottom:10px;border-bottom:1px solid #1e1e2e}

/* ── TREE FLOW */
.tree-flow{display:flex;flex-direction:column;align-items:center;gap:0}

/* ── CONNECTOR between nodes */
.tree-connector{width:2px;height:28px;background:linear-gradient(to bottom,#2a2a3e,#3a3a52);margin:0 auto;flex-shrink:0}

/* ── NODE */
.tree-node{display:flex;flex-direction:column;align-items:center;width:100%}

.node-box{width:100%;max-width:520px;border-radius:12px;padding:14px 18px;position:relative;border:1.5px solid}
.node-step {background:#0e2018;border-color:#34d399}
.node-multi{background:#130e28;border-color:#a78bfa}
.node-anon {background:#0c1520;border-color:#3b82f6}

.node-hdr{display:flex;align-items:flex-start;gap:10px;margin-bottom:0}
.nquestion{font-size:13px;font-weight:600;color:#e5e7eb;line-height:1.45;flex:1}

/* ── NODE LABEL BADGE */
.nlabel{flex-shrink:0;font-size:9px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:3px 8px;border-radius:5px;margin-top:1px;white-space:nowrap}
.nlabel-step {background:#0d3320;color:#34d399;border:1px solid rgba(52,211,153,.3)}
.nlabel-multi{background:#1d1040;color:#a78bfa;border:1px solid rgba(167,139,250,.3)}
.nlabel-anon {background:#0d1e30;color:#60a5fa;border:1px solid rgba(96,165,250,.3)}

/* ── SAVE FIELDS */
.nsave{display:flex;flex-wrap:wrap;gap:4px;margin-top:9px}
.nsave-field{font-size:10px;font-family:monospace;background:#1a0e28;color:#e879f9;padding:2px 8px;border-radius:4px;border:1px solid rgba(232,121,249,.2)}

/* ── SKIP PILL */
.nskip{margin-top:8px;display:flex;flex-wrap:wrap;gap:4px}
.nskip-pill{font-size:10px;background:#200e0e;color:#f87171;padding:2px 8px;border-radius:4px;border:1px solid rgba(248,113,113,.2)}

/* ── BRANCH LOGIC (no chips, just text) */
.nbranches{margin-top:10px;border-top:1px solid rgba(255,255,255,.05);padding-top:8px;display:flex;flex-direction:column;gap:3px}
.nbranch-item{font-size:11px;color:#6b7280;padding-left:10px;border-left:2px solid #252535;line-height:1.5}

/* ── FORK ROW (answer chips that branch) */
.fork-row{display:flex;justify-content:center;gap:0;position:relative;width:100%;max-width:520px}

/* horizontal bar connecting branch tops */
.fork-row::before{content:'';position:absolute;top:0;left:16px;right:16px;height:2px;background:linear-gradient(to right,transparent,#2a2a3e 20%,#2a2a3e 80%,transparent)}

/* ── INDIVIDUAL BRANCH */
.fork-branch{display:flex;flex-direction:column;align-items:center;flex:1;min-width:80px;padding:0 4px}

/* vertical stem from bar down to chip */
.fork-line{width:2px;height:20px;background:#2a2a3e;flex-shrink:0}

.fork-chip{font-size:11px;font-weight:500;padding:5px 10px;border-radius:20px;text-align:center;line-height:1.3;white-space:normal;word-break:break-word;max-width:120px}
.fork-chip-qr {background:rgba(52,211,153,.08);border:1px solid rgba(52,211,153,.25);color:#6ee7b7}
.fork-chip-multi{background:rgba(167,139,250,.08);border:1px solid rgba(167,139,250,.25);color:#c4b5fd}

.fork-dest{font-size:10px;color:#4b5563;margin-top:5px;font-family:monospace;font-weight:600;letter-spacing:.03em}

/* ── EMPTY */
.empty-section{font-size:12px;color:#4b5563;padding:16px;text-align:center;border:1px dashed #1e1e2e;border-radius:8px}
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
  <div class="li"><div class="ls" style="background:#0e2018;border:1.5px solid #34d399"></div>Question with quick replies</div>
  <div class="li"><div class="ls" style="background:#130e28;border:1.5px solid #a78bfa"></div>Multi-select question</div>
  <div class="li"><div class="ls" style="background:#0c1520;border:1.5px solid #3b82f6"></div>Open-ended question</div>
  <div class="li"><div class="ls" style="background:#200e0e;border:1.5px solid #f87171"></div>Skip condition</div>
  <div class="li"><div class="ls" style="background:#1a0e28;border:1.5px solid #e879f9"></div>Saves to profile</div>
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
function selectPersona(el) {
  el.closest('.persona-banner').querySelectorAll('.persona-card').forEach(c => c.classList.remove('active'));
  el.classList.add('active');
}
</script>
</body>
</html>`;

  writeFileSync(OUT, html, 'utf-8');
  console.log(`[decision-tree] Generated ${OUT}`);
  console.log(`[decision-tree] ${tabs.length} tabs, ${totalQ} questions from ${markers.length} structural markers`);
}

generate();
