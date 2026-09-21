// End-to-end cover for the bridge install flow, driven through the real
// activate(). HOME is redirected before anything loads, so this can never
// touch the developer's own ~/.claude — which is also why it lives in its own
// file rather than in the shared harness.
const path = require('path');
const fs = require('fs');
const os = require('os');

const HOME = path.join(os.tmpdir(), 'ch-install-test-home');
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;

const Module = require('module');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  return r === 'vscode' ? path.join(__dirname, 'stub/vscode.js') : orig.call(this, r, ...a);
};

let pass = 0, fail = 0;
const t = (name, cond, extra) => { cond ? pass++ : (fail++, console.log('  FAIL: ' + name + (extra ? '  [' + extra + ']' : ''))); };
const settingsPath = path.join(HOME, '.claude', 'settings.json');
const scriptPath = path.join(HOME, '.claude', 'context-heat-statusline.sh');
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

function freshExtension(configure) {
  for (const k of Object.keys(require.cache)) delete require.cache[k];
  const vscode = require('vscode');
  vscode.__store.contextHeat.checkBridge = true;
  vscode.__store.contextHeat.bridgeDirectory = path.join(HOME, '.claude', 'context-heat');
  configure(vscode);
  const ext = require(path.join(__dirname, '..', 'out', 'extension.js'));
  ext.activate(vscode.__context());
  return { vscode, ext };
}
const settle = () => new Promise((r) => setTimeout(r, 400));

(async () => {
  // --- offers to install, and preserves an existing status line ---
  fs.writeFileSync(settingsPath, JSON.stringify({
    model: 'opus[1m]',
    statusLine: { type: 'command', command: 'npx -y ccstatusline@latest', padding: 0 },
  }, null, 2));
  let { vscode, ext } = freshExtension((v) => { v.__answer = 'Install and wire up'; });
  await settle();
  t('offers to install when the bridge is missing',
    vscode.__msgs.some((m) => /bridge script/i.test(m || '')), JSON.stringify(vscode.__msgs));
  t('copies the script', fs.existsSync(scriptPath));
  t('script is executable', (fs.statSync(scriptPath).mode & 0o111) !== 0);
  let s = readSettings();
  t('points statusLine at the bridge', s.statusLine.command === scriptPath, s.statusLine.command);
  t('preserves the previous status line as CONTEXT_HEAT_INNER',
    s.env.CONTEXT_HEAT_INNER === 'npx -y ccstatusline@latest', JSON.stringify(s.env));
  t('leaves unrelated settings alone', s.model === 'opus[1m]');
  t('keeps statusLine padding', s.statusLine.padding === 0);
  t('backs the file up first', fs.existsSync(settingsPath + '.context-heat.bak'));
  await ext.deactivate();

  // --- does not nag once everything is correct ---
  ({ vscode, ext } = freshExtension((v) => { v.__answer = 'Install and wire up'; }));
  await settle();
  t('silent when already installed and wired', vscode.__msgs.length === 0, JSON.stringify(vscode.__msgs));
  await ext.deactivate();

  // --- offers to update a script from an older version ---
  fs.writeFileSync(scriptPath, '#!/bin/sh\n# an older build\n');
  ({ vscode, ext } = freshExtension((v) => { v.__answer = 'Update script'; }));
  await settle();
  t('offers to update an outdated script',
    vscode.__msgs.some((m) => /older version/i.test(m || '')), JSON.stringify(vscode.__msgs));
  t('updates it in place',
    fs.readFileSync(scriptPath, 'utf8') ===
      fs.readFileSync(path.join(__dirname, '..', 'bin', 'context-heat-statusline.sh'), 'utf8'));
  await ext.deactivate();

  // --- declining is remembered, so it asks once rather than every launch ---
  fs.writeFileSync(scriptPath, '#!/bin/sh\n# an older build again\n');
  ({ vscode, ext } = freshExtension((v) => { v.__answer = 'Not now'; }));
  await settle();
  t('asks when there is something to do', vscode.__msgs.length > 0);
  await ext.deactivate();

  // --- never rewrites a settings file it cannot parse ---
  fs.writeFileSync(settingsPath, '{ not json at all');
  fs.rmSync(scriptPath, { force: true });
  const before = fs.readFileSync(settingsPath, 'utf8');
  ({ vscode, ext } = freshExtension((v) => { v.__answer = 'Install and wire up'; }));
  await settle();
  t('leaves unparseable settings untouched', fs.readFileSync(settingsPath, 'utf8') === before);
  t('still installs the script when settings are broken', fs.existsSync(scriptPath));
  await ext.deactivate();

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
