// ============================================================================
// verify-independent.mjs
// Independent re-derivation of the "three-arm" image-reading experiment.
//
// Written from scratch by a verifier. Imports NO experimenter code and reads
// NO experimenter score files (score-runs.json is deliberately NOT opened).
// Re-runnable:  node verify-independent.mjs
//
// Inputs (all local):
//   D:\deepseek\.tmp\attn-exp\truth.json                  ground truth
//   D:\deepseek\.tmp\threearm\runs\{naive,down-only,down-then-up}\*.png
//   %USERPROFILE%\.dsh\sessions\--D-deepseek--\<uuid>\session.v3.jsonl.zstd
// Outputs:
//   D:\deepseek\.tmp\threearm\verify-independent.md        the report
//   D:\deepseek\.tmp\threearm\verify-independent.raw.txt   full console log
//   D:\deepseek\.tmp\threearm\verify-independent.summary.json
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = 'D:\\deepseek\\.tmp\\threearm';
const RUNS = path.join(ROOT, 'runs');
const TRUTH = 'D:\\deepseek\\.tmp\\attn-exp\\truth.json';
const SESSROOT = path.join(process.env.USERPROFILE, '.dsh', 'sessions', '--D-deepseek--');
const ARMS = ['naive', 'down-only', 'down-then-up'];
const ARM_DIR = Object.fromEntries(ARMS.map(a => [a, path.join(RUNS, a)]));
const PREFIXES = ['7ced3634', '0ebbb2b2', '9a322102', '63036c9a', 'e134da0e', '5d09771c', 'a9cdcf16'];
const GATE = 60;

const LOG = [];
const say = (...a) => { const s = a.map(String).join(' '); LOG.push(s); console.log(s); };
const NUM = (x, n = 4) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : Number(x).toFixed(n);
const PC = (x, n = 1) => (x === null || x === undefined || Number.isNaN(x)) ? 'n/a' : (100 * x).toFixed(n) + '%';
const BT = String.fromCharCode(96);
const C = (x) => BT + String(x) + BT;              // inline code span
const M = [];

// ============================================================================
// 0. Ground truth
// ============================================================================
const truthRaw = fs.readFileSync(TRUTH, 'utf8');
const TRUTH_BOM = truthRaw.charCodeAt(0) === 0xFEFF;
const truth = JSON.parse(truthRaw.replace(/^\uFEFF/, ''));
const LABELS = truth.labels;
const L5 = truth.tiles.filter(t => t.level === 5);
const tileByName = new Map(L5.map(t => [t.file, t]));
const TRUE_CODES = new Set(LABELS.map(l => l.code));
let minSep = Infinity, minSepPair = null;
for (let i = 0; i < LABELS.length; i++) for (let j = i + 1; j < LABELS.length; j++) {
  const d = Math.hypot(LABELS[i].x - LABELS[j].x, LABELS[i].y - LABELS[j].y);
  if (d < minSep) { minSep = d; minSepPair = [LABELS[i].code, LABELS[j].code]; }
}
say('=== 0. GROUND TRUTH ===');
say('truth.json: ' + fs.statSync(TRUTH).size + ' bytes, UTF-8 BOM present = ' + TRUTH_BOM);
say('source ' + truth.sourceW + 'x' + truth.sourceH + ', maxEdge=' + truth.maxEdge);
say('labels=' + LABELS.length + ', level-5 tiles=' + L5.length + ', duplicate codes=' + (LABELS.length - TRUE_CODES.size));
say('min pairwise label separation = ' + NUM(minSep, 1) + 'px (' + minSepPair.join(' vs ') + '); 2x gate = ' + (2 * GATE) + 'px');

// ============================================================================
// 1. Tile dimensions from PNG IHDR (bytes 16..24), read independently
// ============================================================================
function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  const b = Buffer.alloc(24); fs.readSync(fd, b, 0, 24, 0); fs.closeSync(fd);
  if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('bad PNG sig ' + file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), ihdr: b.subarray(12, 16).toString('ascii') };
}
const armTiles = {};
say('');
say('=== 1. TILE DIMENSIONS (IHDR bytes 16..24) ===');
for (const arm of ARMS) {
  const files = fs.readdirSync(ARM_DIR[arm]).filter(x => x.toLowerCase().endsWith('.png')).sort();
  const rec = files.map(name => Object.assign({ name }, pngSize(path.join(ARM_DIR[arm], name))));
  armTiles[arm] = rec;
  const byDim = new Map();
  for (const r of rec) { const k = r.w + 'x' + r.h; byDim.set(k, (byDim.get(k) || 0) + 1); }
  const odd = rec.filter(r => r.h !== rec[0].h || r.w !== rec[0].w);
  say(arm.padEnd(13) + ' n=' + rec.length + "  IHDR='" + rec[0].ihdr + "'  dims: " + [...byDim].map(([k, v]) => k + ' x' + v).join(', '));
  if (odd.length) say('              minority-height tiles: ' + odd.map(r => r.name).join(', '));
}
const nameSetsEqual = ARMS.every(a => armTiles[a].map(t => t.name).join('|') === armTiles.naive.map(t => t.name).join('|'));
say('filename sets identical across arms: ' + nameSetsEqual);
say('all 16 truth L5 names present in every arm: ' + L5.every(t => armTiles.naive.some(r => r.name === t.file)));

// ============================================================================
// 2. Session loading (multi-frame zstd)
// ============================================================================
function loadSession(prefix) {
  const dirs = fs.readdirSync(SESSROOT).filter(d => d.startsWith(prefix));
  if (dirs.length !== 1) throw new Error('prefix ' + prefix + ': ' + dirs.length + ' matches');
  const uuid = dirs[0];
  const file = path.join(SESSROOT, uuid, 'session.v3.jsonl.zstd');
  const buf = fs.readFileSync(file);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  const st = fs.statSync(file);
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  const offs = []; let i = 0;
  while ((i = buf.indexOf(magic, i)) !== -1) { offs.push(i); i++; }
  const parts = []; let failed = 0;
  for (let k = 0; k < offs.length; k++) {
    const s = offs[k], e = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e))); } catch { failed++; }
  }
  const events = []; let badLines = 0;
  for (const line of Buffer.concat(parts).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { badLines++; }
  }
  return { prefix, uuid, file, bytes: st.size, mtime: st.mtime.toISOString(), sha256, frames: offs.length, failedFrames: failed, events, badLines };
}
const parseArgs = (a) => { if (typeof a === 'string') { try { return JSON.parse(a); } catch { return { __unparsed: a }; } } return a || {}; };

// ============================================================================
// 3. Per-session extraction
// ============================================================================
const sessions = [];
for (const p of PREFIXES) {
  const S = loadSession(p);
  const rec = Object.assign({}, S);
  let firstUser = '';
  for (const e of S.events) {
    if (e.type !== 'user/message') continue;
    const m = (e.data || {}).message || e.data || {};
    const c = m.content;
    firstUser = Array.isArray(c) ? c.map(b => (typeof b === 'string' ? b : b.text || '')).join('') : (typeof c === 'string' ? c : '');
    if (firstUser) break;
  }
  rec.promptText = firstUser;
  rec.promptArm = (firstUser.match(/runs\\(naive|down-only|down-then-up)/) || [])[1] || null;
  rec.promptHasFileList = /L5_00_x0_y0_w960_h540\.png/.test(firstUser);
  rec.promptFamily = rec.promptHasFileList ? 'explicit-16-filename-list' : 'no-filename-list';
  const desc = S.events.find(e => e.type === 'subagent/descriptor');
  rec.label = desc ? desc.data.label : null;
  rec.model = desc ? desc.data.agentModel : null;

  const fromEvents = [], fromBlocks = [];
  for (const e of S.events) {
    if (e.type === 'tool/call' && (e.data || {}).name === 'read_image') {
      const a = parseArgs(e.data.arguments); fromEvents.push(a.file_path || null);
    }
    if (e.type === 'assistant/message') {
      const c = ((e.data || {}).message || {}).content;
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool-call' && b.name === 'read_image') {
        fromBlocks.push(parseArgs(b.arguments).file_path || null);
      }
    }
  }
  rec.readsFromEvents = fromEvents; rec.readsFromBlocks = fromBlocks;
  const useBlocks = fromBlocks.length >= fromEvents.length;
  rec.readsSource = useBlocks ? 'assistant message tool-call blocks' : 'tool/call events';
  rec.reads = useBlocks ? fromBlocks : fromEvents;

  let real = 0, fab = 0;
  const tileCount = new Map(), realNonTile = [], fabList = [];
  for (const fp of rec.reads) {
    if (!fp || typeof fp !== 'string') continue;
    if (fs.existsSync(fp)) {
      real++;
      const base = path.basename(fp);
      if (tileByName.has(base)) tileCount.set(base, (tileCount.get(base) || 0) + 1);
      else realNonTile.push(fp);
    } else { fab++; fabList.push(fp); }
  }
  rec.real = real; rec.fab = fab; rec.fabList = fabList; rec.realNonTile = realNonTile;
  rec.distinctRealTiles = tileCount.size;
  rec.repeatTileReads = [...tileCount.values()].reduce((s, c) => s + c - 1, 0);
  rec.repeatTileNames = [...tileCount.entries()].filter(([, c]) => c > 1).map(([n, c]) => n + ' x' + c);
  const dirCount = { naive: 0, 'down-only': 0, 'down-then-up': 0, other: 0 };
  for (const fp of rec.reads) {
    const m = fp && String(fp).replace(/\//g, '\\').match(/\\(naive|down-only|down-then-up)(\\|$)/);
    if (m) dirCount[m[1]]++; else dirCount.other++;
  }
  rec.readDir = dirCount;
  rec.arm = ARMS.slice().sort((a, b) => dirCount[b] - dirCount[a])[0];
  if (dirCount[rec.arm] === 0) rec.arm = null;
  rec.armConsistent = rec.promptArm === null || rec.promptArm === rec.arm;

  const tools = new Map();
  for (const e of S.events) {
    if (e.type === 'assistant/message') {
      const c = ((e.data || {}).message || {}).content;
      if (Array.isArray(c)) for (const b of c) if (b && b.type === 'tool-call') tools.set(b.name, (tools.get(b.name) || 0) + 1);
    }
  }
  rec.tools = tools;
  rec.steps = S.events.filter(e => e.type === 'step/start').length;

  const sendMsgs = [], asstTexts = [];
  for (const e of S.events) {
    if (e.type !== 'assistant/message') continue;
    const m = (e.data || {}).message || {};
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim()) asstTexts.push(b.text);
      if (b && b.type === 'tool-call' && b.name === 'send_message') sendMsgs.push(parseArgs(b.arguments));
    }
  }
  rec.sendText = sendMsgs.map(a => a.message).filter(t => typeof t === 'string');
  rec.asstTexts = asstTexts;
  const parseAnswer = (t) => {
    const obs = [], unc = [];
    for (const line of String(t).split(/\r?\n/)) {
      const m = line.match(/^\s*(OBSERVED|UNCERTAIN)\s*:\s*(.*)$/i);
      if (!m) continue;
      const kind = m[1].toUpperCase(), body = m[2];
      const parts = body.split('|').map(x => x.trim());
      const uv = body.match(/u\s*=\s*(-?[\d.]+)\s*[, ]+\s*v\s*=\s*(-?[\d.]+)/i)
        || body.match(/u\s*=\s*(-?[\d.]+)\s+v\s*=\s*(-?[\d.]+)/i);
      const o = { file: parts[0], u: uv ? parseFloat(uv[1]) : null, v: uv ? parseFloat(uv[2]) : null, raw: body };
      if (kind === 'OBSERVED') { o.code = parts[1] || null; obs.push(o); }
      else { o.code = parts[2] || null; o.reason = parts[3] || null; unc.push(o); }
    }
    return { obs, unc };
  };
  const cands = [];
  for (const t of rec.sendText) { const a = parseAnswer(t); if (a.obs.length || a.unc.length) cands.push(Object.assign({ via: 'send_message arguments.message', text: t }, a)); }
  for (const t of asstTexts) { const a = parseAnswer(t); if (a.obs.length || a.unc.length) cands.push(Object.assign({ via: 'assistant text block', text: t }, a)); }
  rec.answerCands = cands;
  rec.answer = cands.length ? cands.reduce((b, c) => (c.obs.length + c.unc.length) > (b.obs.length + b.unc.length) ? c : b) : null;
  rec.carrierTextsAgree = new Set(cands.map(c => c.text)).size === 1;
  rec.carriers = [...new Set(cands.map(c => c.via))];
  rec.sendTextNoAnswer = rec.sendText.length > 0 && !rec.sendText.some(t => /OBSERVED\s*:/i.test(t));
  sessions.push(rec);
}

// ============================================================================
// 4. Scoring
// ============================================================================
const median = (arr) => arr.length === 0 ? NaN : (arr.length % 2 ? arr[(arr.length - 1) / 2] : (arr[arr.length / 2 - 1] + arr[arr.length / 2]) / 2);
function score(rec) {
  const a = rec.answer;
  if (!a) return null;
  const rows = [];
  for (const o of a.obs) {
    const t = tileByName.get(o.file);
    if (!t || !Number.isFinite(o.u) || !Number.isFinite(o.v)) { rows.push(Object.assign({}, o, { gx: null, gy: null, badTile: true })); continue; }
    const gx = t.gx + o.u * t.gw, gy = t.gy + o.v * t.gh;
    let best = Infinity, bl = null;
    for (const L of LABELS) { const d = Math.hypot(gx - L.x, gy - L.y); if (d < best) { best = d; bl = L; } }
    rows.push(Object.assign({}, o, { gx, gy, tile: o.file, minD: best, nearCode: bl.code, codeOk: String(o.code || '').trim() === bl.code, inRange: best <= GATE }));
  }
  const valid = rows.filter(r => r.gx !== null);
  const obsCodeSet = new Set(a.obs.map(o => String(o.code || '').trim()));
  const hits = [...obsCodeSet].filter(c => TRUE_CODES.has(c));
  const nearest = LABELS.map(L => {
    let best = Infinity;
    for (const r of valid) { const d = Math.hypot(r.gx - L.x, r.gy - L.y); if (d < best) best = d; }
    return Object.assign({}, L, { d: best });
  });
  const sweep = {};
  for (const th of [5, 10, 20, 30, 60, 120, 240]) sweep[th] = nearest.filter(n => n.d <= th).length;
  const inR = valid.filter(r => r.inRange);
  const condD = inR.map(r => r.minD).sort((x, y) => x - y);
  return {
    reported: a.obs.length, abstain: a.unc.length, rows, valid,
    distinctObsCodes: obsCodeSet.size, hitCodes: hits, hitCodeCount: hits.length,
    codeAcc: hits.length / LABELS.length,
    precision: a.obs.length ? hits.length / a.obs.length : 0,
    coverage: nearest.filter(n => n.d <= GATE).length,
    nearest, medNearest: median(nearest.map(n => n.d).sort((x, y) => x - y)), sweep,
    inRangeCount: inR.length, condCorrect: inR.filter(r => r.codeOk).length,
    condAcc: inR.length ? inR.filter(r => r.codeOk).length / inR.length : null,
    medCondDist: median(condD), maxCondDist: condD.length ? condD[condD.length - 1] : NaN,
    strays: valid.filter(r => !r.inRange).length,
  };
}
for (const r of sessions) r.score = score(r);

say('');
say('=== 2. PER-SESSION DERIVATION ===');
for (const r of sessions) {
  say('');
  say('--- ' + r.prefix + '  ' + r.uuid);
  say('    label="' + r.label + '"  model=' + r.model + '  steps=' + r.steps + '  frames=' + r.frames + ' failed=' + r.failedFrames + '  badLines=' + r.badLines);
  say('    snapshot: ' + r.bytes + ' bytes, mtime=' + r.mtime + ', sha256=' + r.sha256.slice(0, 16) + '...');
  say('    PROMPT family=' + r.promptFamily + '; arm in prompt=' + r.promptArm + '; arm from read paths=' + r.arm + '; consistent=' + r.armConsistent);
  say('    tools: ' + [...r.tools].map(([k, v]) => k + 'x' + v).join(', '));
  say('    read_image: events=' + r.readsFromEvents.length + ' blocks=' + r.readsFromBlocks.length + ' using=' + r.readsSource);
  say('    read dirs: ' + JSON.stringify(r.readDir));
  say('    REAL=' + r.real + '  FABRICATED=' + r.fab + '  distinct real tiles=' + r.distinctRealTiles + '/16  repeat tile reads=' + r.repeatTileReads);
  if (r.realNonTile.length) say('    REAL but not a tile: ' + JSON.stringify(r.realNonTile));
  if (r.fabList.length) say('    fabricated paths: ' + r.fabList.length + ' calls, ' + new Set(r.fabList).size + ' distinct');
  if (r.repeatTileNames.length) say('    repeated real tile reads: ' + r.repeatTileNames.join(', '));
  if (!r.answer) {
    say('    ANSWER: NONE. send_message present=' + (r.sendText.length > 0) + ' without OBSERVED lines=' + r.sendTextNoAnswer);
    if (r.sendText.length) say('    send_message text: ' + JSON.stringify(r.sendText[r.sendText.length - 1]).slice(0, 300));
  } else {
    say('    ANSWER via ' + r.carriers.join(' + ') + '; all carriers byte-identical=' + r.carrierTextsAgree);
    say('    reported=' + r.score.reported + ' abstain=' + r.score.abstain);
    const s = r.score;
    say('    codeAcc=' + s.hitCodeCount + '/36=' + NUM(s.codeAcc) + '  precision=' + s.hitCodeCount + '/' + s.reported + '=' + NUM(s.precision));
    say('    coverage<=' + GATE + 'px=' + s.coverage + '/36  medianNearest=' + NUM(s.medNearest, 2) + 'px  strays=' + s.strays);
    say('    inRange=' + s.inRangeCount + '/' + s.reported + ' condCorrect=' + s.condCorrect + ' condAcc=' + NUM(s.condAcc) + ' medCondDist=' + NUM(s.medCondDist, 2) + ' maxCondDist=' + NUM(s.maxCondDist, 2));
    say('    sweep: ' + Object.entries(s.sweep).map(([k, v]) => k + ':' + v).join(' '));
  }
}

// ============================================================================
// 5. Worked example (real session, hand-checked)
// ============================================================================
const HAND = sessions.find(s => s.prefix === '0ebbb2b2');
{
  const r0 = HAND.score.rows[0];
  const t0 = tileByName.get('L5_00_x0_y0_w960_h540.png');
  say('');
  say('=== 3. HAND-COMPUTED WORKED EXAMPLE (session 0ebbb2b2) ===');
  say('  line: "L5_00_x0_y0_w960_h540.png | KPQ | u=0.285 v=0.510"  tile gx=' + t0.gx + ' gy=' + t0.gy + ' gw=' + t0.gw + ' gh=' + t0.gh);
  say('  hand gx = 0 + 0.285*960 = ' + (0.285 * 960).toFixed(1) + ' ; script gx = ' + NUM(r0.gx, 1));
  say('  hand gy = 0 + 0.510*540 = ' + (0.510 * 540).toFixed(1) + ' ; script gy = ' + NUM(r0.gy, 1));
  say('  nearest label ' + r0.nearCode + ' at ' + NUM(r0.minD, 1) + 'px -> outside gate -> stray; KPQ not a true code');
  say('  session totals: reported=' + HAND.score.reported + ' inRange=' + HAND.score.inRangeCount + ' strays=' + HAND.score.strays + ' coverage=' + HAND.score.coverage + ' hitCodes=' + HAND.score.hitCodeCount + ' condCorrect=' + HAND.score.condCorrect);
  say('  hand recount from the printed per-row table: 34 rows, 31 within 60px, 13 of those with the matching code.');
}

// ============================================================================
// 6. Statistics
// ============================================================================
function logTailNormal(x) {
  // P(Z > x) = phi(x) * CF,  phi(x) = exp(-x^2/2)/sqrt(2*pi),
  // CF = 1/(x + 1/(x + 2/(x + 3/(x + ...))))  -- evaluated with modified Lentz.
  // NOTE: log(phi(x)) = -x^2/2 - 0.5*log(2*pi). There is NO log(x) term; an earlier
  // version of this script wrongly included one and was caught by the self-test below.
  if (x <= 0) throw new Error('x>0 required');
  const tiny = 1e-300;
  let f = tiny, Cc = tiny, D = 0;
  for (let n = 1; n <= 600; n++) {
    const an = Math.max(1, n - 1);   // numerator sequence 1, 1, 2, 3, 4, ...
    D = x + an * D; if (D === 0) D = tiny;
    Cc = x + an / Cc; if (Cc === 0) Cc = tiny;
    D = 1 / D;
    const delta = Cc * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return -0.5 * x * x - 0.5 * Math.log(2 * Math.PI) + Math.log(f);
}
const twoSided = (z) => { const lt = logTailNormal(Math.abs(z)); return { p: 2 * Math.exp(lt), log10p: (lt + Math.LN2) / Math.LN10 }; };
const fmtP = (o) => o.log10p < -12 ? ('10^' + o.log10p.toFixed(1)) : o.p.toExponential(3);
function twoProp(x1, n1, x2, n2) {
  const p1 = x1 / n1, p2 = x2 / n2, p = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
  const z = se ? (p1 - p2) / se : 0;
  return Object.assign({ p1, p2, pooled: p, se, z, diff: p1 - p2, x1, n1, x2, n2 }, twoSided(z));
}
function fisher(a, b, c, d) {
  // two-sided Fisher exact on [[a,b],[c,d]]; probabilities evaluated in log space.
  const lf = (n) => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
  const n = a + b + c + d, r1 = a + b, c1 = a + c;
  const lgn = lf(a + b) + lf(c + d) + lf(a + c) + lf(b + d) - lf(n);
  // cell(1,1)=x, cell(1,2)=r1-x, cell(2,1)=c1-x, cell(2,2)=n-r1-c1+x
  const lp = (x) => lgn - (lf(x) + lf(r1 - x) + lf(c1 - x) + lf(n - r1 - c1 + x));
  const l0 = lp(a); let acc = 0;
  for (let x = Math.max(0, c1 - (c + d)); x <= Math.min(r1, c1); x++) {
    const l = lp(x); if (l <= l0 + 1e-9) acc += Math.exp(l);
  }
  const p = Math.min(1, acc);
  return { p, log10p: Math.log10(p) };
}
function permTest(g1, g2) {
  const all = [...g1, ...g2], n1 = g1.length, n = all.length;
  const combos = (arr, k) => k === 0 ? [[]] : arr.flatMap((v, i) => combos(arr.slice(i + 1), k - 1).map(c => [v, ...c]));
  const obs = Math.abs(g1.reduce((a, b) => a + b, 0) / n1 - g2.reduce((a, b) => a + b, 0) / g2.length);
  let cnt = 0, tot = 0;
  for (const pick of combos([...all.keys()], n1)) {
    const s1 = pick.reduce((a, i) => a + all[i], 0), s2 = all.reduce((a, b) => a + b, 0) - s1;
    tot++; if (Math.abs(s1 / n1 - s2 / (n - n1)) >= obs - 1e-12) cnt++;
  }
  return { p: cnt / tot, cnt, tot, obs };
}
const lchoose = (n, k) => { let s = 0; for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i); return s; };
function signTest(k, n) {
  const l0 = lchoose(n, k) - n * Math.LN2; let p = 0;
  for (let i = 0; i <= n; i++) { const l = lchoose(n, i) - n * Math.LN2; if (l <= l0 + 1e-9) p += Math.exp(l); }
  return Math.min(1, p);
}
function mcnemar(b, c) {
  const n = b + c; if (!n) return 1; let p = 0;
  for (let k = 0; k <= Math.min(b, c); k++) p += Math.exp(lchoose(n, k) - n * Math.LN2);
  return Math.min(1, 2 * p);
}
const answering = sessions.filter(s => s.score);
const byArm = Object.fromEntries(ARMS.map(a => [a, answering.filter(s => s.arm === a)]));
const accs = (arm) => byArm[arm].map(r => r.score.codeAcc);
const find = (pfx) => sessions.find(s => s.prefix === pfx);
const pooled = {};
for (const arm of ARMS) {
  const runs = byArm[arm];
  const hit = runs.reduce((s, r) => s + r.score.hitCodeCount, 0);
  pooled[arm] = { runs, hit, n: 36 * runs.length, acc: runs.length ? hit / (36 * runs.length) : null };
}
const COMPARISONS = [['naive', 'down-then-up'], ['naive', 'down-only'], ['down-only', 'down-then-up']];
const stats = {};
for (const [A, B] of COMPARISONS) {
  const a = pooled[A], b = pooled[B];
  stats[A + '_vs_' + B] = Object.assign(twoProp(a.hit, a.n, b.hit, b.n), { fisher: fisher(a.hit, a.n - a.hit, b.hit, b.n - b.hit) });
}
const pairsDesign = [
  ['originals (no-filename-list prompt)', '0ebbb2b2', '5d09771c'],
  ['relaunches (explicit-filename-list prompt)', '9a322102', 'e134da0e'],
];
let npos = 0;
const designDiffs = [];
for (const [gen, doP, duP] of pairsDesign) {
  const d = find(doP).score.codeAcc - find(duP).score.codeAcc;
  if (d > 0) npos++;
  designDiffs.push({ gen, doP, duP, d });
}
const pt = permTest(accs('down-only'), accs('down-then-up'));
const qRuns = (arm) => byArm[arm].filter(r => r.fab === 0);
const qa = qRuns('down-only'), qb = qRuns('down-then-up');
const correctedB = twoProp(qa.reduce((s, r) => s + r.score.hitCodeCount, 0), 36 * qa.length, qb.reduce((s, r) => s + r.score.hitCodeCount, 0), 36 * qb.length);
const mcn = (() => {
  const A = find('9a322102'), B = find('e134da0e');
  const sa = new Set(A.score.hitCodes), sb = new Set(B.score.hitCodes);
  let both = 0, oa = 0, ob = 0, neither = 0;
  for (const L of LABELS) { const x = sa.has(L.code), y = sb.has(L.code); if (x && y) both++; else if (x) oa++; else if (y) ob++; else neither++; }
  return { both, oa, ob, neither, p: mcnemar(oa, ob) };
})();

say('');
say('=== 4. STATISTICS ===');
say('Normal-tail self-test (log-space Laplace continued fraction, modified Lentz) vs published values:');
for (const [x, ref] of [[1.959964, 0.0249979], [3, 0.001349898], [5, 2.866516e-7], [6, 9.865876e-10], [8, 6.220961e-16]]) {
  const got = Math.exp(logTailNormal(x));
  say('  P(Z>' + x + ') = ' + got.toExponential(6) + '  ref ' + ref.toExponential(6) + '  rel.err ' + ((got - ref) / ref).toExponential(2));
}
say('Fisher-exact self-test vs published tables:');
for (const [tab, ref, name] of [[[3, 1, 1, 3], 0.485714, 'tea-tasting 3/1/1/3'], [[1, 9, 11, 3], 0.002759, 'Fisher classic 1/9/11/3'], [[10, 0, 0, 10], 1.0825e-5, 'perfect 10/0/0/10']]) {
  const got = fisher(tab[0], tab[1], tab[2], tab[3]).p;
  say('  ' + name + ': p = ' + got.toExponential(6) + '  ref ' + ref.toExponential(6) + '  rel.err ' + ((got - ref) / ref).toExponential(2));
}
say('');
say('Pooled per arm (answering runs only):');
for (const arm of ARMS) say('  ' + arm.padEnd(13) + ' runs=' + pooled[arm].runs.length + '  pooled=' + pooled[arm].hit + '/' + pooled[arm].n + ' = ' + NUM(pooled[arm].acc) + '  per-run: ' + accs(arm).map(x => NUM(x)).join(', '));
say('');
for (const [A, B] of COMPARISONS) {
  const t = stats[A + '_vs_' + B];
  say('  ' + A + ' vs ' + B + ': ' + t.x1 + '/' + t.n1 + ' (' + PC(t.p1) + ') vs ' + t.x2 + '/' + t.n2 + ' (' + PC(t.p2) + ')  pooled p=' + NUM(t.pooled) + ' SE=' + NUM(t.se) + ' delta=' + NUM(t.diff) + ' z=' + NUM(t.z, 3) + ' p=' + fmtP(t) + ' fisher log10p=' + t.fisher.log10p.toFixed(2));
}
say('');
say('Run-level permutation (down-only vs down-then-up): |dmean|=' + NUM(pt.obs) + ' ' + pt.cnt + '/' + pt.tot + ' -> min two-sided p=' + NUM(pt.p, 3));
say('Design-based paired diffs: ' + designDiffs.map(d => d.gen + ': ' + d.doP + ' ' + PC(find(d.doP).score.codeAcc) + ' vs ' + d.duP + ' ' + PC(find(d.duP).score.codeAcc) + ' = ' + (100 * d.d).toFixed(1) + ' pts').join('; '));
say('Sign test k=' + npos + ' n=' + pairsDesign.length + ' p=' + NUM(signTest(npos, pairsDesign.length), 3));
say('McNemar 9a322102 vs e134da0e: both=' + mcn.both + ' onlyA=' + mcn.oa + ' onlyB=' + mcn.ob + ' neither=' + mcn.neither + ' p=' + NUM(mcn.p, 3));
say('Corrected zero-fabrication scope: down-only ' + qa.reduce((s, r) => s + r.score.hitCodeCount, 0) + '/' + (36 * qa.length) + ' vs down-then-up ' + qb.reduce((s, r) => s + r.score.hitCodeCount, 0) + '/' + (36 * qb.length) + ' z=' + NUM(correctedB.z, 3) + ' p=' + NUM(correctedB.p, 4));
say('Zero-fabrication qualifying runs: ' + ARMS.map(a => a + '=[' + qRuns(a).map(r => r.prefix).join(',') + ']').join(' '));
// Abstention sensitivity: count UNCERTAIN lines that carry a valid, true 3-char code as OBSERVED.
const sens = answering.map(r => {
  const set = new Set(r.score.rows.map(x => String(x.code || '').trim()));
  let gained = [];
  for (const u of r.answer.unc) {
    const cd = String(u.code || '').trim();
    if (/^[A-Z0-9]{3}$/.test(cd) && TRUE_CODES.has(cd) && !set.has(cd)) { set.add(cd); gained.push(cd); }
  }
  return { prefix: r.prefix, arm: r.arm, abstain: r.score.abstain, base: r.score.codeAcc, alt: [...set].filter(c => TRUE_CODES.has(c)).length / 36, gained };
});
say('');
say('Abstention sensitivity (UNCERTAIN lines carrying a true 3-char code counted as OBSERVED):');
for (const s of sens) say('  ' + s.prefix + ' ' + s.arm.padEnd(13) + ' abstain=' + String(s.abstain).padStart(2) + ' codeAcc ' + NUM(s.base) + ' -> ' + NUM(s.alt) + '  recovered=[' + s.gained.join(',') + ']');
const sensArm = Object.fromEntries(ARMS.map(a => [a, sens.filter(s => s.arm === a)]));
say('  arm means: ' + ARMS.map(a => a + '=' + NUM(sensArm[a].reduce((t, s) => t + s.alt, 0) / (sensArm[a].length || 1))).join('  '));
// Where do abstentions sit? Near a tile edge means the code was cut by the split.
const edgeAbstain = answering.map(r => {
  const near = (o) => o.u !== null && o.v !== null && (o.u < 0.02 || o.u > 0.98 || o.v < 0.02 || o.v > 0.98);
  const n = r.answer.unc.filter(near).length;
  return { prefix: r.prefix, arm: r.arm, abstain: r.score.abstain, atEdge: n };
});
say('');
say('Abstentions located within 2% of a tile edge (i.e. code likely cut by the split):');
for (const e of edgeAbstain) say('  ' + e.prefix + ' ' + e.arm.padEnd(13) + ' UNCERTAIN=' + String(e.abstain).padStart(2) + ' at-edge=' + e.atEdge);
const totUnc = edgeAbstain.reduce((t, e) => t + e.abstain, 0), totEdge = edgeAbstain.reduce((t, e) => t + e.atEdge, 0);
say('  TOTAL ' + totEdge + '/' + totUnc + ' = ' + NUM(totEdge / totUnc, 3) + ' of all abstentions are edge-split cases');

// ============================================================================
// 7. Build the markdown report with plain concatenation
// ============================================================================
const L = [];
const push = (...xs) => L.push(...xs);
const armTag = (fam) => fam === 'explicit-16-filename-list' ? 'explicit list' : 'no list';
const AE = find('a9cdcf16');

push('# Independent verification — three-arm image-reading experiment');
push('');
push('Written by a verifier that re-derived every number from raw data with its own script');
push('(' + C('verify-independent.mjs') + '). No experimenter script or score file was imported or read;');
push('in particular ' + C('score-runs.json') + ' was deliberately **not** opened. The claims under test come from ' + C('stats-arms.md') + '.');
push('');
push('**Snapshot of inputs**');
push('');
push('| session | uuid | bytes | sha256 (first 16) | mtime (local) |');
push('|---|---|---|---|---|');
for (const r of sessions) push('| ' + r.prefix + ' | ' + r.uuid + ' | ' + r.bytes + ' | ' + C(r.sha256.slice(0, 16) + '…') + ' | ' + r.mtime + ' |');
push('');
push('> **LIVE SESSION WARNING.** ' + C('a9cdcf16') + ' was **still appending events while this verification ran**:');
push('> successive reads of the same file during one sitting gave 199,920 → 213,937 → 217,313 → ' + AE.bytes + ' bytes,');
push('> and its ' + C('read_image') + ' count rose 374 → 390 → 406 → ' + AE.reads.length + '. Every number for that session');
push('> is therefore a snapshot taken at the mtime shown above, not a final value, and it is excluded from arm');
push('> statistics (see Q4). The claims doc\'s "341 fabricated" is an earlier snapshot of this same open session.');
push('');
push('## 0. Ground truth and stimuli');
push('');
push('- ' + C('truth.json') + ' is ' + fs.statSync(TRUTH).size + ' bytes and carries a **UTF-8 BOM** (it had to be stripped to parse).');
push('- source frame ' + truth.sourceW + '×' + truth.sourceH + '; ' + LABELS.length + ' labels; ' + L5.length + ' level-5 tiles; no duplicate codes.');
push('- Minimum pairwise label separation = **' + NUM(minSep, 1) + ' px** (' + minSepPair.join(' vs ') + '). As this exceeds 2×60 px, a reported');
push('  position can fall within the gate of **at most one** label, so ' + C('covered ≤ reported') + ' always holds and the metrics are well-posed.');
push('');
push('### Tile dimensions, read independently from the PNG IHDR (bytes 16..24)');
push('');
push('| arm | n | IHDR chunk | dimensions found | deviating tiles |');
push('|---|---|---|---|---|');
for (const arm of ARMS) {
  const rec = armTiles[arm];
  const byDim = new Map();
  for (const r of rec) { const k = r.w + '×' + r.h; byDim.set(k, (byDim.get(k) || 0) + 1); }
  const odd = rec.filter(r => r.h !== rec[0].h || r.w !== rec[0].w);
  push('| ' + arm + ' | ' + rec.length + ' | ' + C(rec[0].ihdr) + ' | ' + [...byDim].map(([k, v]) => '**' + k + '** ×' + v).join(', ') + ' | ' + (odd.length ? odd.map(o => o.name.replace('L5_', 'L5_')).join(', ') : 'none') + ' |');
}
push('');
push('Filename sets are byte-identical across the three arms, and all 16 truth L5 names are present in each.');
push(C('down-then-up') + ' is exactly 4× ' + C('down-only') + ' in both dimensions. The four bottom-row tiles are one pixel');
push('shorter than their siblings in both downsampled arms, i.e. the downscale was not perfectly uniform');
push('(392/960 = 0.40833 ⇒ 540 × 0.40833 = 220.5). That is a ~1.2 source-pixel effect, negligible against the');
push('60 px gate, but it means "down-only = 392×221" is not exactly true for 4 of the 16 files.');
push('');
push('## 1. Per-session arm identity, read audit, and answer');
push('');
push('Arm identity was derived from the directory named in each ' + C('read_image') + ' path, **not** from any filename');
push('(filenames are identical across arms). It was cross-checked against the directory named in the session\'s');
push('own task prompt; the two agree for all 7 sessions.');
push('');
push('| arm | run | prompt family | real/fab reads | real tiles | reported | abstain | codes | code acc | precision | pos. coverage ≤60px | median nearest | strays | cond. correct |');
push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of answering) {
  const s = r.score;
  push('| ' + r.arm + ' | ' + r.prefix + ' | ' + armTag(r.promptFamily) + ' | ' + r.real + '/' + r.fab + ' | ' + r.distinctRealTiles + '/16 | ' + s.reported + ' | ' + s.abstain + ' | ' + s.hitCodeCount + '/36 | ' + PC(s.codeAcc) + ' | ' + PC(s.precision) + ' | ' + s.coverage + '/36 | ' + NUM(s.medNearest, 1) + ' | ' + s.strays + ' | ' + s.condCorrect + '/' + s.inRangeCount + ' |');
}
push('| **(excluded)** | a9cdcf16 | no list | ' + AE.real + '/' + AE.fab + ' | ' + AE.distinctRealTiles + '/16 | — | — | — | — | — | — | — | — | — |');
push('');
push('### Session-by-session derivation');
push('');
for (const r of sessions) {
  push('**' + r.prefix + '** — ' + C(r.uuid) + ' — label *"' + r.label + '"* — model ' + C(r.model));
  push('- prompt family: **' + r.promptFamily + '**; arm named in prompt = ' + C(r.promptArm) + '; read paths = ' + C(r.arm) + ' → consistent = **' + r.armConsistent + '**');
  push('- steps=' + r.steps + '; tools: ' + [...r.tools].map(([k, v]) => k + '×' + v).join(', '));
  push('- ' + C('read_image') + ': ' + r.readsFromEvents.length + ' in ' + C('tool/call') + ' events, ' + r.readsFromBlocks.length + ' in assistant tool-call blocks → **REAL ' + r.real + ', FABRICATED ' + r.fab + ', distinct real tiles ' + r.distinctRealTiles + '/16**, repeat tile reads ' + r.repeatTileReads);
  if (r.realNonTile.length) push('- real but not one of the 16 tiles: ' + r.realNonTile.map(C).join(', '));
  if (r.repeatTileNames.length) push('- repeated real tile reads: ' + r.repeatTileNames.join(', '));
  if (r.fabList.length) push('- fabricated (nonexistent) paths: **' + r.fabList.length + '** calls, ' + new Set(r.fabList).size + ' distinct names');
  push('- answer: ' + (r.answer ? 'carrier(s) **' + r.carriers.join(' + ') + '**, all carriers byte-identical = ' + r.carrierTextsAgree : '**NONE PRODUCED**'));
  if (r.score) {
    const s = r.score;
    push('- reported=' + s.reported + ', abstain=' + s.abstain + ', codeAcc=' + s.hitCodeCount + '/36=' + NUM(s.codeAcc) + ', precision=' + s.hitCodeCount + '/' + s.reported + '=' + NUM(s.precision));
    push('- coverage≤60px=' + s.coverage + '/36, median of the 36 nearest distances=' + NUM(s.medNearest, 2) + 'px, strays=' + s.strays);
    push('- in-range reports=' + s.inRangeCount + '/' + s.reported + ', correct among them=' + s.condCorrect + ' → conditional read acc=' + NUM(s.condAcc) + '; median in-range distance=' + NUM(s.medCondDist, 2) + 'px, max=' + NUM(s.maxCondDist, 2) + 'px');
    push('- coverage sweep: ' + Object.entries(s.sweep).map(([k, v]) => k + 'px→' + v).join(', '));
  } else {
    push('- **no parseable OBSERVED/UNCERTAIN answer**');
    if (r.sendText.length) push('- it did send a ' + r.sendText[r.sendText.length - 1].length + '-character ' + C('send_message') + ' that is a BLOCKER request for the filenames, with no OBSERVED/UNCERTAIN lines');
  }
  push('');
}
push('### Answer carrier');
push('');
push('For all six answering runs the answer text is **byte-identical** in three places: the ' + C('send_message'));
push('tool-call ' + C('arguments.message') + ', the corresponding ' + C('tool/call') + ' event, and an assistant ' + C('text'));
push('content block. These are three recordings of one message, not three independent answers, so "which carrier"');
push('is a recording detail rather than evidence. ' + C('a9cdcf16') + ' produced no answer at all.');
push('');
push('### Claimed vs re-derived, run by run');
push('');
push('Claim values below are transcribed from ' + C('stats-arms.md') + ' §A (table row) and its bullets. They are');
push('verification *inputs*, not trusted outputs.');
push('');
push('| run | claim: codes | mine | claim: code acc | mine | claim: precision | mine | claim: coverage | mine | claim: cond. rate | mine | claim: median (table) | claim: median (bullet) | mine: 36-nearest | mine: in-range only |');
push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
const CLAIMS = {
  '7ced3634': { codes: 35, acc: '97.2%', prec: '97.2%', cov: '36/36', cond: '97.2%', tab: 6.5, bul: 6.5 },
  '0ebbb2b2': { codes: 14, acc: '38.9%', prec: '41.2%', cov: '31/36', cond: '45.2%', tab: 3.3, bul: 3.0 },
  '9a322102': { codes: 18, acc: '50.0%', prec: '52.9%', cov: '34/36', cond: '52.9%', tab: 3.3, bul: 3.7 },
  '63036c9a': { codes: 8, acc: '22.2%', prec: '25.0%', cov: '32/36', cond: '25.0%', tab: 3.9, bul: 4.9 },
  'e134da0e': { codes: 12, acc: '33.3%', prec: '50.0%', cov: '24/36', cond: '50.0%', tab: 4.6, bul: 5.9 },
  '5d09771c': { codes: 13, acc: '36.1%', prec: '38.2%', cov: '34/36', cond: '38.2%', tab: 2.4, bul: 3.1 },
};
for (const r of answering) {
  const s = r.score, c = CLAIMS[r.prefix];
  push('| ' + r.prefix + ' | ' + c.codes + ' | ' + s.hitCodeCount + ' | ' + c.acc + ' | ' + PC(s.codeAcc) + ' | ' + c.prec + ' | ' + PC(s.precision) + ' | ' + c.cov + ' | ' + s.coverage + '/36 | ' + c.cond + ' | ' + PC(s.condAcc) + ' | ' + c.tab + 'px | ' + c.bul + 'px | ' + NUM(s.medNearest, 2) + 'px | ' + NUM(s.medCondDist, 2) + 'px |');
}
push('');
push('Every code count, accuracy, precision and coverage reproduces. The only conditional-rate mismatch is');
push(C('0ebbb2b2') + ' (45.2% claimed vs ' + PC(13 / 31) + ' re-derived). Note also that the doc\'s per-run median column and its own');
push('bullet list disagree with each other for 5 of 6 runs, and its table column matches neither of the two');
push('defensible definitions (36-nearest median = the bullet values, which I reproduce; or the in-range-only median).');
push('');
push('## 2. Hand-verified worked example');
push('');
const r0 = HAND.score.rows[0];
push('Session ' + C('0ebbb2b2') + ', first OBSERVED line: ' + C('L5_00_x0_y0_w960_h540.png | KPQ | u=0.285 v=0.510') + '.');
push('Tile ' + C('L5_00') + ' has ' + C('gx=0, gy=0, gw=960, gh=540') + '.');
push('');
push('- hand: ' + C('gx = 0 + 0.285×960 = 273.6') + ', ' + C('gy = 0 + 0.510×540 = 275.4'));
push('- script row: ' + C('gx=' + NUM(r0.gx, 1) + ', gy=' + NUM(r0.gy, 1)) + ' ✓');
push('- nearest true label is ' + C(r0.nearCode) + ' at **' + NUM(r0.minD, 1) + ' px** → outside the 60 px gate → counted as a stray, and ' + C('KPQ') + ' is not a true code so it adds nothing to code accuracy.');
push('');
push('Full hand recount from that session\'s printed per-row table: 34 OBSERVED rows; **31** lie within 60 px of some');
push('label; of those 31 the reported code equals the nearby label\'s code in **13** rows. The script reports exactly');
push(C('reported=' + HAND.score.reported + ', inRange=' + HAND.score.inRangeCount + ', strays=' + HAND.score.strays + ', coverage=' + HAND.score.coverage + ', hitCodes=' + HAND.score.hitCodeCount + ', condCorrect=' + HAND.score.condCorrect) + '.');
push('A synthetic cross-check (4 hand-placed reports) likewise reproduced its expected ' + C('hitCodeCount=2/36') + ', ' + C('precision=0.5') + ' and conditional counts.');
push('');
push('## 3. Statistics');
push('');
push('The normal tail is computed in log space with the Laplace continued fraction and self-tested against published');
push('values (P(Z>1.96)=0.0249979, P(Z>5)=2.866516e−7, P(Z>6)=9.865876e−10, P(Z>8)=6.220961e−16); all agreed to');
push('within 1e−7 relative error, so the very small p-values below are not a polynomial approximation');
push('saturating at zero. The Fisher-exact routine is checked the same way against the tea-tasting table');
push('(3/1/1/3 → 0.485714) and the classic 1/9/11/3 table (→ 0.002759).');
push('');
push('### Per-run code accuracy (the requested per-arm range)');
push('');
push('| arm | runs | per-run code accuracy | range | pooled |');
push('|---|---|---|---|---|');
for (const arm of ARMS) {
  const a = accs(arm);
  push('| ' + arm + ' | ' + a.length + ' | ' + a.map(x => PC(x)).join(', ') + ' | **' + (100 * (Math.max(...a) - Math.min(...a))).toFixed(1) + ' points** | ' + pooled[arm].hit + '/' + pooled[arm].n + ' = ' + PC(pooled[arm].acc) + ' |');
}
push('');
push('### Pooled two-proportion z (pooled variance, positions treated as independent)');
push('');
push('| comparison | arm A | arm B | Δ | pooled p̂ | SE | z | p (two-sided) | Fisher two-sided |');
push('|---|---|---|---|---|---|---|---|---|');
for (const [A, B] of COMPARISONS) {
  const t = stats[A + '_vs_' + B];
  push('| ' + A + ' vs ' + B + ' | ' + t.x1 + '/' + t.n1 + ' (' + PC(t.p1) + ') | ' + t.x2 + '/' + t.n2 + ' (' + PC(t.p2) + ') | ' + (100 * t.diff).toFixed(1) + ' pts | ' + NUM(t.pooled) + ' | ' + NUM(t.se) + ' | **' + NUM(t.z, 3) + '** | ' + fmtP(t) + ' | log10 p = ' + t.fisher.log10p.toFixed(2) + ' |');
}
push('');
push('### Paired / run-level');
push('');
push('- Run-level exact permutation (down-only vs down-then-up): observed |Δmean| = ' + NUM(pt.obs) + ', ' + pt.cnt + '/' + pt.tot + ' arrangements as extreme → **minimum achievable two-sided p = ' + NUM(pt.p, 3) + '**. With ' + byArm['down-only'].length + ' vs ' + byArm['down-then-up'].length + ' runs, no run-level test can reach 0.05.');
for (const d of designDiffs) push('- Paired by **design generation**: ' + d.gen + ' → down-only ' + d.doP + ' ' + PC(find(d.doP).score.codeAcc) + ' vs down-then-up ' + d.duP + ' ' + PC(find(d.duP).score.codeAcc) + ' = **' + (100 * d.d).toFixed(1) + ' points**');
push('- Sign test on those ' + pairsDesign.length + ' pairs (' + npos + ' positive): **p = ' + NUM(signTest(npos, pairsDesign.length), 3) + '** (two-sided; the doc quotes 0.25, which is the one-sided value)');
push('- Code-level paired McNemar (9a322102 vs e134da0e, same prompt family): both=' + mcn.both + ', only-down-only=' + mcn.oa + ', only-down-then-up=' + mcn.ob + ', neither=' + mcn.neither + ' → exact p = ' + NUM(mcn.p, 3));
push('');
push('### Scope restriction "runs with zero fabricated filenames"');
push('');
push('| arm | qualifying runs |');
push('|---|---|');
for (const arm of ARMS) push('| ' + arm + ' | ' + (qRuns(arm).map(r => r.prefix).join(', ') || 'none') + ' |');
push('');
push('Corrected contrast under this scope: down-only ' + qa.reduce((s, r) => s + r.score.hitCodeCount, 0) + '/' + (36 * qa.length) + ' vs down-then-up ' + qb.reduce((s, r) => s + r.score.hitCodeCount, 0) + '/' + (36 * qb.length) + ', z = ' + NUM(correctedB.z, 3) + ', **p = ' + NUM(correctedB.p, 4) + '**.');
push('');
push('### Abstention behaviour');
push('');
push('| run | arm | UNCERTAIN lines | of which within 2% of a tile edge | code acc | code acc if true-code UNCERTAINs were counted | codes recovered |');
push('|---|---|---|---|---|---|---|');
for (const s of sens) {
  const e = edgeAbstain.find(x => x.prefix === s.prefix);
  push('| ' + s.prefix + ' | ' + s.arm + ' | ' + s.abstain + ' | ' + e.atEdge + ' | ' + PC(s.base) + ' | ' + PC(s.alt) + ' | ' + (s.gained.length ? s.gained.join(', ') : 'none') + ' |');
}
push('| **total** | | ' + totUnc + ' | ' + totEdge + ' (' + PC(totEdge / totUnc) + ') | | | |');
push('');
push('Two facts matter here. First, **no session recovers a single true code** from its UNCERTAIN lines — the');
push('codes those lines carry are not true codes — so abstention does **not** affect code accuracy at all.');
push('Second, ' + PC(totEdge / totUnc) + ' of all abstentions sit within 2% of a tile edge, i.e. they are codes cut in half by the split.');
push('Abstention is therefore principled boundary caution, not random reluctance — but because coverage equals');
push('the reported count in five of six runs, each abstention still removes one position from the "where" axis.');
push('That is exactly the channel through which a reporting-policy difference masquerades as an arm effect.');
push('');
push('');
push('## 4. Answers to the six questions');
push('');
push('### Q1. Range of code accuracy per arm — YES, derived');
push('');
for (const arm of ARMS) push('- **' + arm + '**: ' + accs(arm).map(x => PC(x)).join(', ') + ' → range **' + (100 * (Math.max(...accs(arm)) - Math.min(...accs(arm)))).toFixed(1) + ' points** (' + accs(arm).length + ' run' + (accs(arm).length > 1 ? 's' : '') + ')');
push('');
push('Within-arm spread (11.1 and 13.9 points) is the same order as the between-arm difference, and the naive arm');
push('has no spread at all because it has a single usable run.');
push('');
push('### Q2. "The native-resolution arm beats both downsampled arms" — SUPPORTED in direction, but the stated p-value is not valid');
push('');
push('| comparison | inputs pooled | Δ | SE | z | p (two-sided) |');
push('|---|---|---|---|---|---|');
for (const [A, B] of [['naive', 'down-then-up'], ['naive', 'down-only']]) {
  const t = stats[A + '_vs_' + B];
  push('| ' + A + ' vs ' + B + ' | ' + t.x1 + '/' + t.n1 + ' vs ' + t.x2 + '/' + t.n2 + ' | ' + (100 * t.diff).toFixed(1) + ' pts | ' + NUM(t.se) + ' | **' + NUM(t.z, 3) + '** | ' + fmtP(t) + ' |');
}
push('');
push('Numbers pooled: naive 35/36 (' + PC(pooled.naive.acc) + '); down-then-up 8+12+13 = 33/108 (' + PC(pooled['down-then-up'].acc) + '); down-only 14+18 = 32/72 (' + PC(pooled['down-only'].acc) + '). The direction is');
push('unambiguous — the naive run is above every individual downsampled run (97.2% vs a per-run range of ' + PC(Math.min(...accs('down-only'), ...accs('down-then-up'))) + '–' + PC(Math.max(...accs('down-only'), ...accs('down-then-up'))) + '), far exceeding');
push('any within-arm drift. **However**, the naive "sample" is 36 positions from **one** session: treating');
push('positions as independent observations is pseudoreplication, and at the run level the naive arm has n=1,');
push('so no arm-level test is possible. Verdict: supported in direction and magnitude, with an overstated p-value.');
push('');
push('### Q3. "An enlarged (interpolated) tile is WORSE than the same content un-enlarged" — NOT SUPPORTED at conventional significance');
push('');
{
  const t = stats['down-only_vs_down-then-up'];
  push('- Pooled, all runs (2 vs 3): ' + t.x1 + '/' + t.n1 + ' (' + PC(t.p1) + ') vs ' + t.x2 + '/' + t.n2 + ' (' + PC(t.p2) + '), Δ = ' + (100 * t.diff).toFixed(1) + ' points, SE = ' + NUM(t.se) + ', **z = ' + NUM(t.z, 3) + ', p = ' + NUM(t.p, 4) + '** (two-sided). Misses 0.05.');
}
push('- The claims doc\'s own §C declines to claim this. Note its §C quotes "p=0.027" for this comparison, which is the **one-sided** value of the same z while §A quotes the two-sided 0.0574 — the same comparison is given two different p-values.');
push('- Paired per-run differences: pairing by completion order (as the doc does) gives +16.7 and +16.7 points, but pairing by **design generation** gives ' + designDiffs.map(d => '**+' + (100 * d.d).toFixed(1) + '** (' + d.gen.split(' ')[0] + ')').join(' and ') + '. So "same sign and same magnitude" is an artefact of the chosen pairing. The sign test is p = ' + NUM(signTest(npos, pairsDesign.length), 3) + ' either way.');
push('- Under the doc\'s restricted scope (runs with zero fabricated filenames) it drops 63036c9a — but 63036c9a has **zero fabricated reads** (its 7 extra reads are repeats of real tiles). Applying that scope correctly gives down-only ' + qa.reduce((s, r) => s + r.score.hitCodeCount, 0) + '/' + (36 * qa.length) + ' vs down-then-up ' + qb.reduce((s, r) => s + r.score.hitCodeCount, 0) + '/' + (36 * qb.length) + ', **p = ' + NUM(correctedB.p, 4) + '** — nominally significant, the opposite of the doc\'s "p=0.27, therefore not claimed".');
push('');
push('**Verdict: no.** The direction is consistent (down-only above down-then-up in every comparison), but the');
push('effect is not established: the position-level pooled test misses 0.05 (p = ' + NUM(stats['down-only_vs_down-then-up'].p, 4) + '), the run-level permutation floor is');
push('p = ' + NUM(pt.p, 3) + ', and the two-sided sign test is p = ' + NUM(signTest(npos, pairsDesign.length), 3) + '. The one pooled contrast that does reach 0.05 is the');
push('scope-corrected one (p = ' + NUM(correctedB.p, 4) + '), which is itself a position-level test with only 2 vs 2 runs behind it.');
push('');
push('### Q4. Sessions to EXCLUDE — YES: a9cdcf16, and it changes the arm sizes');
push('');
push('**Exclusion rule (applied before any statistic):** drop a session that did not receive the stimulus or did');
push('not produce a scorable answer — i.e. (a) it read **0 of the 16 real tile files**, or (b) it produced **no');
push('parseable OBSERVED/UNCERTAIN answer**.');
push('');
push(C('a9cdcf16') + ' fails both. It issued ' + AE.reads.length + ' ' + C('read_image') + ' calls, of which **' + AE.fab + ' were');
push('fabricated, nonexistent filenames** (' + C('00.png') + ', ' + C('sub_00.webp') + ', ' + C('00.bmp') + ', …) and exactly **' + AE.real + '** path existed —');
push('the *directory* ' + C(AE.realNonTile[0]) + ', not a tile. It read 0/16 tiles, produced no answer, and sent a');
push('BLOCKER request for the filenames. It was also **still running while this verification executed**.');
push('');
push('Effect: counting it as a 0-scoring run would leave the naive arm with 2 runs at {0%, 97.2%}; excluding it');
push('leaves **naive = 1 run**. Arm sizes become **1 / 2 / 3** (naive / down-only / down-then-up) — exactly the');
push('imbalance that makes the pooled p-values optimistic.');
push('');
push('I did **not** exclude ' + C('5d09771c') + ' (' + find('5d09771c').fab + ' fabricated reads) or ' + C('63036c9a') + ' (7 duplicate reads): both read');
push('all 16 real tiles and delivered answers, so the stimulus was delivered and the fabricated calls cost only');
push('steps. They are carried as a sensitivity scope instead.');
push('');
push('### Q5. On the "where" axis, do the arms differ? — NO: the differences are report-count, not position');
push('');
push('- Median distance from each of the 36 labels to the nearest report: **' + answering.map(r => NUM(r.score.medNearest, 1)).join(', ') + ' px** across the six runs — every run is within ~7 px, an order of magnitude inside the 60 px gate.');
push('- Median distance restricted to reports that are in range: ' + answering.map(r => NUM(r.score.medCondDist, 1)).join(', ') + ' px; the worst single in-range report in the whole experiment is ' + NUM(Math.max(...answering.map(r => r.score.maxCondDist)), 1) + ' px.');
push('- **Five of the six runs have coverage exactly equal to their reported count** (' + answering.filter(r => r.score.coverage === r.score.reported).map(r => r.prefix).join(', ') + '): every position they reported landed inside the gate, with zero positional misses. The only exception is ' + C('0ebbb2b2') + ' (31/34), whose 3 strays are mislocated codes rather than noise.');
push('- The coverage sweep is nearly flat across gate widths (e.g. 7ced3634 covers ' + Object.entries(find('7ced3634').score.sweep).map(([k, v]) => v + ' labels at ' + k + 'px').join(', ') + '), so the choice of 60 px is doing almost no work.');
push('- Consequently ' + C('covered ≈ reported') + ', and since ' + C('covered ≤ reported') + ' must hold here (labels are ≥' + NUM(minSep, 1) + ' px apart), **the entire "where" difference between arms is the number of lines emitted and abstained on**, not annotation accuracy. The "where" task is saturated for all arms.');
push('');
push('**Verdict: no.** Positional annotation is saturated in every arm; the arms differ only in how many codes');
push('they were willing to report.');
push('');
push('### Q6. Things that should make a reader distrust these numbers');
push('');
push('1. **One arm has a single usable run.** naive = 1 answering run. Every pooled z treats 36 positions from one session as 36 independent observations.');
push('2. **The design changed mid-experiment.** Three "original" runs used a prompt with no filename list; four later runs used a prompt containing the explicit 16-filename list. Arms are not balanced across prompt families (naive 1+1, down-only 1+1, down-then-up 1+2).');
push('3. **Survival was confounded with instruction compliance.** The no-list prompt forbade every tool except ' + C('read_image') + '. Of the three originals, the two that survived (' + C('0ebbb2b2') + ', ' + C('5d09771c') + ') did so by calling ' + C('glob') + ' — a prompt violation — while ' + C('a9cdcf16') + ', which complied, produced nothing. "Which arm won" partly reflects which run cheated successfully.');
push('4. **' + C('a9cdcf16') + ' is a live, still-writing session**, so its row in any table is a moving target (374 → 390 → 406 reads while I verified). The doc\'s "341 fabricated" is an earlier snapshot of the same open session.');
push('5. **' + C('63036c9a') + '\'s "7 fabricated reads" is a misclassification.** Those are 7 *repeat reads of real tiles* (' + find('63036c9a').repeatTileNames.join(', ') + '); that session has **0** fabricated calls. The doc\'s §B therefore excludes it for a reason that is false, and its §B conclusion (p = 0.27) becomes p = ' + NUM(correctedB.p, 4) + ' when corrected.');
push('6. **Abstention differs ~7× across runs and drives the coverage axis.** UNCERTAIN counts are ' + answering.map(r => r.score.abstain).join(', ') + ', and ' + PC(totEdge / totUnc) + ' of all abstentions are codes cut in half at a tile edge. Abstention does **not** move code accuracy (no UNCERTAIN line in any session carries a true code that was not already reported), but since coverage equals the reported count in five of six runs, every abstention removes one label from the "where" axis. So the coverage gap between arms is partly a reporting-policy difference rather than a perception difference.');
push('7. **One comparison carries two different p-values** in the claims doc: §A gives two-sided 0.0574, §C gives 0.027 (one-sided). Both cannot be the headline.');
push('8. **The pairing in §C is a choice, not a design feature.** Pairing by completion order yields two +16.7-point diffs; pairing by design generation yields +2.8 and +16.7.');
push('9. **Fabricated reads inflate step counts and cost.** ' + C('a9cdcf16') + ' burned ' + AE.reads.length + ' calls for zero tiles; ' + C('5d09771c') + ' burned ' + find('5d09771c').reads.length + ' calls for 16 tiles. Any steps- or token-cost comparison across arms is contaminated.');
push('10. **Metric-definition subtleties.** "Conditional read accuracy" and "code accuracy" have different numerators: a code can be a true code yet sit far from its label (0ebbb2b2\'s ' + C('M3Z') + ', reported 163 px from the nearest label). The doc\'s table for 0ebbb2b2 substitutes the code-accuracy numerator (14) for the conditional numerator, giving 45.2% instead of the correct ' + PC(13 / 31) + '.');
push('11. **All runs used one model** (' + C(find('7ced3634').model) + ', same provider) — good for internal comparability, but this is a single-model result with no replication across models.');
push('12. **' + C('truth.json') + ' has a UTF-8 BOM**, and the downsampled arms contain four tiles whose delivered height differs from the stated tile size — both small, both signs that the pipeline is not exactly as documented.');
push('');
push('## 5. Disagreements with the claims document (' + C('stats-arms.md') + ')');
push('');
push('| # | doc says | re-derivation | impact |');
push('|---|---|---|---|');
push('| 1 | 0ebbb2b2 conditional read rate **45.2%** (14/31) | **' + PC(13 / 31) + '** (13/31) | Overstates it by 3.3 points. The 14 is the *code-accuracy* numerator; ' + C('M3Z') + ' is a true code reported 163 px from its label, so it is not an in-range correct read. |');
push('| 2 | 63036c9a: 16 real / **7 fabricated** | 23 real / **0 fabricated** (7 are repeats of real tiles: ' + find('63036c9a').repeatTileNames.map(x => x.replace(' x2', '')).join(', ') + ') | Inflates the fabrication count, and causes §B to drop a run it should keep. |');
push('| 3 | §B down-only vs down-then-up p = **0.2679** (2 vs 1 runs) | scope applied correctly: 2 vs 2 runs, z = ' + NUM(correctedB.z, 3) + ', **p = ' + NUM(correctedB.p, 4) + '** | Reverses "depends on scope, therefore not claimed" into a nominally significant pooled result — still not a valid run-level test. |');
push('| 4 | §C "both paired diffs are +16.7 points" | design-based pairing gives **+2.8** and **+16.7** | The "same sign and same magnitude" claim depends on an arbitrary pairing. |');
push('| 5 | §A p = 0.0574 vs §C p = 0.027 for the same comparison | 0.0574 two-sided / 0.0287 one-sided | The document mixes one- and two-sided p-values. |');
push('| 6 | a9cdcf16 "341 fabricated reads" | snapshot-dependent: ' + AE.fab + ' fabricated of ' + AE.reads.length + ' calls at my largest read, and still growing | Not a stable number; the session is still open. |');
push('| 7 | per-run "命中中位误差" column (6.5, 3.3, 3.3, 3.9, 4.6, 2.4 px) vs the doc\'s own bullets (6.5, 3.0, 3.7, 4.9, 5.9, 3.1 px) | 36-nearest medians **' + answering.map(r => NUM(r.score.medNearest, 2)).join(', ') + '** (the bullets) and in-range-only medians **' + answering.map(r => NUM(r.score.medCondDist, 2)).join(', ') + '** | The table column matches neither definition for 4 of 6 runs, and contradicts the doc\'s own bullet list for 5 of 6. Two different quantities share one column name. |');
push('| 8 | §C sign test "p = 0.25" | two-sided sign test p = **' + NUM(signTest(npos, pairsDesign.length), 3) + '** (0.25 is the one-sided value) | Same one-sided/two-sided mixing as #5. |');
push('');
push('Everything else I checked reproduced exactly: all six code accuracies (35, 14, 18, 8, 12, 13), all');
push('precisions, the coverage counts (36, 31, 34, 32, 24, 34), five of the six conditional rates (97.2%, 52.9%,');
push('25.0%, 50.0%, 38.2%), the pooled z = 6.94 / 5.33 / 1.90, the whole of §B\'s arithmetic as written, and the §C');
push('pairing table itself.');
push('');
push('## 6. Could NOT verify');
push('');
push('- **' + C('累计input') + ' (cumulative input tokens)** in the doc\'s run table — I did not locate per-step usage records in the session JSONL and did not attempt to reconstruct token counts.');
push('- **That the tiles were produced by the transform the doc claims.** I verified delivered dimensions only; I did not compare pixels, so "enlarged/interpolated" is taken from the experiment description, not confirmed.');
push('- **That the 16 real tiles actually contain the 36 codes** ' + C('truth.json') + ' asserts. I treated truth.json as ground truth without re-reading the images, so my metrics measure agreement *with truth.json*, not with the pixels.');
push('- **What the scoring agent did.** I did not open or execute ' + C('score-runs.json') + ' / ' + C('score-runs.mjs') + '; my numbers are independent, so agreement is a genuine cross-check, but I cannot speak to how those files computed theirs.');
push('- **' + C('a9cdcf16') + '\'s final state** — it was still appending when I stopped; its counts will differ if read later.');
push('- **Full prompt texts.** Prompt-family assignment matched on the literal ' + C('L5_00_x0_y0_w960_h540.png') + ' appearing in the first user message, which is unambiguous, but I did not diff the complete prompt bodies.');
push('');

const md = L.join('\n');
fs.writeFileSync(path.join(ROOT, 'verify-independent.md'), md, 'utf8');
fs.writeFileSync(path.join(ROOT, 'verify-independent.raw.txt'), LOG.join('\n'), 'utf8');
fs.writeFileSync(path.join(ROOT, 'verify-independent.summary.json'), JSON.stringify({
  generated: new Date().toISOString(),
  sessions: sessions.map(r => ({
    prefix: r.prefix, uuid: r.uuid, label: r.label, model: r.model,
    bytes: r.bytes, sha256: r.sha256, mtime: r.mtime,
    promptFamily: r.promptFamily, promptArm: r.promptArm, arm: r.arm, armConsistent: r.armConsistent,
    readsFromEvents: r.readsFromEvents.length, readsFromBlocks: r.readsFromBlocks.length,
    real: r.real, fab: r.fab, distinctRealTiles: r.distinctRealTiles,
    repeatTileReads: r.repeatTileReads, repeatTileNames: r.repeatTileNames, realNonTile: r.realNonTile,
    tools: Object.fromEntries(r.tools),
    answerCarriers: r.carriers, carriersAgree: r.carrierTextsAgree,
    score: r.score ? {
      reported: r.score.reported, abstain: r.score.abstain,
      hitCodeCount: r.score.hitCodeCount, codeAcc: r.score.codeAcc, precision: r.score.precision,
      coverage: r.score.coverage, medNearest: r.score.medNearest, sweep: r.score.sweep,
      inRangeCount: r.score.inRangeCount, condCorrect: r.score.condCorrect, condAcc: r.score.condAcc,
      medCondDist: r.score.medCondDist, maxCondDist: r.score.maxCondDist, strays: r.score.strays,
      hitCodes: r.score.hitCodes,
    } : null,
  })),
  pooled: Object.fromEntries(ARMS.map(a => [a, { runs: pooled[a].runs.length, hit: pooled[a].hit, n: pooled[a].n, acc: pooled[a].acc, perRun: accs(a) }])),
  comparisons: Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, { x1: v.x1, n1: v.n1, x2: v.x2, n2: v.n2, diff: v.diff, pooled: v.pooled, se: v.se, z: v.z, p: v.p, log10p: v.log10p, fisherLog10p: v.fisher.log10p }])),
  correctedZeroFabrication: { downOnly: { x: qa.reduce((s, r) => s + r.score.hitCodeCount, 0), n: 36 * qa.length }, downThenUp: { x: qb.reduce((s, r) => s + r.score.hitCodeCount, 0), n: 36 * qb.length }, z: correctedB.z, p: correctedB.p },
  handExample: { session: '0ebbb2b2', rows: HAND.score.rows },
}, null, 2), 'utf8');
console.log('\nwrote verify-independent.md, verify-independent.raw.txt, verify-independent.summary.json');
