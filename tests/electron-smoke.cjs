'use strict';
const { electronEnvironment } = require('./helpers/electron-env.cjs');
// Optional desktop integration check. Requires Playwright and a prepared runtime tree.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const http=require('node:http');const net=require('node:net');
const project=path.resolve(__dirname,'..');
const executablePath=process.env.PSEUDO_CHROME_ELECTRON;
if(!executablePath)throw new Error('Set PSEUDO_CHROME_ELECTRON to the Electron or packaged Pseudo-Chrome executable.');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pseudo-chrome-integration-'));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function bounded(promise,message,timeout=20000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+message)),timeout);})]);}finally{clearTimeout(timer);}}
async function wait(fn,message,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const value=await bounded(Promise.resolve().then(fn),message,Math.max(1,end-Date.now()));if(value)return value;await delay(100);}throw new Error('Timed out: '+message);}
let application,main;
async function state(){return bounded(main.evaluate(()=>window.pseudoChrome.invoke('getState')),'application state');}
async function command(name,payload={}){return bounded(main.evaluate(({name,payload})=>window.pseudoChrome.invoke(name,payload),{name,payload}),'command '+name);}
async function siteEval(code){const s=await state();return bounded(application.evaluate(async({webContents},{base,code})=>{const w=webContents.getAllWebContents().find(w=>w.getURL().startsWith(base));if(!w)throw new Error('Website WebContents not found');return w.executeJavaScript(code,true);},{base:s.host.url,code}),'website script');}
async function closeApplication(){
 const closing=application;if(!closing)return;const child=closing.process();
 const exited=child.exitCode!==null||child.signalCode!==null?Promise.resolve({code:child.exitCode,signal:child.signalCode}):new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 try{await bounded(closing.close(),'application shutdown',15000);assert.deepEqual(await bounded(exited,'application process exit',5000),{code:0,signal:null},'Application must exit normally without a crash signal');}
 finally{application=null;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
}
async function launch(){
 const args=[];if(process.env.PSEUDO_CHROME_HEADLESS==='1')args.push('--no-sandbox','--ozone-platform=headless','--disable-gpu');
 if(process.env.PSEUDO_CHROME_TEST_SCALE)args.push('--force-device-scale-factor='+process.env.PSEUDO_CHROME_TEST_SCALE);
 if(process.env.PSEUDO_CHROME_PACKAGED!=='1')args.push(project);
 application=await electron.launch({executablePath,args,env:electronEnvironment({...process.env,PSEUDO_CHROME_PROFILE:profile,PSEUDO_CHROME_TEST:'1'}),timeout:60000});
 main=await wait(()=>application.windows().find(w=>w.url().endsWith('/ui/index.html')),'main window');
 await main.waitForFunction(()=>window.pseudoChrome);
 await wait(async()=>{const s=await state();if(s.host.status==='error')throw new Error(s.host.error);return s.host.status==='ready'&&s.tabs.some(t=>t.kind==='site'&&!t.loading);},'website ready');
}
(async()=>{
 const external=http.createServer((_req,res)=>{res.writeHead(200,{'Content-Type':'text/plain','Access-Control-Allow-Origin':'*'});res.end('External resource loaded');});
 await new Promise(r=>external.listen(0,'127.0.0.1',r));const externalURL='http://127.0.0.1:'+external.address().port+'/resource';
 try{
  fs.mkdirSync(path.join(profile,'www'));
  fs.writeFileSync(path.join(profile,'www','index.html'),'<!doctype html><meta charset="utf-8"><title>Integration home</title><h1>Website rendered</h1><a href="/next.html">Next page</a><script>localStorage.setItem("proof","saved")</script>');
  fs.writeFileSync(path.join(profile,'www','next.html'),'<!doctype html><title>Integration second</title><h1>Second page</h1>');
  fs.writeFileSync(path.join(profile,'www','server.cjs'),`const http=require('http'),fs=require('fs'),path=require('path');http.createServer((req,res)=>{if(req.url==='/submitted'){let body='';req.on('data',b=>body+=b);req.on('end',()=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Form result</title><h1>'+req.method+' '+body+'</h1>')});return;}const file=path.join(__dirname,req.url==='/'?'index.html':req.url.slice(1));fs.readFile(file,(err,bytes)=>{res.statusCode=err?404:200;res.setHeader('Content-Type','text/html');res.end(err?'Not found':bytes)});}).listen(Number(process.env.PORT),process.env.HOST);`);
  fs.writeFileSync(path.join(profile,'site.json'),JSON.stringify({mode:'node',entry:'server.cjs'}));
  await launch();const first=await state();const port=new URL(first.host.url).port;
  assert.match(await siteEval('document.body.innerText'),/Website rendered/);
  assert.deepEqual(await siteEval('({require:typeof require,api:typeof window.pseudoChrome})'),{require:'undefined',api:'undefined'});
  assert.equal(await siteEval(`fetch(${JSON.stringify(externalURL)}).then(r=>r.text())`),'External resource loaded');
  await command('navigate',{url:'/next.html'});await wait(async()=>{const s=await state();return s.tabs.find(t=>t.id===s.activeTabId)?.title==='Integration second';},'second page');
  assert.equal((await state()).tabs.find(t=>t.kind==='site').canGoBack,true);
  await command('back');await wait(async()=>await siteEval('document.title')==='Integration home','back navigation');
  await command('forward');await wait(async()=>await siteEval('document.title')==='Integration second','forward navigation');
  await command('newTab');await wait(async()=>(await state()).tabs.filter(t=>t.kind==='site').length===2,'second tab');
  await command('closeTab',{id:(await state()).activeTabId});assert.equal((await state()).tabs.filter(t=>t.kind==='site').length,1);
  await siteEval(`document.body.insertAdjacentHTML('beforeend','<form id="post-check" method="POST" target="_blank" action="/submitted"><input name="message" value="hello"></form>');document.querySelector('#post-check').submit();undefined`);
  await wait(async()=>{const s=await state();return s.tabs.some(t=>t.url.endsWith('/submitted')&&!t.loading);},'POST result in new tab');
  assert.match(await application.evaluate(async({webContents})=>webContents.getAllWebContents().find(w=>w.getURL().endsWith('/submitted')).executeJavaScript('document.body.innerText')),/POST message=hello/);
  await command('closeTab',{id:(await state()).activeTabId});
  await siteEval(`(()=>{const child=window.open('about:blank');child.document.write('<!doctype html><title>Popup test</title><h1>Popup content</h1>');child.document.close();})();undefined`);
  await wait(async()=>(await state()).tabs.some(t=>t.url==='about:blank'),'local blank popup');
  assert.match(await bounded(application.evaluate(async({webContents})=>webContents.getAllWebContents().find(w=>w.getURL()==='about:blank').executeJavaScript('document.body.innerText')),'blank popup content'),/Popup content/);
  await bounded(application.evaluate(async({webContents})=>webContents.getAllWebContents().find(w=>w.getURL()==='about:blank').executeJavaScript('setTimeout(()=>window.close(),50);undefined')),'popup self-close request');
  await wait(async()=>{const s=await state();return !s.tabs.some(t=>t.url==='about:blank')&&s.tabs.filter(t=>t.kind==='site').length===1;},'self-closed popup removed from tabs');
  const openerId=(await state()).tabs.find(t=>t.kind==='site').id;
  await siteEval(`window.open('/','surviving-popup');undefined`);
  await wait(async()=>{const s=await state();return s.tabs.filter(t=>t.kind==='site').length===2&&s.tabs.find(t=>t.id===s.activeTabId)?.loading===false;},'child tab ready');
  const childId=(await state()).activeTabId;assert.notEqual(childId,openerId);
  await command('closeTab',{id:openerId});
  await wait(async()=>{const s=await state();return s.tabs.filter(t=>t.kind==='site').length===1&&s.tabs.some(t=>t.id===childId);},'child tab survives closing opener');
  assert.match(await siteEval('document.body.innerText'),/Website rendered/);
  await assert.rejects(command('navigate',{url:externalURL}));
  await siteEval(`location.href=${JSON.stringify(externalURL)};undefined`);await delay(200);assert.equal(new URL(await siteEval('location.href')).port,port);
  await command('navigate',{url:'pseudo://settings/website'});await wait(()=>main.locator('#site-form').isVisible(),'settings website section');
  await command('saveSettings',{theme:'dark'});assert.equal((await state()).theme,'dark');
  await command('saveSettings',{profileName:'  My demo & studio  '});assert.equal((await state()).settings.profileName,'My demo & studio');
  for(const profileName of ['', '   ', 'x'.repeat(65), 'name\nline', 123])await assert.rejects(command('saveSettings',{profileName}));
  await command('saveSettings',{profileAvatar:'spaceship'});assert.equal((await state()).settings.profileAvatar,'spaceship');
  await assert.rejects(command('saveSettings',{profileAvatar:'../private.png'}));
  await wait(()=>main.locator('#profile img').evaluate(el=>el.complete&&el.naturalWidth>0),'selected profile image loaded');
  assert.equal(await main.locator('input[name=profileAvatar][value=spaceship]').isChecked(),true);
  await command('zoom',{delta:.1});assert.equal((await state()).lastSiteZoom,1.1);
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/ui/index.html')).setSize(680,540));
  await delay(100);assert.equal(await main.evaluate(()=>document.documentElement.scrollWidth<=innerWidth&&document.documentElement.scrollHeight<=innerHeight),true);
  if(process.env.PSEUDO_CHROME_SCREENSHOTS){fs.mkdirSync(process.env.PSEUDO_CHROME_SCREENSHOTS,{recursive:true});await main.screenshot({path:path.join(process.env.PSEUDO_CHROME_SCREENSHOTS,'settings-dark-minimum.png')});}
  await closeApplication();
  await wait(()=>new Promise(resolve=>{const s=net.connect(Number(port),'127.0.0.1');s.once('error',()=>resolve(true));s.once('connect',()=>{s.destroy();resolve(false);});}),'server stopped');
  await launch();assert.equal((await state()).settings.profileName,'My demo & studio');assert.equal((await state()).theme,'dark');assert.equal((await state()).settings.profileAvatar,'spaceship');assert.equal(new URL((await state()).host.url).port,port);assert.equal(await siteEval('localStorage.getItem("proof")'),'saved');
  await closeApplication();
  console.log(JSON.stringify({result:'passed',checks:['website rendering','website isolation','external resources','local navigation history','tabs','POST forms in new tabs','local script popups','script popup cleanup','child tabs survive opener closure','external navigation blocked','settings','theme','profile image rendering and persistence','profile image enum validation','profile name validation','profile name persistence','zoom','minimum window layout','process cleanup','clean application exits','stable origin and storage'],profile}));
 }finally{try{if(application)await closeApplication();}finally{external.closeAllConnections();await bounded(new Promise(r=>external.close(r)),'test resource server shutdown',5000);fs.rmSync(profile,{recursive:true,force:true});}}
})().catch(e=>{console.error(e);process.exitCode=1;});
