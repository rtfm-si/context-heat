const { bandFor, normalizeThresholds, DEFAULT_THRESHOLDS, BANDS, BAND_ORDER } = require('../out/bands.js');
const { selectForWorkspace, readAll } = require('../out/bridge.js');
const fs = require('fs');
let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? pass++ : (fail++, console.log('  FAIL: ' + name + (extra?'  ['+extra+']':''))); };
const th = normalizeThresholds(undefined);

// --- the recalibrated scale ---
t('0% cold',       bandFor(0, th).name === 'cold');
t('24% cold',      bandFor(24, th).name === 'cold');
t('25% warm',      bandFor(25, th).name === 'warm');
t('45% toasty',    bandFor(45, th).name === 'toasty');
t('60% hot',       bandFor(60, th).name === 'hot');
t('69% still hot', bandFor(69, th).name === 'hot');
t('70% BLAZING (max normal)', bandFor(70, th).name === 'blazing', bandFor(70,th).name);
t('79% blazing',   bandFor(79, th).name === 'blazing');
t('80% critical (worse)', bandFor(80, th).name === 'critical', bandFor(80,th).name);
t('97% critical',  bandFor(97, th).name === 'critical');
t('98% meltdown',  bandFor(98, th).name === 'meltdown', bandFor(98,th).name);
t('100% meltdown', bandFor(100, th).name === 'meltdown');

// escalation above the normal max must be visibly worse, not just a different colour
const blazing = BANDS.blazing, critical = BANDS.critical, meltdown = BANDS.meltdown;
t('critical flickers faster than blazing', critical.flickerMs < blazing.flickerMs);
t('meltdown flickers faster than critical', meltdown.flickerMs < critical.flickerMs);
t('blazing is silent, critical shouts', blazing.suffix === '' && critical.suffix.includes('COMPACT'));
t('meltdown shouts loudest', meltdown.suffix.includes('MELTDOWN'));
t('all heat bands tint chrome', BAND_ORDER.slice(1).every(n => !!BANDS[n].colors.chrome));

// --- configuring what counts as 'on fire' ---
const early = normalizeThresholds({ blazing: 50 }, ['blazing']);
t('blazing:50 actually takes effect', early.blazing === 50, JSON.stringify(early));
t('lower defaults pulled down under it', early.hot <= 50 && early.toasty <= 50 && early.warm <= 50, JSON.stringify(early));
t('upper bands untouched', early.critical === 80 && early.meltdown === 98);
t('50% is on fire under that config', bandFor(50, early).name === 'blazing');

const late = normalizeThresholds({ warm: 75 }, ['warm']);
t('warm:75 pushes defaults up past it', late.toasty >= 75 && late.hot >= 75 && late.blazing >= 75, JSON.stringify(late));
t('74% cold under that config', bandFor(74, late).name === 'cold');

const messy = normalizeThresholds({ warm: 80, toasty: 10, hot: 95, blazing: 20, critical: 50, meltdown: 5 },
  ['warm','toasty','hot','blazing','critical','meltdown']);
const vals = BAND_ORDER.slice(1).map(n => messy[n]);
t('user-vs-user conflict forced monotonic', vals.every((v,i) => i===0 || v >= vals[i-1]), JSON.stringify(messy));
t('no band unreachable', new Set(BAND_ORDER.slice(1).map(n => bandFor(messy[n], messy).name)).size >= 1);
t('garbage values fall back to defaults', normalizeThresholds({ blazing: NaN, hot: 'abc' }).blazing === 70);
t('out-of-range clamped', normalizeThresholds({ meltdown: 500 }, ['meltdown']).meltdown === 100);

// --- session selection ---
const mk = (id, cwd, pct, ts) => ({ sessionId: id, cwd, currentDir: cwd, usedPercentage: pct, contextWindowSize: 1e6, model: null, sessionName: null, exceeds200k: false, rateLimits:{fiveHour:null,sevenDay:null}, ts });
const now = Date.now();
const rs = [ mk('a','/Users/si/projects/game-centre',56,now), mk('b','/Users/si/projects/context-burn',7,now-5000), mk('c','/Users/si/projects/merchant-stack',47,now-2000) ];
t('picks own folder, not newest', selectForWorkspace(rs, ['/Users/si/projects/context-burn']).sessionId === 'b');
t('subfolder matches', selectForWorkspace(rs, ['/Users/si/projects/context-burn/src']).sessionId === 'b');
t('unrelated folder -> null', selectForWorkspace(rs, ['/Users/si/projects/nowhere']) === null);
t('no folders -> newest', selectForWorkspace(rs, []).sessionId === 'a');
t('empty -> null', selectForWorkspace([], ['/x']) === null);
t('exact beats parent', selectForWorkspace([mk('parent','/Users/si/projects',90,now), mk('exact','/Users/si/projects/context-burn',10,now-1)], ['/Users/si/projects/context-burn']).sessionId === 'exact');

// --- robustness ---
fs.rmSync('/tmp/ch-sel',{recursive:true,force:true}); fs.mkdirSync('/tmp/ch-sel',{recursive:true});
fs.writeFileSync('/tmp/ch-sel/broken.json','{not json');
fs.writeFileSync('/tmp/ch-sel/old.json', JSON.stringify(mk('old','/x',99, now-3600e3)));
// staleness comes from file mtime now: raw Claude payloads carry no timestamp,
// and the filesystem's is harder to get wrong than one written into the body.
const stale = (Date.now() - 3600e3) / 1000;
fs.utimesSync('/tmp/ch-sel/old.json', stale, stale);
fs.writeFileSync('/tmp/ch-sel/good.json', JSON.stringify(mk('good','/x',42, now)));
fs.writeFileSync('/tmp/ch-sel/raw.json', JSON.stringify({huge:'ignored'}));
const got = readAll('/tmp/ch-sel', 900);
t('skips broken/raw/stale', got.length === 1 && got[0].sessionId === 'good', JSON.stringify(got.map(g=>g.sessionId)));
t('missing dir not fatal', readAll('/tmp/nope-xyz', 900).length === 0);

const live = readAll(require('os').homedir()+'/.claude/context-heat', 900);
t('reads live bridge', live.length > 0);

// ===== raw payload parsing, rate limits, metrics =====
const { parseReading, pruneOldFiles } = require('../out/bridge.js');
const { metricsFor, heatPercentage, formatStatusText, formatResetIn, normalizeShow } = require('../out/metrics.js');

const RAW = {
  session_id: 'abc-123', cwd: '/p', transcript_path: '/t.jsonl',
  workspace: { current_dir: '/p', project_dir: '/p' },
  model: { id: 'claude-opus-5', display_name: 'Opus 5' }, session_name: 'build',
  context_window: { context_window_size: 1000000, used_percentage: 74, remaining_percentage: 26 },
  exceeds_200k_tokens: false,
  rate_limits: { five_hour: { used_percentage: 34, resets_at: 1789948200 },
                 seven_day: { used_percentage: 77, resets_at: 1790222400 } },
};
const rr = parseReading(RAW, 'fallback', 123);
t('raw: context pct', rr.usedPercentage === 74);
t('raw: session id', rr.sessionId === 'abc-123');
t('raw: model display name preferred', rr.model === 'Opus 5');
t('raw: transcript path', rr.transcriptPath === '/t.jsonl');
t('raw: 5h limit', rr.fiveHour.usedPercentage === 34 && rr.fiveHour.resetsAt === 1789948200);
t('raw: 7d limit', rr.sevenDay.usedPercentage === 77);
t('raw: ts from mtime', rr.ts === 123);

// legacy files written by the old bridge must still work after upgrade
const LEGACY = { sessionId: 'old-1', cwd: '/p', currentDir: '/p', usedPercentage: 55,
  contextWindowSize: 200000, model: 'Opus 5', sessionName: null, exceeds200k: false,
  rateLimits: { fiveHour: 12, sevenDay: 30 }, ts: 999 };
const lr = parseReading(LEGACY, 'fb', 456);
t('legacy: still parses', lr && lr.usedPercentage === 55, JSON.stringify(lr));
t('legacy: ts from mtime not body', lr.ts === 456);

// fallbacks when percentages are absent
t('derives from remaining_percentage',
  parseReading({ session_id:'x', context_window:{ remaining_percentage: 30 } }, 'f', 0).usedPercentage === 70);
t('derives from token counts',
  Math.round(parseReading({ session_id:'x', context_window:{ context_window_size: 1000,
    current_usage:{ input_tokens: 100, output_tokens: 0, cache_creation_input_tokens: 50,
                    cache_read_input_tokens: 250 } } }, 'f', 0).usedPercentage) === 40);
t('no context window -> null', parseReading({ session_id:'x' }, 'f', 0) === null);
t('garbage -> null', parseReading(null, 'f', 0) === null);

// metrics
const m1 = metricsFor(rr, ['context']);
t('single metric', m1.length === 1 && m1[0].key === 'context');
const m3 = metricsFor(rr, ['context','fiveHour','weekly']);
t('three metrics in stable order', m3.map(m=>m.key).join(',') === 'context,fiveHour,weekly');
const noLimits = parseReading({ session_id:'x', context_window:{ used_percentage: 50 } }, 'f', 0);
t('missing limits omitted, not shown as 0%', metricsFor(noLimits, ['context','fiveHour','weekly']).length === 1);
t('normalizeShow drops junk', normalizeShow(['context','nope','weekly']).join(',') === 'context,weekly');
t('normalizeShow never empty', normalizeShow([]).join(',') === 'context');
t('normalizeShow handles non-array', normalizeShow(undefined).join(',') === 'context');

// heat source
t('heatFrom context ignores hotter weekly', heatPercentage(m3, 'context', 74) === 74);
t('heatFrom hottest picks weekly', heatPercentage(m3, 'hottest', 74) === 77);
t('heatFrom hottest limited to shown', heatPercentage(m1, 'hottest', 74) === 74);

// status text
t('default look unchanged', formatStatusText('🔥🔥', m1, true, '') === '🔥🔥 74%');
t('multi-metric gets labels', formatStatusText('🔥🔥', m3, true, '') === '🔥🔥 ctx 74% · 5h 34% · 7d 77%');
t('suffix appended', formatStatusText('🔥🔥', m1, true, '  COMPACT') === '🔥🔥 74%  COMPACT');
t('showPercentage off', formatStatusText('🔥🔥', m3, false, '') === '🔥🔥');

// reset formatting
const resetNow = 1789948200 * 1000;
t('reset in minutes', formatResetIn(1789948200 + 300, resetNow) === '5m');
t('reset in hours', formatResetIn(1789948200 + 5000, resetNow) === '1h 23m');
t('reset in days', formatResetIn(1789948200 + 200000, resetNow) === '2d 7h');
t('reset past due', formatResetIn(1789948200 - 10, resetNow) === 'due');
t('no reset time', formatResetIn(null, resetNow) === null);

// pruning
const pdir = require('os').tmpdir() + '/ch-prune';
fs.rmSync(pdir,{recursive:true,force:true}); fs.mkdirSync(pdir,{recursive:true});
fs.writeFileSync(pdir+'/fresh.json','{}');
fs.writeFileSync(pdir+'/old.json','{}');
fs.writeFileSync(pdir+'/keep.txt','not ours');
const past = Date.now() - 30*86400000;
fs.utimesSync(pdir+'/old.json', past/1000, past/1000);
const removed = pruneOldFiles(pdir, 7);
t('prunes old bridge files', removed === 1 && !fs.existsSync(pdir+'/old.json'));
t('keeps fresh files', fs.existsSync(pdir+'/fresh.json'));
t('ignores non-bridge files', fs.existsSync(pdir+'/keep.txt'));
t('prune on missing dir is safe', pruneOldFiles('/tmp/nope-abc-xyz', 7) === 0);


// ===== gradient =====
const { paletteFor, alphaFor, ALL_SURFACES, SURFACES, normalizeSurfaces, isOurs, OWNED_KEYS } = require('../out/surfaces.js');
const grad = paletteFor(BANDS.blazing, ALL_SURFACES, true);
const alphaOf = (v) => (v.length === 9 ? parseInt(v.slice(7), 16) / 255 : 1);
t('gradient: title bar faintest', alphaOf(grad['titleBar.activeBackground']) < 0.4);
t('gradient: status bar full strength', alphaOf(grad['statusBar.background']) === 1);
t('gradient: monotonic down the stack', (() => {
  const stack = ['titleBar','tabs','sideBar','activityBar','panel','statusBar'];
  const a = stack.map(s => alphaFor(s, true));
  return a.every((v, i) => i === 0 || v >= a[i-1]);
})(), JSON.stringify(['titleBar','tabs','sideBar','activityBar','panel','statusBar'].map(s=>+alphaFor(s,true).toFixed(2))));
const flat = paletteFor(BANDS.blazing, ALL_SURFACES, false);
t('gradient off: every surface identical', flat['titleBar.activeBackground'] === flat['statusBar.background']);
t('gradient off: no alpha suffix', flat['statusBar.background'].length === 7);
t('foreground left to theme at low alpha', grad['titleBar.activeForeground'] === undefined);
t('foreground set at full alpha', !!grad['statusBar.foreground']);
t('border uses the accent, not the chrome tint',
  grad['window.activeBorder'] === BANDS.blazing.colors.border);
t('cold band paints nothing', Object.keys(paletteFor(BANDS.cold, ALL_SURFACES, true)).length === 0);
t('normalizeSurfaces drops junk', normalizeSurfaces(['titleBar','bogus','statusBar']).join(',') === 'titleBar,statusBar');
t('normalizeSurfaces handles non-array', normalizeSurfaces(null).length === 0);

// ownership: our values are recognised in BOTH gradient modes, foreign ones never
t('recognises own gradient value', isOurs('statusBar.background', grad['statusBar.background']));
t('recognises own flat value', isOurs('statusBar.background', flat['statusBar.background']));
t("never claims a user's own hex", !isOurs('titleBar.activeBackground', '#2d2d44'));
t('never claims a key it does not own', !isOurs('editor.background', grad['statusBar.background']));
// An older build wrote a different alpha for the same base colour. Exact-value
// matching stranded those keys forever; base-colour matching reclaims them.
t('reclaims a key an older build wrote', isOurs('titleBar.inactiveForeground', '#e8d5b0aa'));
t('reclaims regardless of alpha', isOurs('titleBar.activeBackground', '#c0170501'));
t('reclaims with no alpha at all', isOurs('titleBar.activeBackground', '#c01705'));
t('case-insensitive', isOurs('titleBar.activeBackground', '#C01705AA'));
t('still refuses a colour that is not ours', !isOurs('titleBar.activeBackground', '#2d2d44ff'));
t('refuses non-hex values', !isOurs('titleBar.activeBackground', 'red'));
t('OWNED_KEYS covers every painted key',
  Object.keys(grad).every(k => OWNED_KEYS.includes(k)),
  Object.keys(grad).filter(k => !OWNED_KEYS.includes(k)).join(','));

// ===== focus =====
const { computeFocus, ingest, refresh } = require('../out/focus.js');
const mkRec = (tokens, paths) => ({ tokens, paths });
t('focus: all on current files = 100%',
  computeFocus(Array.from({length:20},()=>mkRec(100,['/a.ts'])), 0.2) === 100);
t('focus: half the tokens are stale work', (() => {
  const recs = [...Array.from({length:10},()=>mkRec(100,['/old.ts'])),
                ...Array.from({length:10},()=>mkRec(100,['/new.ts']))];
  return Math.round(computeFocus(recs, 0.2)) === 50;
})(), String(computeFocus([...Array.from({length:10},()=>mkRec(100,['/old.ts'])),...Array.from({length:10},()=>mkRec(100,['/new.ts']))],0.2)));
t('focus: too few records -> null', computeFocus([mkRec(10,['/a'])], 0.2) === null);
t('focus: no paths anywhere -> null',
  computeFocus(Array.from({length:20},()=>mkRec(100,[])), 0.2) === null);
t('focus: weighted by tokens not record count', (() => {
  const recs = [mkRec(10000,['/old.ts']), ...Array.from({length:19},()=>mkRec(10,['/new.ts']))];
  return computeFocus(recs, 0.2) < 10;
})());

// incremental ingest on a synthetic append-only file
const tdir = require('os').tmpdir() + '/ch-focus';
fs.rmSync(tdir,{recursive:true,force:true}); fs.mkdirSync(tdir,{recursive:true});
const tf = tdir + '/t.jsonl';
const line = (p) => JSON.stringify({type:'assistant', message:{content:[{type:'text',text:'work on '+p}]}}) + '\n';
fs.writeFileSync(tf, Array.from({length:10},()=>line('/Users/x/a.ts')).join(''));
let fc = ingest(tf, null);
t('ingest: reads initial file', fc.records.length === 10);
const cursorAfterFirst = fc.cursor;
fs.appendFileSync(tf, Array.from({length:5},()=>line('/Users/x/b.ts')).join(''));
fc = ingest(tf, fc);
t('ingest: appends only new records', fc.records.length === 15);
t('ingest: cursor advanced', fc.cursor > cursorAfterFirst);
// a half-written final line must not be consumed twice
fs.appendFileSync(tf, '{"type":"assistant","message":{"content":[{"type":"text","text":"part');
fc = ingest(tf, fc);
t('ingest: holds back a partial line', fc.records.length === 15 && fc.partial.length > 0);
fs.appendFileSync(tf, 'ial"}]}}\n');
fc = ingest(tf, fc);
t('ingest: completes the held line', fc.records.length === 16, 'records=' + fc.records.length);
// truncation must reset rather than read garbage
fs.writeFileSync(tf, line('/Users/x/c.ts'));
fc = ingest(tf, fc);
t('ingest: restarts if file shrank', fc.records.length === 1, 'records=' + fc.records.length);
t('ingest: missing file is safe', ingest(tdir + '/nope.jsonl', null).records.length === 0);
t('refresh sets computedAt', refresh(tf, null, 0.2).computedAt > 0);

// carry-forward is what makes attribution work at all
const carried = ingest(tf, null);
fs.appendFileSync(tf, JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'no paths here'}]}}) + '\n');
const after = ingest(tf, carried);
t('carry-forward: path-less record inherits',
  after.records[after.records.length-1].paths.length > 0,
  JSON.stringify(after.records[after.records.length-1].paths));

// focus must never drive the temperature
const rFocus = parseReading(RAW, 'f', 0);
const withFocus = metricsFor(rFocus, ['context','focus'], 95);
t('focus appears as a metric', withFocus.some(m => m.key === 'focus' && m.percentage === 95));
t('focus excluded from hottest', heatPercentage(withFocus, 'hottest', 74) === 74);
t('focus omitted when unavailable', metricsFor(rFocus, ['context','focus'], null).length === 1);
t('focus labelled in status text',
  formatStatusText('🔥', withFocus, true, '') === '🔥 ctx 74% · fcs 95%');

console.log(`\n${pass} passed, ${fail} failed\n`);
console.log('scale:');
for (const n of BAND_ORDER) {
  const start = n==='cold' ? 0 : th[n];
  console.log(`  ${String(start).padStart(3)}%+  ${n.padEnd(9)} ${BANDS[n].frames[0].padEnd(8)}${BANDS[n].suffix.trim().padEnd(9)} ${BANDS[n].blurb}`);
}
console.log('\nlive sessions:');
for (const r of live) console.log(`  ${String(Math.round(r.usedPercentage)).padStart(3)}%  ${bandFor(r.usedPercentage, th).name.padEnd(9)} ${r.cwd}`);
process.exit(fail ? 1 : 0);
