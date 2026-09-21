const item = { text:'', tooltip:null, color:undefined, backgroundColor:undefined, shown:false,
  show(){this.shown=true;}, hide(){this.shown=false;}, dispose(){} };
// separate stores, like the real thing
// checkBridge defaults OFF in the harness on purpose: activate() would
// otherwise inspect the real ~/.claude and could offer to write to it.
const store = { global: {}, workspace: {}, contextHeat: { checkBridge: false } };
const memento = () => {
  const store = new Map();
  return { get: (k, d) => (store.has(k) ? store.get(k) : d), update: async (k, v) => void store.set(k, v) };
};

module.exports = {
  // A plausible ExtensionContext for activate().
  __context: () => ({
    subscriptions: [],
    extensionUri: { fsPath: require('path').join(__dirname, '..', '..') },
    globalState: memento(),
    workspaceState: memento(),
  }),
  __item: item, __store: store, __msgs: [], __answer: undefined,
  StatusBarAlignment:{Right:2},
  Uri:{ file:(p)=>({fsPath:p}),
        joinPath:(base,...parts)=>({fsPath:require('path').join(base.fsPath,...parts)}) },
  showErrorMessage:async()=>undefined,
  ThemeColor: class { constructor(id){this.id=id;} },
  MarkdownString: class { constructor(){this.value='';} appendMarkdown(s){this.value+=s;return this;} },
  ConfigurationTarget:{Global:1,Workspace:2},
  window:{ createStatusBarItem:()=>item, createOutputChannel:()=>({appendLine:(l)=>{if(process.env.CH_VERBOSE)console.log('[out]',l);},show(){},dispose(){}}), showQuickPick:async()=>undefined, showInformationMessage:async(...a)=>{module.exports.__msgs.push(a[0]);return module.exports.__answer;},
    showWarningMessage:async(...a)=>{module.exports.__msgs.push(a[0]);return undefined;},
    showErrorMessage:async(...a)=>{module.exports.__msgs.push(a[0]);return undefined;},
    showTextDocument:async()=>undefined },
  commands:{ registerCommand:(id,fn)=>({dispose(){},id,fn}) },
  workspace:{
    openTextDocument:async()=>({}),
    workspaceFolders:[{uri:{fsPath:'/repos/beta'}}],
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
