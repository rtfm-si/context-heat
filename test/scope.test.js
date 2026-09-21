const Module=require('module');const orig=Module._resolveFilename;
Module._resolveFilename=function(r,...a){return r==='vscode'?require('path').join(__dirname,'stub/vscode.js'):orig.call(this,r,...a);};
const fs=require('fs'); const dir=require('os').tmpdir() + '/ch-scope-bridge';
fs.rmSync(dir,{recursive:true,force:true}); fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(dir+'/s.json', JSON.stringify({sessionId:'t',cwd:'/Users/si/projects/game-centre',currentDir:'/Users/si/projects/game-centre',usedPercentage:85,contextWindowSize:200000,model:'Opus 5',sessionName:'scope test',exceeds200k:false,rateLimits:{fiveHour:null,sevenDay:null},ts:Date.now()}));
const vscode=require('vscode');
// The user has hand-picked a global title bar colour. It must survive everything.
vscode.__store.global['workbench.colorCustomizations'] = { 'titleBar.activeBackground':'#2d2d44', 'editor.background':'#101010' };
vscode.__store.contextHeat.bridgeDirectory = dir;
const ext=require(__dirname + '/../out/extension.js');
let pass=0,fail=0; const t=(n,c,e)=>{c?pass++:(fail++,console.log('  FAIL: '+n+(e?'  ['+e+']':'')));};
ext.activate({subscriptions:[]});
setTimeout(async()=>{
  const ws=()=>vscode.__store.workspace['workbench.colorCustomizations']||{};
  const gl=()=>vscode.__store.global['workbench.colorCustomizations']||{};
  t('painted workspace scope', !!ws()['titleBar.activeBackground'], JSON.stringify(ws()));
  t('did NOT touch global on paint', gl()['titleBar.activeBackground']==='#2d2d44', JSON.stringify(gl()));
  t('global value is user hex, not ours', gl()['titleBar.activeBackground']!==ws()['titleBar.activeBackground']);

  await ext.deactivate();
  const ourKeys = Object.keys(ws()).filter(k=>k.startsWith('titleBar')||k.startsWith('window.')||k.startsWith('activityBar'));
  t('deactivate cleaned workspace', ourKeys.length===0, JSON.stringify(ws()));
  t("deactivate kept user's global titleBar", gl()['titleBar.activeBackground']==='#2d2d44', JSON.stringify(gl()));
  t('deactivate kept global editor.background', gl()['editor.background']==='#101010');

  // Reset command is explicit intent: it sweeps both scopes, but still only our values.
  for(const k of Object.keys(require.cache)) delete require.cache[k];
  const v2=require('vscode'); const e2=require(__dirname + '/../out/extension.js');
  v2.__store.global['workbench.colorCustomizations']={'titleBar.activeBackground':'#2d2d44'};
  v2.__store.workspace['workbench.colorCustomizations']={'titleBar.activeBackground':'#c01705','myTheme.x':'#abc'};
  v2.__store.contextHeat.bridgeDirectory=dir;
  const subs=[]; e2.activate({subscriptions:subs});
  await new Promise(r=>setTimeout(r,300));
  v2.__answer='Stop colouring';
  const reset = subs.find(x=>x&&x.id==='contextHeat.reset');
  if(reset) await reset.fn();
  await new Promise(r=>setTimeout(r,1300));
  t('warned that colours would return', (v2.__msgs||[]).some(m=>/still at 85%/.test(m||'')), JSON.stringify(v2.__msgs));
  const w2=v2.__store.workspace['workbench.colorCustomizations']||{};
  t('after Stop colouring, our hex gone and stays gone', w2['titleBar.activeBackground']===undefined, JSON.stringify(w2));
  t('reset kept unrelated key', w2['myTheme.x']==='#abc');
  t('reset kept user global hex', (v2.__store.global['workbench.colorCustomizations']||{})['titleBar.activeBackground']==='#2d2d44');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
},1500);
