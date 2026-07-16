/* ============================================================================
 * HOF Heart Stewardship Checkup v1.0 — Deterministic Scoring Engine
 * ----------------------------------------------------------------------------
 * Pure integer JavaScript. No AI, no floating point, no imputation.
 * Executes the controlled locked order of operations EXACTLY as specified:
 *   validate -> 7 domain sums -> overall raw -> provisional stage ->
 *   Stage 4 control -> Stage 3 control -> final stage ->
 *   min-domain priority tie enumeration -> max-domain strength tie enumeration ->
 *   product-history booleans -> 12-rule deterministic routing (with IC-01).
 *
 * Fails closed: any missing/invalid scored item, or a product-history conflict,
 * returns COMPLETION_STATUS='ERROR' with NO scoring, stage, tie, or routing.
 *
 * Drop-in for an n8n Code node (see wrapper at bottom). Copy verbatim.
 * Respondent-facing copy (stage names, module text) is NOT authored here; those
 * are controlled modules resolved by content_version elsewhere. STAGE_NAME here
 * is a stable module KEY, not respondent copy.
 * ========================================================================== */

'use strict';

// Domain -> its three 1-indexed question numbers (locked mapping).
const DOMAINS = {
  D1: [1, 2, 3],    // Heart Awareness
  D2: [4, 5, 6],    // Influence & Access
  D3: [7, 8, 9],    // Thoughts, Beliefs & Internal Agreement
  D4: [10, 11, 12], // Addressing What Needs Attention
  D5: [13, 14, 15], // Relationships, Trust & Boundaries
  D6: [16, 17, 18], // Ownership & Faithful Response
  D7: [19, 20, 21], // Ongoing Heart Stewardship
};
const DKEYS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7'];

const STAGE_NAME_KEY = { 1: 'HSC_V1_STAGE_1_NAME', 2: 'HSC_V1_STAGE_2_NAME', 3: 'HSC_V1_STAGE_3_NAME', 4: 'HSC_V1_STAGE_4_NAME' };

const VERSIONS = {
  HSC_V1_ASSESSMENT_VERSION: '1.0',
  HSC_V1_SPEC_VERSION: '1.0',
  HSC_V1_LOGIC_VERSION: 'HSC-LOGIC-1.0.0',
  HSC_V1_CONTENT_VERSION: 'PENDING_SOURCE', // set to the approved content pack id once the Results/Routing/Funnel source is delivered
};

function fail(reason) {
  return { HSC_V1_COMPLETION_STATUS: 'ERROR', HSC_V1_ERROR_REASON: reason, ...VERSIONS };
}

/* Read Q01..Q21 from either an array [q1..q21] or an object {Q01:..,..,'1':..}. */
function readAnswer(input, n) {
  const keys = ['Q' + String(n).padStart(2, '0'), 'Q' + n, 'q' + n, String(n), n];
  if (Array.isArray(input)) return input[n - 1];
  for (const k of keys) if (input[k] !== undefined && input[k] !== null && input[k] !== '') return input[k];
  return undefined;
}

/* Provisional stage from raw score (locked thresholds). */
function provisionalStage(raw) {
  if (raw >= 21 && raw <= 45) return 1;
  if (raw >= 46 && raw <= 66) return 2;
  if (raw >= 67 && raw <= 87) return 3;
  if (raw >= 88 && raw <= 105) return 4;
  return null;
}

/* Enumerate ALL domains equal to the extreme value. Never arbitrary selection. */
function enumerateTie(domainScores, mode /* 'min'|'max' */) {
  const vals = DKEYS.map((k) => domainScores[k]);
  const target = mode === 'min' ? Math.min(...vals) : Math.max(...vals);
  const domains = DKEYS.filter((k) => domainScores[k] === target);
  const type = domains.length === 1 ? 'ONE' : (domains.length === 2 ? 'TWO_TIE' : 'MULTI_TIE');
  return { value: target, domains, type };
}

/* Deterministic 12-rule routing + IC-01. Returns exactly one outcome. */
function route(finalStage, coreUsed, workbookUsed, journeyUsed, journeyAvailable) {
  if (finalStage === 1 || finalStage === 2) {
    const p = 'S' + finalStage;
    if (!coreUsed) return { rec: 'CORE', rule: `R-${p}-01` };
    if (coreUsed && !workbookUsed) return { rec: 'WORKBOOK', rule: `R-${p}-02` };
    return { rec: 'FREE_NURTURE', rule: `R-${p}-03` };
  }
  // Stage 3 or 4
  const p = 'S' + finalStage;
  if (!workbookUsed) return { rec: 'WORKBOOK', rule: `R-${p}-01` };
  if (workbookUsed && !journeyUsed && journeyAvailable) return { rec: 'JOURNEY', rule: `R-${p}-02` }; // IC-01
  return { rec: 'FREE_NURTURE', rule: `R-${p}-03` };
}

/* Resolve product-history tokens to used-booleans, enforcing mutual exclusivity. */
const ALLOWED_HISTORY = new Set(['NONE_USED', 'CORE', 'WORKBOOK', 'JOURNEY', 'NOT_SURE']);
function resolveHistory(history) {
  const set = new Set((history || []).map((h) => String(h).toUpperCase().trim()));
  // Closed option set: any unrecognized token is invalid data, fail closed.
  for (const t of set) if (!ALLOWED_HISTORY.has(t)) return { error: 'PRODUCT_HISTORY_INVALID_TOKEN' };
  const hasNone = set.has('NONE_USED');
  const hasNotSure = set.has('NOT_SURE');
  const specifics = ['CORE', 'WORKBOOK', 'JOURNEY'].filter((p) => set.has(p));
  // Spec: NONE_USED and NOT_SURE are EACH mutually exclusive with any specific product.
  if ((hasNone || hasNotSure) && specifics.length > 0) return { error: 'PRODUCT_HISTORY_CONFLICT' };
  // Approved default (pending HOF written confirmation): "not sure" is treated as "not used".
  return {
    coreUsed: set.has('CORE'),
    workbookUsed: set.has('WORKBOOK'),
    journeyUsed: set.has('JOURNEY'),
    notSure: hasNotSure,
  };
}

/**
 * Score one completed assessment.
 * @param {Object} input
 *   input.answers          array[21] or object of Q01..Q21 integers 1..5
 *   input.productHistory   array of tokens: NONE_USED | CORE | WORKBOOK | JOURNEY | NOT_SURE
 *   input.journeyAvailable boolean (HOF-controlled flag)
 * @returns {Object} the authoritative HSC_V1_ scoring payload, or an ERROR object.
 */
function scoreAssessment(input) {
  input = input || {};

  // ---- 1. VALIDATE (fail closed) --------------------------------------------
  const answers = {};
  for (let n = 1; n <= 21; n++) {
    const qid = 'Q' + String(n).padStart(2, '0');
    const raw = readAnswer(input.answers !== undefined ? input.answers : input, n);
    if (raw === undefined || raw === null || raw === '') return fail('MISSING_ITEM_' + qid);
    // Strict: accept only a real number, or a string that is exactly one digit 1-5.
    // Arrays, objects, booleans, and exotic numeric strings ("0x3", "1e0", [3]) fail closed.
    let v;
    if (typeof raw === 'number') v = raw;
    else if (typeof raw === 'string' && /^[1-5]$/.test(raw.trim())) v = Number(raw.trim());
    else return fail('INVALID_ITEM_' + qid);
    if (!Number.isInteger(v) || v < 1 || v > 5) return fail('INVALID_ITEM_' + qid);
    answers[qid] = v;
  }

  // Product history validated before use (unscored, routing only).
  const hist = resolveHistory(input.productHistory);
  if (hist.error) return fail(hist.error);
  const journeyAvailable = input.journeyAvailable === true;

  // ---- 2. DOMAIN SUMS + OVERALL RAW -----------------------------------------
  const D = {};
  for (const k of DKEYS) D[k] = DOMAINS[k].reduce((s, q) => s + answers['Q' + String(q).padStart(2, '0')], 0);
  const raw = DKEYS.reduce((s, k) => s + D[k], 0);

  // ---- 3. PROVISIONAL STAGE --------------------------------------------------
  const provisional = provisionalStage(raw);
  if (provisional === null) return fail('RAW_OUT_OF_RANGE_' + raw);

  // ---- 4. MODERATED STAGE CONTROLS (both key off PROVISIONAL, never running) --
  let finalStage, downgradeReason;
  if (provisional === 4) {
    const anyLow = DKEYS.some((k) => D[k] <= 8);            // Stage 4 floor
    finalStage = anyLow ? 3 : 4;
    downgradeReason = anyLow ? 'S4_FLOOR' : 'NONE';
  } else if (provisional === 3) {
    const strong = DKEYS.filter((k) => D[k] >= 9).length;   // Stage 3 count
    finalStage = strong < 5 ? 2 : 3;
    downgradeReason = strong < 5 ? 'S3_COUNT' : 'NONE';
  } else {
    finalStage = provisional;                               // S1/S2 no floor
    downgradeReason = 'NONE';
  }
  const downgradeFlag = downgradeReason !== 'NONE';

  // ---- 5. PRIORITY (min) + STRENGTH (max) tie enumeration --------------------
  const priority = enumerateTie(D, 'min');
  const strength = enumerateTie(D, 'max');

  // ---- 6. DETERMINISTIC ROUTING (uses FINAL stage) --------------------------
  const r = route(finalStage, hist.coreUsed, hist.workbookUsed, hist.journeyUsed, journeyAvailable);

  // ---- 7. AUTHORITATIVE PAYLOAD ---------------------------------------------
  const payload = {
    HSC_V1_COMPLETION_STATUS: 'COMPLETE',
    // raw answers
    ...answers,
    // domain scores
    HSC_V1_D1_SCORE: D.D1, HSC_V1_D2_SCORE: D.D2, HSC_V1_D3_SCORE: D.D3, HSC_V1_D4_SCORE: D.D4,
    HSC_V1_D5_SCORE: D.D5, HSC_V1_D6_SCORE: D.D6, HSC_V1_D7_SCORE: D.D7,
    HSC_V1_OVERALL_RAW: raw,
    // stages
    HSC_V1_PROVISIONAL_STAGE: provisional,
    HSC_V1_FINAL_STAGE: finalStage,
    HSC_V1_STAGE_NAME: STAGE_NAME_KEY[finalStage],
    HSC_V1_DOWNGRADE_FLAG: downgradeFlag,
    HSC_V1_DOWNGRADE_REASON: downgradeReason,
    // priority / strength (all tied domains preserved)
    HSC_V1_LOWEST_SCORE: priority.value,
    HSC_V1_PRIORITY_TYPE: priority.type,
    HSC_V1_PRIORITY_DOMAINS: priority.domains.join(','),
    HSC_V1_HIGHEST_SCORE: strength.value,
    HSC_V1_STRENGTH_TYPE: strength.type,
    HSC_V1_STRENGTH_DOMAINS: strength.domains.join(','),
    // product history + routing
    HSC_V1_PRODUCT_HISTORY: (input.productHistory || []).join(','),
    HSC_V1_JOURNEY_AVAILABLE: journeyAvailable,
    HSC_V1_RECOMMENDATION: r.rec,
    HSC_V1_ROUTING_RULE_ID: r.rule,
    // per-domain booleans so GHL can apply the correct number of "all tied" D-tags with fixed checks
    ...DKEYS.reduce((o, k) => { o['HSC_V1_PRIORITY_' + k] = priority.domains.includes(k); o['HSC_V1_STRENGTH_' + k] = strength.domains.includes(k); return o; }, {}),
    // versions
    ...VERSIONS,
  };
  return payload;
}

/* ---- n8n Code-node wrapper (uncomment in n8n) -------------------------------
const input = $json; // { answers, productHistory, journeyAvailable }
return [{ json: scoreAssessment(input) }];
----------------------------------------------------------------------------- */

if (typeof module !== 'undefined' && module.exports) module.exports = { scoreAssessment, provisionalStage, enumerateTie, route, resolveHistory };
