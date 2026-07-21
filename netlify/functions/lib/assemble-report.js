/* Heart Stewardship Checkup v1.0 — Full Report assembler.
 * Builds the report from a stored scoring result + the approved content pack,
 * in the LOCKED 11-section order, using the SAME Final Stage the engine stored
 * (never recalculated). Applies IC-02 for tied priority areas. Loads copy
 * verbatim from the content pack; it never authors or paraphrases wording.
 */
'use strict';
const DKEYS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];
// Fixed structural domain labels (defined in the spec, not respondent "copy"),
// used as a fallback for the domain NAME when a content pack is not yet loaded.
const DEFAULT_DOMAIN_NAMES = {
  D1: 'Heart Awareness', D2: 'Influence and Access', D3: 'Thoughts, Beliefs and Internal Agreement',
  D4: 'Addressing What Needs Attention', D5: 'Relationships, Trust and Boundaries',
  D6: 'Ownership and Faithful Response', D7: 'Ongoing Heart Stewardship',
};
const domName = (dom, k) => (dom[k] && dom[k].name) || DEFAULT_DOMAIN_NAMES[k] || k;

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

  // When exactly one area is lowest we use that area's own approved scripture and
  // resource wording. On a tie we fall back to the universal versions (IC-02).
  const singlePriority = priorityDomains.length === 1 ? priorityDomains[0] : null;
  const pdom = (singlePriority && dom[singlePriority]) || {};
  const scriptureText = pdom.scripture || content.scripture || '';
  // her per-area resource line for the routed product, else the global product blurb
  const resourceText = (pdom.resources && pdom.resources[recommendation]) || prod[recommendation] || '';

  // Three Recommended Next Steps
  //  Step 1: unique lowest -> that domain's next-step module; 2+ tied -> IC-02 universal tie step.
  const step1 = singlePriority
    ? (dom[singlePriority] && dom[singlePriority].priority_next_step) || ''
    : (tie.universal_next_faithful_step || '');
  const step2 = content.universal_next_step || '';
  const step3 = resourceText;

  const priorityTieLang = priorityType === 'TWO_TIE' ? (tie.priority_two || '') : (priorityType === 'MULTI_TIE' ? (tie.priority_multi || '') : '');
  const strengthTieLang = strengthType === 'TWO_TIE' ? (tie.strength_two || '') : (strengthType === 'MULTI_TIE' ? (tie.strength_multi || '') : '');

  // "At a glance" overview shown at the very top of the report. Overview ONLY —
  // it uses her approved stage snapshot verbatim and points the reader down to the
  // full sections for the detail (per Lanita: "summary just overview, tell them to
  // read for details"). No interpretive copy is authored here.
  const summary = {
    stage_name: S.name || '',
    overview: S.snapshot || '',
    priority_areas: priorityDomains.map((k) => domName(dom, k)),
    read_more: 'This is just the overview. Read your full report below for what it means and your recommended next steps.',
  };

  const sections = [
    { n: 1, title: 'Your Heart Stewardship Stage', body: S.name || '' },
    { n: 2, title: 'What This Stage May Suggest', body: S.may_suggest || '' },
    { n: 3, title: 'Your Seven-Domain Profile',
      items: DKEYS.map((k) => ({ domain: domName(dom, k), score: domainScore(k), text: (dom[k] && dom[k].profile) || '' })) },
    { n: 4, title: 'Your Relative Stewardship Strength(s)', tieLanguage: strengthTieLang,
      items: strengthDomains.map((k) => ({ domain: domName(dom, k), text: (dom[k] && dom[k].strength_line) || '' })) },
    { n: 5, title: 'Your Priority Attention Area(s)', tieLanguage: priorityTieLang,
      items: priorityDomains.map((k) => ({ domain: domName(dom, k),
        text: [(dom[k] || {}).profile, (dom[k] || {}).why_it_matters].filter(Boolean).join('\n\n') })) },
    { n: 6, title: 'What Your Results Do and Do Not Mean', body: content.meaning || '' },
    { n: 7, title: 'Three Recommended Next Steps', steps: [step1, step2, step3] },
    { n: 8, title: 'Scripture-Grounded Reflection', body: scriptureText },
    { n: 9, title: 'Your Recommended HOF Starting Point', body: resourceText },
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
    summary,
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
    priority_areas: priorityDomains.map((k) => domName(dom, k)),
    priority_tie_language: priorityType === 'TWO_TIE' ? (tie.priority_two || '') : (priorityType === 'MULTI_TIE' ? (tie.priority_multi || '') : ''),
    email_invitation: content.email_invitation || '',
    // NOTE: no product recommendation in the snapshot (spec S11).
  };
}

if (typeof module !== 'undefined' && module.exports) module.exports = { assembleReport, snapshotFrom };
