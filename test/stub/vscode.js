const item = { text:'', tooltip:null, color:undefined, backgroundColor:undefined, shown:false,
  show(){this.shown=true;}, hide(){this.shown=false;}, dispose(){} };
// separate stores, like the real thing
const store = { global: {}, workspace: {}, contextHeat: {} };
module.exports = {
  __item: item, __store: store, __msgs: [], __answer: undefined,
  StatusBarAlignment:{Right:2},
  ThemeColor: class { constructor(id){this.id=id;} },
  MarkdownString: class { constructor(){this.value='';} appendMarkdown(s){this.value+=s;return this;} },
  ConfigurationTarget:{Global:1,Workspace:2},
  window:{ createStatusBarItem:()=>item, createOutputChannel:()=>({appendLine:(l)=>{if(process.env.CH_VERBOSE)console.log('[out]',l);},show(){},dispose(){}}), showQuickPick:async()=>undefined, showInformationMessage:async(...a)=>{module.exports.__msgs.push(a[0]);return module.exports.__answer;} },
  commands:{ registerCommand:(id,fn)=>({dispose(){},id,fn}) },
  workspace:{
    workspaceFolders:[{uri:{fsPath:'/Users/si/projects/game-centre'}}],
    onDidChangeConfiguration:()=>({dispose(){}}),
    getConfiguration:(section)=>({
      get:(k,d)=>{ const sid=section+'.'+k;
        if(section==='contextHeat'){
          const v = store.workspace[sid] !== undefined ? store.workspace[sid]
                  : store.global[sid] !== undefined ? store.global[sid]
                  : store.contextHeat[k];
          return v===undefined?d:v; }
        const id=sid;
        const v = store.workspace[id] !== undefined ? store.workspace[id] : store.global[id];
        return v===undefined?d:v; },
      inspect:(k)=>{ const id=section+'.'+k;
        return { globalValue: (section==='contextHeat'?undefined:store.global[id]),
                 workspaceValue: (section==='contextHeat'?undefined:store.workspace[id]),
                 workspaceFolderValue: undefined }; },
      update:async(k,v,target)=>{ const id=section+'.'+k; const bucket = target===1?'global':'workspace';
        if(v===undefined) delete store[bucket][id]; else store[bucket][id]=v; },
    }),
  },
};
