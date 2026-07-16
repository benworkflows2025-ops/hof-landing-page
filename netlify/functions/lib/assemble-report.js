/* Heart Stewardship Checkup v1.0 — Full Report assembler.
 * Builds the report from a stored scoring result + the approved content pack,
 * in the LOCKED 11-section order, using the SAME Final Stage the engine stored
 * (never recalculated). Applies IC-02 for tied priority areas. Loads copy
 * verbatim from the content pack; it never authors or paraphrases wording.
 */
'use strict';
const DKEYS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];

function pick(result, upper, lower) {
  return result[upper] !== undefined ? result[upper] : result[lower];
}
function splitDomains(v) { return String(v || '').split(',').map((s) => s.trim()).filter(Boolean); }

function assembleReport(result, content) {
  if (!content) throw new Error('content pack required');
  const stageKey = String(pick(result, 'HSC_V1_FINAL_STAGE', 'final_stage'));
  const priorityType = pick(result, 'HSC_V1_PRIORITY_TYPE', 'priority_type');
  const strengthType = pick(result, 'HSC_V1_STRENGTH_TYPE', 'strength_type');
  const priorityDomains = splitDomains(pick(result, 'HSC_V1_PRIORITY_DOMAINS', 'priority_domains'));
  const strengthDomains = splitDomains(pick(result, 'HSC_V1_STRENGTH_DOMAINS', 'strength_domains'));
  const recommendation = pick(result, 'HSC_V1_RECOMMENDATION', 'recommendation');

  // domain scores (from either the flat engine payload or the stored jsonb)
  const ds = result.domain_scores || {};
  const domainScore = (k) => (result['HSC_V1_' + k + '_SCORE'] !== undefined ? result['HSC_V1_' + k + '_SCORE'] : ds[k]);

  const S = (content.stages && content.stages[stageKey]) || {};
  const dom = content.domains || {};
  const tie = content.tie || {};
  const prod = content.products || {};

  // Three Recommended Next Steps
  //  Step 1: unique lowest -> that domain's next-step module; 2+ tied -> IC-02 universal tie step.
  const step1 = priorityDomains.length === 1
    ? (dom[priorityDomains[0]] && dom[priorityDomains[0]].priority_next_step) || ''
    : (tie.universal_next_faithful_step || '');
  const step2 = content.universal_next_step || '';
  const step3 = prod[recommendation] || '';

  const priorityTieLang = priorityType === 'TWO_TIE' ? (tie.priority_two || '') : (priorityType === 'MULTI_TIE' ? (tie.priority_multi || '') : '');
  const strengthTieLang = strengthType === 'TWO_TIE' ? (tie.strength_two || '') : (strengthType === 'MULTI_TIE' ? (tie.strength_multi || '') : '');

  const sections = [
    { n: 1, title: 'Your Heart Stewardship Stage', body: S.name || '' },
    { n: 2, title: 'What This Stage May Suggest', body: S.may_suggest || '' },
    { n: 3, title: 'Your Seven-Domain Profile',
      items: DKEYS.map((k) => ({ domain: (dom[k] && dom[k].name) || k, score: domainScore(k), text: (dom[k] && dom[k].profile) || '' })) },
    { n: 4, title: 'Your Relative Stewardship Strength(s)', tieLanguage: strengthTieLang,
      items: strengthDomains.map((k) => ({ domain: (dom[k] && dom[k].name) || k, text: (dom[k] && dom[k].strength_line) || '' })) },
    { n: 5, title: 'Your Priority Attention Area(s)', tieLanguage: priorityTieLang,
      items: priorityDomains.map((k) => ({ domain: (dom[k] && dom[k].name) || k, text: (dom[k] && dom[k].priority_next_step) || '' })) },
    { n: 6, title: 'What Your Results Do and Do Not Mean', body: content.meaning || '' },
    { n: 7, title: 'Three Recommended Next Steps', steps: [step1, step2, step3] },
    { n: 8, title: 'Scripture-Grounded Reflection', body: content.scripture || '' },
    { n: 9, title: 'Your Recommended HOF Starting Point', body: prod[recommendation] || '' },
    { n: 10, title: 'What May Come Next', body: content.what_comes_next || '' },
    { n: 11, title: 'Educational, Spiritual and Safety Disclaimer', body: content.disclaimer || '' },
  ];

  // Integrity: which controlled slots are still empty (must be zero before this ships to a respondent).
  const missing = [];
  sections.forEach((s) => {
    if ('body' in s && !s.body) missing.push('S' + s.n);
    if (s.items) s.items.forEach((it, i) => { if (!it.text) missing.push('S' + s.n + '.item' + (i + 1)); });
    if (s.steps) s.steps.forEach((t, i) => { if (!t) missing.push('S7.step' + (i + 1)); });
  });

  return {
    stage: Number(stageKey),
    stage_name: S.name || '',
    recommendation,
    priority_type: priorityType,
    strength_type: strengthType,
    content_version: content.content_version || null,
    sections,
    ready: missing.length === 0,   // true only when every controlled slot is filled
    missing,
  };
}

function snapshotFrom(result, content) {
  const stageKey = String(pick(result, 'HSC_V1_FINAL_STAGE', 'final_stage'));
  const S = (content.stages && content.stages[stageKey]) || {};
  const priorityType = pick(result, 'HSC_V1_PRIORITY_TYPE', 'priority_type');
  const priorityDomains = splitDomains(pick(result, 'HSC_V1_PRIORITY_DOMAINS', 'priority_domains'));
  const tie = content.tie || {};
  const dom = content.domains || {};
  return {
    stage: Number(stageKey),
    stage_name: S.name || '',
    stage_snapshot: S.snapshot || '',           // approved 40-70 word abbreviated interpretation
    priority_type: priorityType,
    priority_areas: priorityDomains.map((k) => (dom[k] && dom[k].name) || k),
    priority_tie_language: priorityType === 'TWO_TIE' ? (tie.priority_two || '') : (priorityType === 'MULTI_TIE' ? (tie.priority_multi || '') : ''),
    email_invitation: content.email_invitation || '',
    // NOTE: no product recommendation in the snapshot (spec S11).
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { assembleReport, snapshotFrom };
