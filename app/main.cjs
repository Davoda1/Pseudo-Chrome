'use strict';
const {app,BrowserWindow,WebContentsView,ipcMain,Menu,nativeTheme,screen,shell,clipboard,dialog,session}=require('electron');
const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const net=require('node:net');
const {randomBytes}=require('node:crypto');
const {pathToFileURL}=require('node:url');
const {SiteHost,validateConfig,ACCESS_HEADER}=require('./lib/host.cjs');
const {loadDemoConfig}=require('./lib/demo-config.cjs');
const {loadFavicon}=require('./lib/favicon.cjs');
const {siteURL,allowedNavigation,displayURL,loadSiteURL}=require('./lib/navigation.cjs');
const {seedDefaultWebsite}=require('./lib/default-website.cjs');
const {PermissionManager,originOf}=require('./lib/permissions.cjs');

app.setName('Pseudo-Chrome');
const testProfile=process.env.PSEUDO_CHROME_PROFILE;
const configDir=testProfile?path.resolve(testProfile):path.join(app.getPath('appData'),'Pseudo-Chrome');
app.setPath('userData',configDir);
const www=path.join(configDir,'www');
const TOP=86;
const VERSION='1.0.0';
const assets=path.join(__dirname,'assets');
const preload=path.join(__dirname,'preload.cjs');
let win,splash,popupView,overlayKind=null,host,websiteSession,permissions,quitting=false,stopping=false,startPromise=null,watcher,stateTimer;
let tabs=[],activeTabId=null,lastSiteTabId=null,nextId=1,notice='',noticeTimer,focusAddress=0;
let hostState={status:'stopped',url:'',mode:'auto',message:'Preparing local server…',error:'',logs:[]};
const PROFILE_AVATARS=new Set(['default','spaceship','swept-hair','blue-shirt','alpine-castle']);
let settings={theme:'system',profileName:'Your Pseudo-Chrome',profileAvatar:'default',restoreWindow:true,startupUrl:'/',sitePort:43881,allowExternalPrograms:false};
let siteConfig={mode:'auto',documentRoot:'.',entry:'',args:[],env:{},npmScript:'',spa:false,port:0,backendPort:0,startupTimeoutMs:30000};
let startupIssue='';
let demoConfig={present:false,simulatedDomainName:''};
const accessToken=randomBytes(32).toString('hex');
let mediaPreviewLease=null;

function readJSON(name,fallback){
  const filename=path.join(configDir,name);
  try { const value=JSON.parse(fs.readFileSync(filename,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Expected an object');return value; }
  catch(e){if(e.code!=='ENOENT')startupIssue=`Cannot read ${name}: ${e.message}. The existing file was left untouched.`;return fallback;}
}
function writeJSON(name,data){
  const file=path.join(configDir,name),temp=file+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(data,null,2)+'\n',{mode:0o600});fs.renameSync(temp,file);
}
function actualTheme(){return nativeTheme.shouldUseDarkColors?'dark':'light';}
function active(){return tabs.find(t=>t.id===activeTabId);}
function activeWeb(){const t=active();return t&&t.view&&!t.view.webContents.isDestroyed()?t.view.webContents:null;}
function targetWeb(){return activeWeb()||tabs.find(t=>t.id===lastSiteTabId&&t.view&&!t.view.webContents.isDestroyed())?.view.webContents||tabs.find(t=>t.view&&!t.view.webContents.isDestroyed())?.view.webContents;}
function tell(message){notice=String(message).slice(0,1500);clearTimeout(noticeTimer);emitState();noticeTimer=setTimeout(()=>{notice='';emitState();},7000);}
function permissionContext(tab){return tab?{tabId:tab.id,documentId:tab.permissionDocument||0}:{};}
function permissionPrompt(){
  const prompt=permissions?.prompt;if(!prompt)return null;
  return {...prompt,host:demoConfig.simulatedDomainName||prompt.host,mediaPreviewAllowed:mediaPreviewLease?.id===prompt.id};
}
function stopMediaPreview(){
  const lease=mediaPreviewLease;mediaPreviewLease=null;
  if(lease&&popupView&&!popupView.webContents.isDestroyed())popupView.webContents.send('pseudo:state',{action:'stop-media-preview',id:lease.id});
  if(lease&&!quitting)emitState();
}
function configurePreviewSession(){
  const ses=popupView.webContents.session;
  const allowed=(wc,permission,details={},request=false)=>{
    const prompt=permissions?.prompt,lease=mediaPreviewLease;
    if(quitting||permission!=='media'||!lease||!prompt||prompt.id!==lease.id||overlayKind!=='permission'
      ||wc!==popupView?.webContents||wc.isDestroyed()||wc.id!==lease.webContentsId||details.isMainFrame===false)return false;
    const expected=pathToFileURL(path.join(__dirname,'ui','index.html')).href;
    if(wc.getURL().split('?')[0]!==expected)return false;
    const types=Array.isArray(details.mediaTypes)?details.mediaTypes:details.mediaType?[details.mediaType]:[];
    if(!types.length)return !request;
    return types.every(type=>lease.types.has(type));
  };
  ses.setPermissionCheckHandler((wc,permission,_origin,details)=>allowed(wc,permission,details));
  ses.setPermissionRequestHandler((wc,permission,callback,details)=>callback(allowed(wc,permission,details,true)));
  // The ordinary toolbar has no media privilege. The website uses its own
  // persistent session, separate from both trusted interface sessions.
  session.defaultSession.setPermissionCheckHandler(()=>false);
  session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
}
async function updateFavicon(tab,refreshCandidates=false){
  const wc=tab.view?.webContents;if(!wc||wc.isDestroyed())return;
  const base=wc.getURL()||tab.url,documentVersion=tab.metadataVersion,version=++tab.faviconVersion;
  if(!allowedNavigation(base,hostState.url))return;
  // A hash or history change keeps the same document and its pending icon.
  // Full navigations and newer icon updates invalidate these generations.
  const current=()=>tabs.includes(tab)&&!wc.isDestroyed()&&tab.metadataVersion===documentVersion&&tab.faviconVersion===version;
  if(refreshCandidates){
    // Chromium may omit page-favicon-updated for an unchanged cached icon on
    // reload. Read this document's declarations without trusting page scripts.
    try{
      const declared=await wc.executeJavaScriptInIsolatedWorld(999,[{code:"Array.from(document.querySelectorAll('link[rel]')).filter(link => link.rel.toLowerCase().split(/\\s+/).includes('icon')).slice(0,8).map(link => link.href)"}]);
      if(!current())return;
      if(Array.isArray(declared))tab.faviconCandidates=[...new Set([...tab.faviconCandidates,...declared.filter(url=>typeof url==='string')])].slice(0,16);
    }catch{if(!current())return;}
  }
  const candidates=[...tab.faviconCandidates,new URL('/favicon.ico',base).href];
  for(const candidate of [...new Set(candidates)]){
    const data=await loadFavicon(websiteSession,candidate,base);
    if(!current())return;
    if(data){tab.favicon=data;emitState();return;}
  }
  if(current()){tab.favicon='';emitState();}
}
function siteInfo(){
  const tab=active(),wc=activeWeb();
  if(!wc||!allowedNavigation(wc.getURL(),hostState.url))return {available:false,permissions:[]};
  const origin=originOf(wc.getURL());
  return {available:true,origin,host:new URL(origin).host,displayHost:demoConfig.simulatedDomainName||new URL(origin).host,isLocal:true,secure:false,permissions:permissions?.list(origin,permissionContext(tab))||[]};
}
function snapshot(){
  return {version:VERSION,overlayKind,permissionPrompt:permissionPrompt(),siteInfo:siteInfo(),demoConfig:{present:demoConfig.present,simulatedDomainName:demoConfig.simulatedDomainName,port:demoConfig.port},platform:process.platform,lastSiteZoom:targetWeb()?.getZoomFactor()||1,theme:actualTheme(),maximized:!!win&&!win.isDestroyed()&&win.isMaximized(),fullscreen:!!win&&!win.isDestroyed()&&win.isFullScreen(),tabs:tabs.map(t=>({id:t.id,title:t.title,url:t.url,displayUrl:displayURL(t.url,hostState.url,demoConfig.simulatedDomainName),favicon:t.favicon||'',loading:t.loading,canGoBack:!!t.view&&!t.view.webContents.isDestroyed()&&t.view.webContents.navigationHistory.canGoBack(),canGoForward:!!t.view&&!t.view.webContents.isDestroyed()&&t.view.webContents.navigationHistory.canGoForward(),kind:t.kind,zoom:t.view&&!t.view.webContents.isDestroyed()?t.view.webContents.getZoomFactor():1,error:t.error||''})),activeTabId,settings:{allowExternalPrograms:settings.allowExternalPrograms,theme:settings.theme,profileName:settings.profileName,profileAvatar:settings.profileAvatar,restoreWindow:settings.restoreWindow,startupUrl:settings.startupUrl},siteConfig,paths:{www,config:configDir},host:{...hostState,logs:hostState.logs.slice(-250)},notice,focusAddress,splashProgress:{message:hostState.message||'Preparing local server…',status:hostState.status}};
}
function sendState(){stateTimer=null;if(win&&!win.isDestroyed())win.setTitle((active()?.title||'Pseudo-Chrome')+' — Pseudo-Chrome');const state=snapshot();for(const wc of [win?.webContents,splash?.webContents,popupView?.webContents])if(wc&&!wc.isDestroyed())wc.send('pseudo:state',state);}
function emitState(){if(!stateTimer)stateTimer=setTimeout(sendState,25);}
function relayout(){
  if(!win||win.isDestroyed())return;
  const [width,height]=win.getContentSize();
  for(const t of tabs)if(t.view){t.view.setBounds({x:0,y:TOP,width:Math.max(1,width),height:Math.max(1,height-TOP)});t.view.setVisible(t.id===activeTabId&&t.kind==='site');}
  if(popupView){popupView.setBounds({x:0,y:0,width:Math.max(1,width),height:Math.max(1,height)});if(overlayKind)win.contentView.addChildView(popupView);}
  emitState();
}
function openOverlay(kind){
  if(!['main','tabs','profile','site','permission'].includes(kind))throw new Error('Invalid popup.');
  if(!popupView||popupView.webContents.isDestroyed()||!win||win.isDestroyed())return;
  if(kind==='site'&&!siteInfo().available)return;
  if(kind==='permission'&&!permissions?.prompt)return;
  if(kind!=='permission'&&permissions?.prompt)permissions.cancelWhere(()=>true);
  overlayKind=kind;relayout();sendState();popupView.setVisible(true);popupView.webContents.focus();
  popupView.webContents.send('pseudo:state',{action:'open-popup',kind});
}
function closeOverlay(restoreFocus=true,dismissPermission=true){
  if(!overlayKind)return;
  const wasPermission=overlayKind==='permission';
  if(wasPermission)stopMediaPreview();
  const pending=overlayKind==='permission'&&dismissPermission?permissions?.prompt:null;
  overlayKind=null;
  if(popupView&&!popupView.webContents.isDestroyed()){
    popupView.setVisible(false);popupView.webContents.send('pseudo:state',{action:'close-popups'});
  }
  if(restoreFocus&&win&&!win.isDestroyed()){if(wasPermission&&activeWeb())activeWeb().focus();else win.webContents.focus();}
  emitState();
  if(pending)permissions.respond(pending.id,'dismiss');
}
function permissionChanged(prompt){
  if(mediaPreviewLease&&mediaPreviewLease.id!==prompt?.id)stopMediaPreview();
  if(quitting)return;
  if(prompt){
    if(!tabs.some(tab=>tab.id===prompt.tabId))return;
    activeTabId=prompt.tabId;lastSiteTabId=prompt.tabId;
    if(overlayKind==='permission'){relayout();sendState();}
    else openOverlay('permission');
  }else if(overlayKind==='permission')closeOverlay(true,false);
  else emitState();
}
function endUnusedVisits(){
  if(!permissions)return;
  for(const origin of permissions.sessions.keys())if(!tabs.some(tab=>tab.view&&!tab.view.webContents.isDestroyed()&&originOf(tab.view.webContents.getURL())===origin))permissions.endVisit(origin);
}
function reloadPermissionTabs(origin){
  for(const tab of tabs){const wc=tab.view?.webContents;if(wc&&!wc.isDestroyed()&&originOf(wc.getURL())===origin){permissions.forgetDocument(tab.id);wc.reload();}}
}

function internal(route){
  if(permissions?.prompt)permissions.cancelWhere(()=>true);
  const kind=route.split('/')[0];
  const existing=tabs.find(t=>t.kind===kind);
  if(existing){existing.url='pseudo://'+route;activeTabId=existing.id;relayout();return existing;}
  const title={settings:'Settings',about:'About Pseudo-Chrome',welcome:'Pseudo-Chrome'}[kind]||'Pseudo-Chrome';
  const tab={id:String(nextId++),kind,title,url:'pseudo://'+route,favicon:'',loading:false,view:null};tabs.push(tab);activeTabId=tab.id;relayout();return tab;
}
function blocked(url){tell('External page navigation is disabled. This window presents only your local website.');}
function openSiteDevTools(wc=targetWeb(),point){
  if(quitting||!wc||wc.isDestroyed())return;
  const tab=tabs.find(tab=>tab.view?.webContents===wc);if(!tab)return;
  // A docked inspector is inside its website view, so reveal that tab when
  // opening tools from Settings/About or an older context-menu selection.
  lastSiteTabId=tab.id;
  if(activeTabId!==tab.id){activeTabId=tab.id;relayout();}
  // Inspect retains its source tab, even if another tab became active while the
  // native context menu was open. Let Chromium retain the selected Dock side;
  // forcing "detach" disables its built-in docking controls.
  wc.openDevTools();
  if(point&&!wc.isDestroyed())wc.inspectElement(point.x,point.y);
}
function isBuiltInDevToolsRequest(details){
  const wc=details.webContents;
  if(!wc||wc.isDestroyed()||wc.getType()!=='remote'||wc.session!==websiteSession)return false;
  try{const url=new URL(details.url);return url.protocol==='devtools:'&&url.hostname==='devtools'&&!url.port&&!url.username&&!url.password&&url.pathname==='/bundled/devtools_app.html';}catch{return false;}
}
function wireShortcuts(wc){
  wc.on('before-input-event',(event,input)=>{
    if(input.type!=='keyDown')return;
    const ctrl=input.control||input.meta,key=input.key.toLowerCase();
    const perform=fn=>{event.preventDefault();if(permissions?.prompt)permissions.cancelWhere(()=>true);closeOverlay();fn();};
    if(ctrl&&input.shift&&key==='a'){event.preventDefault();openOverlay('tabs');return;}
    if(input.alt&&key==='f'){event.preventDefault();openOverlay('main');return;}
    if(overlayKind&&key==='escape'){event.preventDefault();closeOverlay();return;}
    if(ctrl&&key==='l')return perform(()=>{win.webContents.focus();win.webContents.send('pseudo:state',{action:'focus-address'});});
    if(ctrl&&key==='t')return perform(()=>newTab());
    if(ctrl&&key==='w')return perform(()=>closeTab(activeTabId));
    if((ctrl&&key==='r')||key==='f5')return perform(()=>reload(!!input.shift));
    if(input.alt&&key==='arrowleft')return perform(()=>activeWeb()?.navigationHistory.goBack());
    if(input.alt&&key==='arrowright')return perform(()=>activeWeb()?.navigationHistory.goForward());
    if(ctrl&&key==='tab')return perform(()=>{if(tabs.length){let i=tabs.findIndex(t=>t.id===activeTabId);activeTabId=tabs[(i+(input.shift?-1:1)+tabs.length)%tabs.length].id;relayout();activeWeb()?.focus();}});
    if(ctrl&&/^[1-9]$/.test(key))return perform(()=>{const t=tabs[key==='9'?tabs.length-1:Math.min(+key-1,tabs.length-1)];if(t){activeTabId=t.id;relayout();}});
    if(ctrl&&['+','=','-','0'].includes(key))return perform(()=>zoom(key==='0'?{reset:true}:{delta:key==='-'?-.1:.1}));
    if(key==='f11')return perform(()=>win.setFullScreen(!win.isFullScreen()));
    if(key==='f12'||(ctrl&&input.shift&&key==='i'))return perform(()=>openSiteDevTools());
    if(ctrl&&key==='p')return perform(()=>activeWeb()?.print({printBackground:true}));
    if(key==='escape'&&activeWeb()?.isLoading())return perform(()=>activeWeb().stop());
  });
}
function createSiteTab(url,options={}){
  if(tabs.length>=30){tell('Close a tab before opening more.');return active();}
  if(permissions?.prompt)permissions.cancelWhere(()=>true);
  const tab={id:String(nextId++),kind:'site',title:'Loading…',url,favicon:'',loading:true,error:'',view:null,permissionDocument:0,metadataVersion:0,faviconVersion:0,faviconCandidates:[]};
  const view=new WebContentsView({...(options.webContents?{webContents:options.webContents}:{}),webPreferences:{...(options.webPreferences||{}),preload:undefined,session:websiteSession,nodeIntegration:false,nodeIntegrationInWorker:false,nodeIntegrationInSubFrames:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,spellcheck:true}});
  tab.view=view;tabs.push(tab);activeTabId=tab.id;lastSiteTabId=tab.id;win.contentView.addChildView(view);const wc=view.webContents;
  wc.setUserAgent(wc.getUserAgent().replace(/\sElectron\/\S+/g,'').replace(/\sPseudo-Chrome\/\S+/g,''));
  const guard=(e,url)=>{if(!(options.allowBlank&&url==='about:blank')&&!allowedNavigation(url,hostState.url)){e.preventDefault();blocked(url);}};
  wc.on('will-navigate',guard);
  wc.on('will-redirect',(e,url,_inPage,isMainFrame)=>{if(isMainFrame!==false)guard(e,url);});
  wc.setWindowOpenHandler(({url})=>{
    const allowBlank=url==='about:blank'&&allowedNavigation(wc.getURL(),hostState.url);
    if(!allowBlank&&!allowedNavigation(url,hostState.url)){blocked(url);return {action:'deny'};}
    if(tabs.length>=30){tell('Close a tab before opening more.');return {action:'deny'};}
    // Chromium keeps referrers, POST form bodies and opener relationships when
    // it creates the navigation; the new WebContents is presented as a tab.
    return {action:'allow',outlivesOpener:true,createWindow:windowOptions=>createSiteTab(url,{webContents:windowOptions.webContents,webPreferences:windowOptions.webPreferences,autoLoad:false,allowBlank}).view.webContents};
  });
  wc.on('destroyed',()=>{if(tabs.includes(tab))closeTab(tab.id);});
  // A prompt belongs to its requesting document, including same-origin frames.
  // Any frame navigation invalidates pending callbacks; a top-level navigation
  // also expires the one-time grants held by that document.
  wc.on('did-start-navigation',(_e,_url,isInPlace,isMainFrame)=>{
    if(!isInPlace){
      if(isMainFrame){tab.permissionDocument++;permissions?.forgetDocument(tab.id);tab.metadataVersion++;tab.faviconVersion++;tab.favicon='';tab.faviconCandidates=[];tab.title='Loading…';}
      else permissions?.cancelWhere(request=>request.tabId===tab.id);
    }
  });
  wc.on('page-title-updated',(e,title)=>{e.preventDefault();tab.title=String(title||'Local website').slice(0,300);emitState();});
  wc.on('page-favicon-updated',(_e,icons)=>{tab.faviconCandidates=Array.isArray(icons)?icons.slice(0,8):[];void updateFavicon(tab);});
  wc.on('did-start-loading',()=>{tab.loading=true;tab.error='';emitState();});
  wc.on('did-stop-loading',()=>{tab.loading=false;tab.url=wc.getURL()||tab.url;tab.title=String(wc.getTitle()||'Local website').slice(0,300);void updateFavicon(tab,true);emitState();});
  wc.on('did-navigate',(_e,url)=>{tab.url=url;endUnusedVisits();emitState();});
  wc.on('did-navigate-in-page',(_e,url,isMainFrame)=>{if(isMainFrame){tab.url=url;emitState();}});
  wc.on('did-fail-load',(_e,code,description,url,isMainFrame)=>{if(isMainFrame&&code!==-3){tab.loading=false;tab.error=description;tab.title='Could not load website';tell(`Could not load ${url}: ${description}`);}});
  wc.on('render-process-gone',(_e,detail)=>{permissions?.forgetDocument(tab.id);tab.permissionDocument++;tab.error='The page process stopped: '+detail.reason;tab.loading=false;tell(tab.error+' Reload this tab to retry.');});
  wc.on('context-menu',(_e,p)=>{
    const items=[];
    if(p.linkURL)items.push({label:'Open link in new tab',enabled:allowedNavigation(p.linkURL,hostState.url),click:()=>createSiteTab(p.linkURL)},{label:'Copy link address',click:()=>clipboard.writeText(p.linkURL)},{type:'separator'});
    if(p.isEditable)items.push({role:'undo'},{role:'redo'},{type:'separator'},{role:'cut'},{role:'copy'},{role:'paste'},{role:'selectAll'});
    else if(p.selectionText)items.push({role:'copy'});
    items.push({type:'separator'},{label:'Back',enabled:wc.navigationHistory.canGoBack(),click:()=>wc.navigationHistory.goBack()},{label:'Forward',enabled:wc.navigationHistory.canGoForward(),click:()=>wc.navigationHistory.goForward()},{label:'Reload',click:()=>wc.reload()},{type:'separator'},{label:'Inspect',click:()=>openSiteDevTools(wc,{x:p.x,y:p.y})});
    Menu.buildFromTemplate(items).popup({window:win});
  });
  wireShortcuts(wc);relayout();if(options.autoLoad!==false)loadSiteURL(wc,url).catch(e=>{if(!wc.isDestroyed())tell(e.message);});return tab;
}
function newTab(url){
  if(url&&url.startsWith('pseudo://'))return internal(url.slice(9));
  if(hostState.status==='ready'&&hostState.url){const target=siteURL(url||settings.startupUrl||'/',hostState.url,demoConfig.simulatedDomainName);if(target.startsWith('pseudo://'))return internal(target.slice(9));return createSiteTab(target);}
  return internal('welcome');
}
function closeTab(id){
  const i=tabs.findIndex(t=>t.id===id);if(i<0)return;const [tab]=tabs.splice(i,1);
  permissions?.forgetDocument(tab.id);
  if(tab.view){const wc=tab.view.webContents;if(win&&!win.isDestroyed())win.contentView.removeChildView(tab.view);if(wc&&!wc.isDestroyed())wc.close();}
  endUnusedVisits();
  if(quitting)return;
  if(!tabs.length){internal('welcome');return;}
  if(activeTabId===id)activeTabId=tabs[Math.min(i,tabs.length-1)].id;relayout();
}
function reload(ignoreCache=false){const wc=activeWeb();if(wc){if(ignoreCache)wc.reloadIgnoringCache();else wc.reload();}else restartSite().catch(e=>tell(e.message));}
function zoom(payload){const wc=targetWeb();if(!wc)return;const delta=Number(payload.delta||0);if(!Number.isFinite(delta))throw new Error('Invalid zoom.');const z=payload.reset?1:Math.min(3,Math.max(.5,Math.round((wc.getZoomFactor()+delta)*100)/100));wc.setZoomFactor(z);emitState();}
function runtimePaths(){
  const roots=[process.env.PSEUDO_CHROME_RUNTIMES,path.join(process.resourcesPath,'runtimes'),path.join(__dirname,'..','runtimes',process.platform==='win32'?'win':'linux')].filter(Boolean);
  for(const root of roots){const manifest=path.join(root,'paths.json');if(fs.existsSync(manifest)){const paths=JSON.parse(fs.readFileSync(manifest,'utf8'));const out={};for(const k of ['nginx','node','npmCli','php','processRunner'])if(paths[k])out[k]=path.resolve(root,paths[k]);return out;}}
  throw new Error('Bundled website runtimes were not found. Extract the complete portable archive, including the resources folder.');
}
async function availablePort(port){return await new Promise(resolve=>{const s=net.createServer();s.once('error',()=>resolve(false));s.listen(port,'127.0.0.1',()=>s.close(()=>resolve(true)));});}
async function restartSite(){
  if(startPromise)return startPromise;
  startPromise=(async()=>{
    permissions?.cancelWhere(()=>true);
    const oldOrigin=hostState.url?new URL(hostState.url).origin:null;
    const oldTabs=tabs.filter(t=>t.kind==='site').map(t=>({tab:t,url:t.url}));
    hostState={...hostState,status:'starting',error:'',message:'Starting website…'};emitState();
    if(host)await host.stop();
    const entries=await fsp.readdir(www);
    if(!entries.length){hostState={...hostState,status:'empty',url:'',message:'Your website folder is ready.',error:''};internal('welcome');emitState();return;}
    if(startupIssue)throw new Error(startupIssue);
    demoConfig=await loadDemoConfig(www);
    const config={...siteConfig};
    if(demoConfig.port!==undefined)config.port=demoConfig.port;
    if(!config.port){const desired=Number(settings.sitePort)||43881;config.port=(await availablePort(desired))?desired:0;}
    const result=await host.start(config);
    hostState={...hostState,status:'ready',url:result.url,mode:result.mode,message:'Loading your website…',error:''};
    settings.sitePort=Number(new URL(result.url).port);writeJSON('settings.json',settings);
    const surviving=oldTabs.filter(({tab})=>tabs.includes(tab)&&tab.view&&!tab.view.webContents.isDestroyed());
    if(surviving.length){for(const {tab,url} of surviving){if(url==='about:blank')continue;let target=result.url;try{const u=new URL(url),local=new URL(result.url);local.pathname=u.pathname;local.search=u.search;local.hash=u.hash;target=local.href;}catch{}tab.url=target;loadSiteURL(tab.view.webContents,target).catch(e=>tell(e.message));}if(oldOrigin!==new URL(result.url).origin)tell('The local port changed because the previous port was in use.');}
    else newTab();
    if(tabs.some(t=>t.kind==='site'))for(const t of tabs.filter(t=>t.kind==='welcome'))closeTab(t.id);
    emitState();
  })().catch(e=>{hostState={...hostState,status:'error',message:'Website needs attention',error:e.message};internal('welcome');emitState();throw e;}).finally(()=>{startPromise=null;});
  return startPromise;
}
async function clearSiteData(){
  const result=await dialog.showMessageBox(win,{type:'question',buttons:['Cancel','Clear website data'],defaultId:0,cancelId:0,message:'Clear this demonstration website’s saved data?',detail:'Cookies, cache and local browser storage will be removed. Files in www are not changed.'});
  if(result.response===1){await websiteSession.clearStorageData();await websiteSession.clearCache();tell('Website data cleared.');activeWeb()?.reload();}
}
function validateSettings(p){
  const result={...settings};if(p.allowExternalPrograms!==undefined){if(typeof p.allowExternalPrograms!=='boolean')throw new Error('External application access must be on or off.');result.allowExternalPrograms=p.allowExternalPrograms;}if(p.theme!==undefined){if(!['system','light','dark'].includes(p.theme))throw new Error('Invalid theme.');result.theme=p.theme;}
  if(p.profileName!==undefined){if(typeof p.profileName!=='string'||!p.profileName.trim()||p.profileName.trim().length>64||/[\u0000-\u001f\u007f-\u009f]/.test(p.profileName))throw new Error('Profile name must contain 1 to 64 characters without control characters.');result.profileName=p.profileName.trim();}
  if(p.profileAvatar!==undefined){if(!PROFILE_AVATARS.has(p.profileAvatar))throw new Error('Invalid profile image.');result.profileAvatar=p.profileAvatar;}
  if(p.restoreWindow!==undefined)result.restoreWindow=!!p.restoreWindow;
  if(p.startupUrl!==undefined){if(typeof p.startupUrl!=='string'||p.startupUrl.length>2048)throw new Error('Invalid startup path.');const u=p.startupUrl.trim()||'/';if(!u.startsWith('/')||u.startsWith('//')||u.includes('\\'))throw new Error('Startup address must be a website path such as / or /demo.');result.startupUrl=u;}
  return result;
}
ipcMain.handle('pseudo:command',async(event,command,payload={})=>{
  const isUI=win&&!win.isDestroyed()&&(event.sender===win.webContents||event.sender===popupView?.webContents);
  const isSplash=splash&&!splash.isDestroyed()&&event.sender===splash.webContents;
  if(!isUI&&!isSplash)throw new Error('Unauthorized request.');
  if(event.senderFrame!==event.sender.mainFrame)throw new Error('Unauthorized frame.');
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw new Error('Invalid request.');
  if(isSplash&&!['getState','window'].includes(command))throw new Error('Unavailable during startup.');
  switch(command){
    case 'getState':return snapshot();
    case 'newTab':newTab();break;
    case 'selectTab':if(tabs.some(t=>t.id===payload.id)){if(permissions?.prompt)permissions.cancelWhere(()=>true);activeTabId=payload.id;if(activeWeb())lastSiteTabId=activeTabId;relayout();activeWeb()?.focus();}break;
    case 'closeTab':closeTab(payload.id);break;
    case 'reorderTabs':if(Array.isArray(payload.ids)&&payload.ids.length===tabs.length&&new Set(payload.ids).size===tabs.length&&payload.ids.every(id=>tabs.some(t=>t.id===id)))tabs=payload.ids.map(id=>tabs.find(t=>t.id===id));break;
    case 'navigate':{const url=siteURL(payload.url,hostState.url,demoConfig.simulatedDomainName);if(url.startsWith('pseudo://'))internal(url.slice(9));else if(activeWeb())await loadSiteURL(activeWeb(),url);else createSiteTab(url);break;}
    case 'back':if(activeWeb()?.navigationHistory.canGoBack())activeWeb().navigationHistory.goBack();break;
    case 'forward':if(activeWeb()?.navigationHistory.canGoForward())activeWeb().navigationHistory.goForward();break;
    case 'reload':reload();break;
    case 'stop':activeWeb()?.stop();break;
    case 'menu':openOverlay(payload.kind==='tabs'?'tabs':'main');break;
    case 'setOverlay':if(typeof payload.open!=='boolean')throw new Error('Invalid popup state.');if(payload.open)openOverlay(payload.kind);else closeOverlay();break;
    case 'startMediaPreview':{const prompt=permissions?.prompt;if(event.sender!==popupView?.webContents||typeof payload.id!=='string'||!prompt||prompt.id!==payload.id||prompt.permission!=='media'||overlayKind!=='permission')throw new Error('This media preview is no longer available.');mediaPreviewLease={id:prompt.id,types:new Set(prompt.mediaTypes),webContentsId:event.sender.id};break;}
    case 'stopMediaPreview':if(event.sender!==popupView?.webContents)throw new Error('Unavailable outside the permission popup.');if(!payload.id||mediaPreviewLease?.id===payload.id)stopMediaPreview();break;
    case 'respondPermission':if(typeof payload.id!=='string')throw new Error('Invalid permission request.');if(mediaPreviewLease?.id===payload.id)stopMediaPreview();permissions.respond(payload.id,payload.decision);break;
    case 'setSitePermission':{const info=siteInfo();if(!info.available)throw new Error('Open your local website to change permissions.');permissions.set(info.origin,payload.key,payload.state);if(payload.state!=='allow')reloadPermissionTabs(info.origin);break;}
    case 'resetSitePermissions':{const info=siteInfo();if(!info.available)throw new Error('Open your local website to reset permissions.');permissions.reset(info.origin);reloadPermissionTabs(info.origin);break;}
    case 'print':activeWeb()?.print({printBackground:true});break;
    case 'window':if(payload.action==='close')app.quit();else if(payload.action==='minimize')(isSplash?splash:win).minimize();else if(!isSplash&&payload.action==='maximize')win.isMaximized()?win.unmaximize():win.maximize();else if(!isSplash&&payload.action==='fullscreen')win.setFullScreen(!win.isFullScreen());break;
    case 'saveSettings':{const next=validateSettings(payload);writeJSON('settings.json',next);settings=next;host?.setAccessPolicy({allowExternalPrograms:settings.allowExternalPrograms,token:accessToken});nativeTheme.themeSource=settings.theme;break;}
    case 'saveSiteConfig':{const proposed=typeof validateConfig==='function'?validateConfig(payload,www):payload;siteConfig=proposed;writeJSON('site.json',siteConfig);startupIssue='';tell('Website settings saved. Restart the website to apply them.');break;}
    case 'restartSite':await restartSite();break;
    case 'openWww':{const e=await shell.openPath(www);if(e)throw new Error(e);break;}
    case 'openConfig':{const e=await shell.openPath(configDir);if(e)throw new Error(e);break;}
    case 'copyLog':clipboard.writeText(hostState.logs.join('\n'));tell('Website log copied.');break;
    case 'openDevTools':openSiteDevTools();break;
    case 'zoom':zoom(payload);break;
    case 'find':if(typeof payload.text==='string'&&payload.text.length<1000)activeWeb()?.findInPage(payload.text,{forward:payload.forward!==false,findNext:!!payload.findNext});break;
    case 'stopFind':activeWeb()?.stopFindInPage('clearSelection');break;
    case 'clearSiteData':await clearSiteData();break;
    default:throw new Error('Unknown command.');
  }
  emitState();return snapshot();
});

function configureSiteSession(){
  websiteSession=session.fromPartition('persist:website');
  websiteSession.webRequest.onBeforeSendHeaders((details,callback)=>{
    const headers={...details.requestHeaders};for(const key of Object.keys(headers))if(key.toLowerCase()===ACCESS_HEADER)delete headers[key];
    let local=false;try{const url=new URL(details.url);if(url.protocol==='ws:')url.protocol='http:';else if(url.protocol==='wss:')url.protocol='https:';local=allowedNavigation(url.href,hostState.url);}catch{}
    if(local)headers[ACCESS_HEADER]=accessToken;callback({requestHeaders:headers});
  });
  websiteSession.webRequest.onBeforeRequest({urls:['<all_urls>']},(details,callback)=>{
    // Only top-level browsing is restricted; external page assets, frames and APIs remain available.
    // Electron's own DevTools frontend inherits this session. Its native
    // `remote` WebContents may load only the bundled frontend; website views
    // cannot claim that native type or navigate to privileged schemes.
    if(details.resourceType==='mainFrame'&&!allowedNavigation(details.url,hostState.url)&&!isBuiltInDevToolsRequest(details)){callback({cancel:true});return;}
    callback({});
  });
  let permissionData={};
  try{
    permissionData=JSON.parse(fs.readFileSync(path.join(configDir,'permissions.json'),'utf8'));
    if(!permissionData||permissionData.version!==1||typeof permissionData.origins!=='object'||Array.isArray(permissionData.origins))throw new Error('Invalid permission settings');
  }catch(error){if(error.code!=='ENOENT')tell('Saved website permissions could not be read. Access will be requested again.');}
  permissions=new PermissionManager({data:permissionData,persist:data=>writeJSON('permissions.json',data),onChange:permissionChanged});
  websiteSession.setPermissionCheckHandler((wc,permission,requestingOrigin,details={})=>{
    if(quitting||!allowedNavigation(requestingOrigin,hostState.url)
      ||[details.requestingUrl,details.securityOrigin,details.embeddingOrigin].filter(Boolean).some(value=>!allowedNavigation(value,hostState.url)))return false;
    const origin=originOf(requestingOrigin);
    // Chromium may query notification grants without a WebContents. Only a
    // previously granted local-origin notification may pass this narrow case.
    if(!wc)return permission==='notifications'&&permissions.check(origin,permission,details);
    const tab=tabs.find(tab=>tab.view?.webContents===wc);
    if(!tab||wc.isDestroyed()||!allowedNavigation(wc.getURL(),hostState.url))return false;
    return permissions.check(origin,permission,details,permissionContext(tab));
  });
  websiteSession.setPermissionRequestHandler((wc,permission,callback,details={})=>{
    if(quitting||!wc||wc.isDestroyed()){callback(false);return;}
    const requesting=details.requestingUrl||details.securityOrigin||details.requestingOrigin||(details.isMainFrame===true?wc.getURL():'');
    const tab=tabs.find(tab=>tab.view?.webContents===wc);
    if(!tab||!allowedNavigation(wc.getURL(),hostState.url)||!allowedNavigation(requesting,hostState.url)
      ||[details.securityOrigin,details.requestingOrigin].filter(Boolean).some(origin=>!allowedNavigation(origin,hostState.url))){callback(false);return;}
    const origin=originOf(requesting),context=permissionContext(tab);
    let frame;
    try{frame=details.isMainFrame===true?wc.mainFrame:wc.mainFrame.framesInSubtree.find(frame=>frame.url===requesting);}catch{}
    if(!frame){callback(false);return;}
    const valid=()=>{
      try{return !quitting&&tabs.includes(tab)&&!wc.isDestroyed()&&tab.permissionDocument===context.documentId
        &&allowedNavigation(wc.getURL(),hostState.url)&&allowedNavigation(frame.url,hostState.url)&&!frame.detached;}
      catch{return false;}
    };
    let pending=false;
    const id=permissions.request({origin,permission,details,...context,valid},allowed=>{
      // Clipboard and pointer-lock APIs must regain the requesting document's
      // focus before Chromium resolves the allowed request.
      if(pending&&allowed&&valid()){
        if(overlayKind==='permission')closeOverlay(false,false);
        activeTabId=tab.id;lastSiteTabId=tab.id;relayout();wc.focus();
      }
      callback(allowed);
    });
    pending=!!id;
  });
  websiteSession.on('will-download',async(event,item)=>{
    item.pause();const result=await dialog.showSaveDialog(win,{title:'Save website download',defaultPath:path.join(app.getPath('downloads'),path.basename(item.getFilename()))});
    if(result.canceled||!result.filePath)item.cancel();else{item.setSavePath(result.filePath);item.resume();}
  });
}
function initialBounds(){
  let bounds={width:976,height:722};const saved=settings.window;
  if(settings.restoreWindow&&saved&&Number.isFinite(saved.width)&&Number.isFinite(saved.height)){
    const display=screen.getDisplayMatching({x:Number(saved.x)||0,y:Number(saved.y)||0,width:Math.max(680,saved.width),height:Math.max(540,saved.height)}).workArea;
    bounds={width:Math.min(Math.max(680,saved.width),display.width),height:Math.min(Math.max(540,saved.height),display.height),x:Math.max(display.x,Math.min(Number(saved.x)||display.x,display.x+display.width-Math.min(Math.max(680,saved.width),display.width))),y:Math.max(display.y,Math.min(Number(saved.y)||display.y,display.y+display.height-Math.min(Math.max(540,saved.height),display.height)))};
  }return bounds;
}
async function boot(){
  await fsp.mkdir(www,{recursive:true});
  await seedDefaultWebsite({www,source:path.join(__dirname,'default-www'),siteConfig:path.join(configDir,'site.json')});
  settings={...settings,...readJSON('settings.json',{})};siteConfig={...siteConfig,...readJSON('site.json',{})};
  if(typeof settings.profileName!=='string'||!settings.profileName.trim()||settings.profileName.trim().length>64||/[\u0000-\u001f\u007f-\u009f]/.test(settings.profileName))settings.profileName='Your Pseudo-Chrome';else settings.profileName=settings.profileName.trim();
  settings.allowExternalPrograms=settings.allowExternalPrograms===true;
  if(!PROFILE_AVATARS.has(settings.profileAvatar))settings.profileAvatar='default';
  if(!['system','light','dark'].includes(settings.theme))settings.theme='system';nativeTheme.themeSource=settings.theme;
  Menu.setApplicationMenu(null);app.setAppUserModelId('local.PseudoChrome');
  const bg=actualTheme()==='dark'?'#1f2020':'#d3e3fd';
  splash=new BrowserWindow({width:693,height:349,useContentSize:true,show:false,frame:false,resizable:false,maximizable:false,backgroundColor:actualTheme()==='dark'?'#1f1f1f':'#ffffff',icon:path.join(assets,'icon.png'),webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true}});
  splash.once('ready-to-show',()=>splash&&!splash.isDestroyed()&&splash.show());
  splash.webContents.setWindowOpenHandler(()=>({action:'deny'}));splash.webContents.on('will-navigate',e=>e.preventDefault());
  await splash.loadFile(path.join(__dirname,'ui','splash.html'));
  win=new BrowserWindow({...initialBounds(),minWidth:680,minHeight:540,show:false,frame:false,backgroundColor:bg,icon:path.join(assets,'icon.png'),title:'Pseudo-Chrome',webPreferences:{preload,nodeIntegration:false,contextIsolation:true,sandbox:true,spellcheck:false}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'}));win.webContents.on('will-navigate',e=>e.preventDefault());wireShortcuts(win.webContents);
  for(const ev of ['resize','maximize','unmaximize','enter-full-screen','leave-full-screen'])win.on(ev,relayout);
  win.on('close',()=>{if(settings.restoreWindow){settings.window={...win.getNormalBounds(),maximized:win.isMaximized()};try{writeJSON('settings.json',settings);}catch{}}});
  win.on('closed',()=>{win=null;app.quit();});
  configureSiteSession();internal('welcome');
  await win.loadFile(path.join(__dirname,'ui','index.html'));
  // A transparent trusted view keeps dropdowns inside the native window while
  // the website remains visible and running underneath. It never loads a site.
  popupView=new WebContentsView({webPreferences:{preload,partition:'pseudo-popup-ui',nodeIntegration:false,contextIsolation:true,sandbox:true,spellcheck:false}});
  configurePreviewSession();
  popupView.setBackgroundColor('#00000000');popupView.setVisible(false);win.contentView.addChildView(popupView);
  popupView.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  popupView.webContents.on('will-navigate',e=>e.preventDefault());
  popupView.webContents.on('render-process-gone',()=>{stopMediaPreview();permissions?.cancelWhere(()=>true);closeOverlay();tell('The menu stopped. Restart Pseudo-Chrome to restore it.');});
  wireShortcuts(popupView.webContents);
  win.on('blur',()=>closeOverlay(false));
  await popupView.webContents.loadFile(path.join(__dirname,'ui','index.html'),{query:{overlay:'1'}});
  relayout();
  try{
    host=new SiteHost({www,configDir,runtimes:runtimePaths(),accessPolicy:{allowExternalPrograms:settings.allowExternalPrograms,token:accessToken}});
    host.on('status',value=>{if(value&&typeof value==='object')hostState={...hostState,...value,logs:hostState.logs};emitState();});
    host.on('log',line=>{hostState.logs.push(String(line));if(hostState.logs.length>500)hostState.logs.splice(0,hostState.logs.length-500);emitState();});
    await restartSite();
  }catch(e){hostState={...hostState,status:'error',message:'Website needs attention',error:e.message};}
  if(quitting)return;
  if(splash&&!splash.isDestroyed()){splash.destroy();splash=null;}
  if(settings.restoreWindow&&settings.window?.maximized)win.maximize();win.show();relayout();sendState();
  watcher=fs.watch(www,()=>{if(hostState.status==='empty'&&!startPromise){clearTimeout(watcher.debounce);watcher.debounce=setTimeout(()=>restartSite().catch(e=>tell(e.message)),1200);}});
  nativeTheme.on('updated',()=>{win?.setBackgroundColor(actualTheme()==='dark'?'#1f2020':'#d3e3fd');emitState();});
}
if(process.env.PSEUDO_CHROME_TEST!=='1'&&!app.requestSingleInstanceLock())app.quit();else{
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.whenReady().then(boot).catch(e=>{dialog.showErrorBox('Pseudo-Chrome could not start',e.stack||e.message);app.quit();});
}
app.on('window-all-closed',()=>app.quit());
app.on('before-quit',event=>{
  if(stopping)return;event.preventDefault();if(quitting)return;quitting=true;
  stopMediaPreview();permissions?.close();
  clearTimeout(stateTimer);clearTimeout(noticeTimer);if(watcher){clearTimeout(watcher.debounce);watcher.close();}
  Promise.resolve(host?.stop()).catch(()=>{}).then(()=>Promise.resolve(startPromise).catch(()=>{})).then(()=>host?.stop()).catch(()=>{}).finally(()=>{stopping=true;if(popupView&&!popupView.webContents.isDestroyed())popupView.webContents.close();for(const t of [...tabs]){const wc=t.view?.webContents;if(wc&&!wc.isDestroyed())wc.close();}app.quit();});
});
