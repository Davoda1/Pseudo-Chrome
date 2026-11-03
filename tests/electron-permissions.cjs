'use strict';
const { electronEnvironment } = require('./helpers/electron-env.cjs');
// Real Electron permission callbacks and trusted in-window controls. Media uses
// Chromium's fake devices; this suite never captures the machine's hardware.
const {_electron:electron}=require('playwright');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const project=path.resolve(__dirname,'..');
const executablePath=process.env.PSEUDO_CHROME_ELECTRON;
if(!executablePath)throw new Error('Set PSEUDO_CHROME_ELECTRON to Electron or packaged Pseudo-Chrome.');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'pseudo-chrome-permissions-'));
const checks=[];let application,main,foreignServer;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
// Values cross executeJavaScript's source-only API as complete literals. Also
// escape HTML delimiters and JavaScript line separators, not just JSON quotes.
const codeLiteral=value=>JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,character=>'\\u'+character.charCodeAt(0).toString(16).padStart(4,'0'));
async function bounded(promise,message,timeout=20000){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+message)),timeout);})]);}finally{clearTimeout(timer);}}
async function wait(fn,message,timeout=20000){const end=Date.now()+timeout;while(Date.now()<end){const result=await bounded(Promise.resolve().then(fn),message,Math.max(1,end-Date.now()));if(result)return result;await delay(70);}throw new Error('Timed out: '+message);}
async function state(){return bounded(main.evaluate(()=>window.pseudoChrome.invoke('getState')),'state');}
async function command(name,payload={}){return bounded(main.evaluate(({name,payload})=>window.pseudoChrome.invoke(name,payload),{name,payload}),'command '+name);}
async function overlay(code){return bounded(application.evaluate(async({webContents},code)=>{const wc=webContents.getAllWebContents().find(w=>w.getURL().includes('/ui/index.html?overlay=1'));return wc.executeJavaScript(code,true);},code),'overlay script');}
async function activeSiteId(){return application.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/ui/index.html'));return win.contentView.children.find(view=>view.getVisible()&&/^https?:/.test(view.webContents?.getURL()||''))?.webContents.id;});}
async function siteById(id,code){return bounded(application.evaluate(async({webContents},{id,code})=>{const wc=webContents.fromId(id);if(!wc)throw new Error('Website missing');return wc.executeJavaScript(code,true);},{id,code}),'website script');}
async function site(code){const current=await state();assert.equal(current.tabs.find(t=>t.id===current.activeTabId)?.kind,'site');return siteById(await activeSiteId(),code);}
async function focusSite(){const id=await activeSiteId();await application.evaluate(({webContents},id)=>webContents.fromId(id)?.focus(),id);}
async function nativeKey(keyCode,modifiers=[]){await application.evaluate(({webContents},{keyCode,modifiers})=>{const wc=webContents.getAllWebContents().find(w=>w.getURL().includes('/ui/index.html?overlay=1'));wc.sendInputEvent({type:'keyDown',keyCode,modifiers});wc.sendInputEvent({type:'keyUp',keyCode,modifiers});},{keyCode,modifiers});}
async function click(selector){await overlay(`(()=>{const el=document.querySelector(${codeLiteral(selector)});if(!el||el.hidden)throw new Error('Missing visible '+${codeLiteral(selector)});el.click();})();undefined`);}
async function closePopup(){await command('setOverlay',{open:false});await wait(async()=>!(await state()).overlayKind,'closed popup');}
async function prompt(permission){return wait(async()=>{const s=await state();return s.permissionPrompt?.permission===permission&&s.overlayKind==='permission'&&s.permissionPrompt;},'permission prompt '+permission);}
async function noPrompt(){await wait(async()=>!(await state()).permissionPrompt&&!(await state()).overlayKind,'no permission prompt');}
async function ask(expression){await focusSite();await site(`(()=>{window.permissionResult='pending';Promise.resolve().then(()=>(${expression})).then(value=>{window.permissionResult=value;},error=>{window.permissionResult=error.name;});})();undefined`);}
async function result(expected){await wait(async()=>(await site('window.permissionResult'))===expected,'permission result '+expected);}
const audio='navigator.mediaDevices.getUserMedia({audio:true}).then(stream=>{window.permissionStream=stream;return stream.getTracks().map(t=>t.kind).sort().join(",");})';
const both='navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(stream=>{window.permissionStream=stream;return stream.getTracks().map(t=>t.kind).sort().join(",");})';
async function stopMedia(){await site('window.permissionStream?.getTracks().forEach(track=>track.stop());undefined');}
async function queueMediaAndClipboard(){await focusSite();const id=await activeSiteId();await site('(()=>{window.first="pending";window.second="pending";navigator.mediaDevices.getUserMedia({audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());window.first="audio-granted";},e=>window.first=e.name);navigator.clipboard.readText().then(()=>window.second="clipboard-granted",e=>window.second=e.name);})();undefined');await wait(async()=>!!(await state()).permissionPrompt,'first queued request');await delay(150);assert.deepEqual(await siteById(id,'[window.first,window.second]'),['pending','pending']);return id;}
async function navigate(url){const id=await activeSiteId();if(id)await wait(()=>application.evaluate(({webContents},id)=>{const wc=webContents.fromId(id);return !wc||wc.isDestroyed()||!wc.isLoading();},id),'earlier reload completed');await command('navigate',{url});await wait(async()=>{const s=await state();const t=s.tabs.find(t=>t.id===s.activeTabId);return t.kind==='site'&&!t.loading;},'page navigation');await site('document.readyState');}
async function resize(width,height){await application.evaluate(({BrowserWindow},{width,height})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/ui/index.html')).setSize(width,height),{width,height});await wait(()=>main.evaluate(({width,height})=>innerWidth===width&&innerHeight===height,{width,height}),'window resized');await wait(()=>overlay(`innerWidth===${width}&&innerHeight===${height}`),'overlay resized');}
async function contained(selector){await overlay('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))))');const b=await overlay(`(()=>{const el=document.querySelector(${codeLiteral(selector)}),r=el.getBoundingClientRect();return {hidden:el.hidden,left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight};})()`);assert.equal(b.hidden,false);assert.ok(b.left>=0&&b.top>=0&&b.right<=b.width+.5&&b.bottom<=b.height+.5,JSON.stringify(b));assert.ok(b.documentWidth<=b.width&&b.documentHeight<=b.height,JSON.stringify(b));}
async function capture(name){const destination=process.env.PSEUDO_CHROME_TEST_SCREENSHOTS;if(!destination)return;fs.mkdirSync(destination,{recursive:true});const bytes=await application.evaluate(async({webContents})=>Array.from((await webContents.getAllWebContents().find(w=>w.getURL().includes('/ui/index.html?overlay=1')).capturePage()).toPNG()));fs.writeFileSync(path.join(destination,name+'.png'),Buffer.from(bytes));}
function syntheticAudio(){const rate=48000,samples=rate*3,data=Buffer.alloc(44+samples*2);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(rate,24);data.writeUInt32LE(rate*2,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(samples*2,40);for(let n=0;n<samples;n++)data.writeInt16LE(Math.round(Math.sin(n*2*Math.PI*440/rate)*12000),44+n*2);const filename=path.join(profile,'synthetic-microphone.wav');fs.writeFileSync(filename,data);return filename;}
async function installPreviewProbe(){await overlay(`(()=>{window.__previewTracks=[];window.__previewCalls=0;const original=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async constraints=>{window.__previewCalls++;if(window.__rejectNextPreview){window.__rejectNextPreview=false;throw new DOMException('Synthetic preview device error','NotReadableError');}const stream=await original(constraints);window.__previewTracks.push(...stream.getTracks());if(window.__holdPreviewResolution){window.__holdPreviewResolution=false;await new Promise(resolve=>{window.__releasePreviewResolution=resolve;});}return stream;};})();undefined`);}
async function previewMetrics(){return overlay(`(()=>{const panel=document.querySelector('#permission-preview'),video=document.querySelector('#media-preview-video'),fill=document.querySelector('#media-preview-level-fill');return {state:panel?.dataset.previewState,calls:window.__previewCalls,tracks:window.__previewTracks.map(t=>({kind:t.kind,state:t.readyState})),videoWidth:video?.videoWidth||0,videoHeight:video?.videoHeight||0,time:video?.currentTime||0,muted:!!video?.muted,level:fill?parseFloat(fill.style.width)||0:0};})()`);}
async function previewActive({video=false,audio=true}={}){assert.equal(await overlay('document.querySelector("#media-preview-start")'),null);assert.equal(await overlay('Array.from(document.querySelectorAll("#permission-preview button")).some(button=>/start|stop/i.test(button.textContent))'),false);await wait(async()=>{const m=await previewMetrics();return m.state==='active'&&(!video||m.videoWidth>0&&m.videoHeight>0&&m.muted)&&(!audio||m.tracks.some(t=>t.kind==='audio'&&t.state==='live'));},'live preview');if(video){const start=(await previewMetrics()).time;await wait(async()=>(await previewMetrics()).time>start+.05,'actual camera frames advance');}if(audio)await wait(async()=>(await previewMetrics()).level>0,'microphone meter measures synthetic audio');}
async function previewStopped(){await wait(async()=>{const m=await previewMetrics();return m.tracks.every(t=>t.state==='ended')&&!(await state()).permissionPrompt?.mediaPreviewAllowed;},'all preview tracks and lease stopped');}
async function launch(){const args=['--use-fake-device-for-media-stream','--use-file-for-fake-audio-capture='+syntheticAudio()];if(process.env.PSEUDO_CHROME_HEADLESS==='1')args.push('--no-sandbox','--ozone-platform=headless','--disable-gpu');if(process.env.PSEUDO_CHROME_TEST_SCALE)args.push('--force-device-scale-factor='+process.env.PSEUDO_CHROME_TEST_SCALE);if(process.env.PSEUDO_CHROME_PACKAGED!=='1')args.push(project);application=await electron.launch({executablePath,args,env:electronEnvironment({...process.env,PSEUDO_CHROME_PROFILE:profile,PSEUDO_CHROME_TEST:'1'}),timeout:60000});main=await wait(()=>application.windows().find(w=>w.url().endsWith('/ui/index.html')),'main window');await main.waitForFunction(()=>window.pseudoChrome);await wait(async()=>{const s=await state();if(s.host.status==='error')throw new Error(s.host.error);return s.host.status==='ready'&&s.tabs.some(t=>t.kind==='site'&&!t.loading);},'website ready');await installPreviewProbe();}
async function shutdown(){if(!application)return;const closing=application,child=closing.process();const exited=child.exitCode!==null||child.signalCode!==null?Promise.resolve({code:child.exitCode,signal:child.signalCode}):new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));try{await bounded(closing.close(),'application shutdown',15000);assert.deepEqual(await bounded(exited,'normal process exit',5000),{code:0,signal:null});}finally{application=null;if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}}
function passed(label){checks.push(label);console.log('PASS '+label);}
(async()=>{try{
  fs.mkdirSync(path.join(profile,'www'));
  fs.writeFileSync(path.join(profile,'www','index.html'),'<!doctype html><title>Permission integration home</title><body><h1>Permission test</h1><script>window.permissionResult="idle";</script>');
  fs.writeFileSync(path.join(profile,'www','second.html'),'<!doctype html><title>Permission second page</title><h1>Second</h1>');
  fs.writeFileSync(path.join(profile,'www','frame.html'),'<!doctype html><title>External-origin frame</title><script>addEventListener("message",async event=>{if(event.data!=="ask")return;try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});stream.getTracks().forEach(t=>t.stop());parent.postMessage("frame:allowed","*");}catch(error){parent.postMessage("frame:"+error.name,"*");}});parent.postMessage("frame:ready","*");</script>');
  fs.writeFileSync(path.join(profile,'site.json'),JSON.stringify({mode:'static'}));
  await launch();
  const transportProbe='quotes " and \\ </script><script>throw new Error("must remain data")</script> & \u2028\u2029';
  assert.equal(await overlay(codeLiteral(transportProbe)),transportProbe);

  assert.deepEqual((await state()).siteInfo.permissions,[]);
  await site('Promise.all([navigator.permissions.query({name:"geolocation"}),navigator.permissions.query({name:"notifications"}),navigator.mediaDevices.enumerateDevices()]).then(()=>true)');
  assert.deepEqual((await state()).siteInfo.permissions,[]);passed('permission list is empty until the website actually requests access; status probes do not add entries');

  await ask('Notification.requestPermission()');await prompt('notifications');
  assert.deepEqual((await state()).siteInfo.permissions.map(p=>p.key),['notifications']);
  await wait(()=>overlay('!document.querySelector("#permission-panel").hidden'),'notification panel');
  assert.deepEqual(await application.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/ui/index.html')),children=win.contentView.children,popup=children.find(view=>view.webContents?.getURL().includes('?overlay=1')),site=children.find(view=>view.webContents?.getURL().startsWith('http:'));return {visible:popup.getVisible(),topmost:children.at(-1)===popup,websiteVisible:site.getVisible()};}),{visible:true,topmost:true,websiteVisible:true});
  assert.match(await overlay('document.querySelector("#permission-title").textContent'),/127\.0\.0\.1/);
  assert.match(await main.locator('#permission-chip-label').textContent(),/notification/i);
  for(const theme of ['dark','light']){await command('saveSettings',{theme});await resize(680,540);await contained('#permission-panel');assert.ok(await overlay('document.querySelector("#permission-panel").getBoundingClientRect().width<=308'));assert.equal(await overlay('document.documentElement.dataset.theme'),theme);await capture('notification-'+theme);}
  await click('#permission-allow');await result('granted');await noPrompt();passed('real notification request, permission chip, both themes and minimum-window containment');

  await main.locator('#site-info').click();await wait(()=>overlay('!document.querySelector("#site-panel").hidden'),'site panel');await contained('#site-panel');
  assert.match(await overlay('document.querySelector("#site-panel").innerText'),/local|computer/i);
  assert.doesNotMatch(await overlay('document.querySelector("#site-panel").innerText'),/connection is secure/i);
  assert.equal(await overlay('document.querySelector("#permission-setting-notifications").getAttribute("aria-checked")'),'true');
  for(const theme of ['dark','light']){await command('saveSettings',{theme});await contained('#site-panel');await capture('site-controls-'+theme);}
  await click('#permission-setting-notifications');await wait(async()=>(await state()).siteInfo.permissions.find(p=>p.key==='notifications')?.state==='block','notification block setting');
  await closePopup();await navigate('/second.html');await ask('Notification.requestPermission()');await result('denied');assert.equal((await state()).permissionPrompt,null);passed('address-bar site controls truthfully describe localhost and enforce permission switches');

  await command('resetSitePermissions');await navigate('/');await ask('navigator.clipboard.readText().then(()=>"read")');await prompt('clipboard-read');for(const theme of ['dark','light']){await command('saveSettings',{theme});await contained('#permission-panel');await capture('clipboard-'+theme);}await click('#permission-close');await result('NotAllowedError');await noPrompt();
  assert.equal((await state()).siteInfo.permissions.find(p=>p.key==='clipboard-read')?.state,'ask');
  await ask('navigator.clipboard.readText().then(()=>"read")');await prompt('clipboard-read');await click('#permission-block');await result('NotAllowedError');await noPrompt();passed('real clipboard prompt supports dismiss without remembering and persistent Block');

  await command('resetSitePermissions');await navigate('/');await application.evaluate(({clipboard})=>clipboard.writeText('Pseudo-Chrome permission integration'));
  await ask('navigator.clipboard.readText()');await prompt('clipboard-read');await click('#permission-allow');await result('Pseudo-Chrome permission integration');await noPrompt();passed('Allow completes a real clipboard read after restoring website focus');

  assert.equal((await previewMetrics()).calls,0);assert.equal((await previewMetrics()).tracks.length,0);
  await command('resetSitePermissions');await navigate('/');await ask(both);const mediaPrompt=await prompt('media');assert.deepEqual([...mediaPrompt.mediaTypes].sort(),['audio','video']);
  assert.match(await overlay('document.querySelector("#permission-items").innerText'),/camera/i);assert.match(await overlay('document.querySelector("#permission-items").innerText'),/microphone/i);
  await assert.rejects(()=>command('startMediaPreview',{id:mediaPrompt.id}));
  assert.equal(await overlay('window.pseudoChrome.invoke("startMediaPreview",{id:"stale-request"}).then(()=>"allowed",()=>"denied")'),'denied');
  assert.equal(await site('typeof window.pseudoChrome'),'undefined');
  await previewActive({video:true});
  assert.equal(await site('window.permissionResult'),'pending');assert.equal((await state()).permissionPrompt.mediaPreviewAllowed,true);
  const devices=await overlay('navigator.mediaDevices.enumerateDevices().then(devices=>devices.filter(d=>["audioinput","videoinput"].includes(d.kind)).map(d=>({id:d.deviceId,kind:d.kind,label:d.label})))');
  assert.ok(devices.some(d=>d.kind==='audioinput')&&devices.some(d=>d.kind==='videoinput'));
  for(const [selector,kind] of [['#media-preview-camera','videoinput'],['#media-preview-microphone','audioinput']]){
    const choices=await overlay(`Array.from(document.querySelector(${codeLiteral(selector)}).options).map(o=>({id:o.value,label:o.textContent}))`);
    assert.ok(choices.length>0);assert.ok(choices.every(choice=>devices.some(device=>device.kind===kind&&device.id===choice.id)),JSON.stringify({choices,devices}));
  }
  const priorTracks=(await previewMetrics()).tracks.length,priorCalls=(await previewMetrics()).calls;
  const selectedMicrophone=await overlay('(()=>{const select=document.querySelector("#media-preview-microphone"),next=Array.from(select.options).find(o=>o.value!==select.value);if(!next)return null;select.value=next.value;select.dispatchEvent(new Event("change",{bubbles:true}));return next.value;})()');
  assert.ok(selectedMicrophone,'Synthetic device inventory supplies more than one audio input');
  await wait(async()=>(await previewMetrics()).calls>priorCalls,'device switch opens a new preview stream');await previewActive({video:true});
  assert.equal(await overlay(`window.__previewTracks.slice(0,${priorTracks}).every(track=>track.readyState==='ended')`),true);
  assert.equal(await overlay('window.__previewTracks.findLast(track=>track.kind==="audio"&&track.readyState==="live").getSettings().deviceId'),selectedMicrophone);
  const callsBeforeThemes=(await previewMetrics()).calls;
  for(const theme of ['dark','light']){await command('saveSettings',{theme});await previewActive({video:true});await contained('#permission-panel');await capture('media-live-'+theme);}
  assert.equal((await previewMetrics()).calls,callsBeforeThemes,'Theme/state updates do not restart an active preview');
  await overlay('document.querySelector("#permission-never").scrollIntoView({block:"nearest"});undefined');
  assert.equal(await overlay('(()=>{const p=document.querySelector("#permission-panel").getBoundingClientRect(),b=document.querySelector("#permission-never").getBoundingClientRect();return b.top>=p.top&&b.bottom<=p.bottom;})()'),true);
  await contained('#permission-panel');await capture('media-live-actions');
  assert.equal(await site('window.permissionResult'),'pending');
  await click('#permission-allow-once');await result('audio,video');await previewStopped();await stopMedia();await noPrompt();passed('automatic live preview shows real synthetic video and audio levels without Start/Stop controls or granting website access; Allow ends preview tracks');

  await navigate('/second.html');await ask(audio);await prompt('media');await previewActive();
  assert.equal(await overlay('navigator.mediaDevices.getUserMedia({video:true}).then(stream=>{stream.getTracks().forEach(t=>t.stop());return "allowed";},()=>"denied")'),'denied');
  assert.equal(await site('window.permissionResult'),'pending');await nativeKey('Escape');await result('NotAllowedError');await noPrompt();await previewStopped();passed('microphone-only preview cannot access the camera; Escape stops tracks and denies only the pending request');

  await navigate('/');await ask(both);await prompt('media');await previewActive({video:true});await click('#permission-close');await result('NotAllowedError');await noPrompt();await previewStopped();passed('closing a live preview stops every track and leaves website permission ungranted');

  await overlay('window.__rejectNextPreview=true;undefined');await ask(audio);await prompt('media');
  await wait(async()=>(await previewMetrics()).state==='error','preview device error');const failedCalls=(await previewMetrics()).calls;
  assert.equal(await site('window.permissionResult'),'pending');
  await command('saveSettings',{theme:'dark'});await command('saveSettings',{theme:'light'});await delay(200);
  assert.equal((await previewMetrics()).calls,failedCalls,'Failed automatic preview must not repeatedly reacquire devices');
  await click('#permission-close');await result('NotAllowedError');await noPrompt();await previewStopped();
  await ask(audio);await prompt('media');await previewActive();
  assert.ok((await previewMetrics()).calls>failedCalls);assert.equal(await site('window.permissionResult'),'pending');
  passed('preview errors do not auto-retry; a new media request can start a fresh isolated automatic preview');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/ui/index.html')).emit('blur'));
  await result('NotAllowedError');await noPrompt();await previewStopped();
  await overlay('window.__holdPreviewResolution=true;undefined');await ask(audio);await prompt('media');
  await wait(()=>overlay('typeof window.__releasePreviewResolution==="function"'),'delayed preview stream acquired');
  const delayedCalls=(await previewMetrics()).calls;
  assert.equal((await previewMetrics()).state,'starting');assert.equal(await site('window.permissionResult'),'pending');
  await application.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('/ui/index.html')).emit('blur'));
  await result('NotAllowedError');await noPrompt();
  await overlay('window.__releasePreviewResolution();delete window.__releasePreviewResolution;undefined');await previewStopped();await delay(200);
  assert.equal((await previewMetrics()).calls,delayedCalls,'A delayed stream resolving after blur cannot restart preview');
  passed('window blur cancels automatic preview and stops even delayed acquisition without restarting or granting the website');

  await ask(audio);await prompt('media');await previewActive();await command('navigate',{url:'/second.html'});await noPrompt();await previewStopped();passed('navigation stops preview capture and revokes its trusted UI lease');

  await navigate('/second.html');await ask(audio);await prompt('media');await click('#permission-allow-session');await result('audio');await stopMedia();await noPrompt();
  await command('newTab');await wait(async()=>{const s=await state();return s.tabs.find(t=>t.id===s.activeTabId)?.loading===false;},'new tab ready');await ask(audio);await result('audio');await stopMedia();assert.equal((await state()).permissionPrompt,null);passed('one-time media grant ends on navigation; session grant works in another local tab');

  await main.locator('#site-info').click();await wait(()=>overlay('!document.querySelector("#site-panel").hidden'),'site permissions');await click('#reset-site-permissions');await wait(async()=>(await state()).siteInfo.permissions.every(p=>p.state==='ask'),'all site permissions reset');await closePopup();
  await navigate('/');await ask(audio);await prompt('media');await previewActive();await click('#permission-never');await result('NotAllowedError');await noPrompt();await previewStopped();passed('Reset permissions revokes grants and Never allow stops preview and blocks media');

  await shutdown();await launch();await ask(audio);await result('NotAllowedError');assert.equal((await state()).permissionPrompt,null);assert.equal((await state()).siteInfo.permissions.find(p=>p.key==='microphone')?.state,'block');passed('persistent denial survives a full application restart');
  await command('resetSitePermissions');await navigate('/');await ask(audio);await prompt('media');await click('#permission-allow-session');await result('audio');await stopMedia();await shutdown();await launch();await ask(audio);await prompt('media');await click('#permission-close');await result('NotAllowedError');await noPrompt();passed('session grants expire after application restart');

  await command('resetSitePermissions');await navigate('/');await ask(audio);await prompt('media');await command('navigate',{url:'/second.html'});await noPrompt();passed('navigation cancels pending media permission without retaining a grant');

  foreignServer=http.createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end(fs.readFileSync(path.join(profile,'www','frame.html')));});await new Promise(resolve=>foreignServer.listen(0,'127.0.0.1',resolve));
  const foreignURL='http://127.0.0.1:'+foreignServer.address().port+'/frame.html';
  await site(`(()=>{window.frameResult="pending";addEventListener("message",event=>{if(String(event.data).startsWith("frame:")){window.frameResult=event.data;if(event.data==="frame:ready")event.source.postMessage("ask","*");}});const iframe=document.createElement("iframe");iframe.allow="microphone *; camera *";iframe.src=${codeLiteral(foreignURL)};document.body.append(iframe);})();undefined`);
  await wait(async()=>/^frame:(NotAllowedError|SecurityError)$/.test(await site('window.frameResult')),'foreign-origin frame denied');assert.equal((await state()).permissionPrompt,null);passed('different-origin embedded frame cannot receive the local website permission grant');

  await command('resetSitePermissions');await navigate('/');const queuedId=await queueMediaAndClipboard();const firstPrompt=(await state()).permissionPrompt;
  await click(firstPrompt.layout==='media'?'#permission-allow-once':'#permission-allow');
  await wait(async()=>{const s=await state();return s.permissionPrompt&&s.permissionPrompt.id!==firstPrompt.id&&s.overlayKind==='permission';},'next queued prompt remains open');await delay(250);assert.equal((await state()).overlayKind,'permission');await contained('#permission-panel');await click('#permission-close');await noPrompt();
  await wait(async()=>{const values=await siteById(queuedId,'[window.first,window.second]');return values.filter(value=>/granted$/.test(value)).length===1&&values.filter(value=>value==='NotAllowedError').length===1;},'one queued grant and one dismissal');passed('granting a queued permission preserves the next prompt through focus changes');

  await command('resetSitePermissions');await navigate('/');const shortcutId=await queueMediaAndClipboard(),beforeShortcut=await state();await nativeKey('T',['control']);
  await wait(async()=>{const s=await state();return s.tabs.length===beforeShortcut.tabs.length+1&&s.activeTabId!==beforeShortcut.activeTabId&&!s.permissionPrompt&&!s.overlayKind;},'Ctrl+T cancels queue and opens a tab');
  await wait(async()=>(await siteById(shortcutId,'[window.first,window.second]')).every(value=>value==='NotAllowedError'),'shortcut denies both queued requests');await delay(250);assert.equal((await state()).permissionPrompt,null);assert.equal((await state()).overlayKind,null);passed('Ctrl+T cancels every queued request before activating the new tab');

  await command('resetSitePermissions');await navigate('/');await queueMediaAndClipboard();const id=(await state()).activeTabId;await command('closeTab',{id});await noPrompt();passed('closing a tab resolves pending and queued permission requests safely');

  await command('newTab');await wait(async()=>{const s=await state();return s.tabs.find(t=>t.id===s.activeTabId)?.loading===false;},'preview tab ready');await ask(audio);await prompt('media');await previewActive();const previewTab=(await state()).activeTabId;await command('closeTab',{id:previewTab});await noPrompt();await previewStopped();passed('closing a tab stops its live preview and revokes the UI lease');

  await command('newTab');await wait(async()=>{const s=await state();return s.tabs.find(t=>t.id===s.activeTabId)?.loading===false;},'final tab ready');await ask(audio);await prompt('media');await previewActive();await shutdown();passed('normal application shutdown cancels an unanswered request and active synthetic microphone preview');
  console.log(JSON.stringify({result:'passed',checks}));
}finally{try{if(application)await shutdown();}finally{if(foreignServer){foreignServer.closeAllConnections();await new Promise(resolve=>foreignServer.close(resolve));}fs.rmSync(profile,{recursive:true,force:true,maxRetries:20,retryDelay:100});}}})().catch(error=>{console.error(error);process.exitCode=1;});
