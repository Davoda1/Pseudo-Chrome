'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {PermissionManager,permissionKeys,cleanData}=require('../app/lib/permissions.cjs');
const origin='http://127.0.0.1:43881';
function setup(options={}){
  const saves=[],changes=[],answers=[];
  const manager=new PermissionManager({persist:data=>saves.push(JSON.parse(JSON.stringify(data))),onChange:prompt=>changes.push(prompt),...options});
  const request=(permission='notifications',extra={})=>manager.request({origin,permission,tabId:'1',documentId:1,valid:()=>true,...extra},answer=>answers.push(answer));
  return {manager,saves,changes,answers,request};
}

test('unknown permission types and unknown media types are denied without a prompt',()=>{
  const s=setup();s.request('display-capture');s.request('openExternal');s.request('media',{details:{mediaTypes:['screen']}});
  assert.deepEqual(s.answers,[false,false,false]);assert.equal(s.manager.prompt,null);
  assert.equal(s.manager.check(origin,'media',{mediaType:'unknown'}),false);
  assert.deepEqual(permissionKeys('media',{mediaTypes:['audio','audio','video']}),['microphone','camera']);
});
test('default sanitized write/fullscreen grants do not persist or prompt',()=>{
  const s=setup();s.request('clipboard-sanitized-write');s.request('fullscreen');
  assert.deepEqual(s.answers,[true,true]);assert.equal(s.saves.length,0);assert.equal(s.manager.prompt,null);
});
test('persistent permission decisions are scoped to exact origin, port and capability',()=>{
  const s=setup();const id=s.request();assert.equal(s.manager.prompt.host,'127.0.0.1:43881');
  assert.equal(s.manager.respond(id,'allow'),true);assert.deepEqual(s.answers,[true]);
  const restored=new PermissionManager({data:s.saves.at(-1)});
  assert.equal(restored.check(origin,'notifications'),true);
  assert.equal(restored.check('http://127.0.0.1:43882','notifications'),false);
  assert.equal(restored.check('https://127.0.0.1:43881','notifications'),false);
  assert.equal(restored.check(origin,'clipboard-read'),false);
});
test('combined media requests grant only requested devices',()=>{
  const s=setup();const id=s.request('media',{details:{mediaTypes:['audio']}});
  assert.equal(s.manager.prompt.layout,'media');assert.deepEqual(s.manager.prompt.items.map(x=>x.key),['microphone']);
  s.manager.respond(id,'allow-session');
  assert.equal(s.manager.check(origin,'media',{mediaType:'audio'}),true);
  assert.equal(s.manager.check(origin,'media',{mediaType:'video'}),false);
  assert.equal(s.manager.check(origin,'media',{}),false);
});
test('one-time grants belong to one document and expire on navigation',()=>{
  const s=setup();s.manager.respond(s.request('media',{details:{mediaTypes:['video']}}),'allow-once');
  assert.equal(s.manager.check(origin,'media',{mediaType:'video'},{tabId:'1',documentId:1}),true);
  assert.equal(s.manager.check(origin,'media',{mediaType:'video'},{tabId:'2',documentId:1}),false);
  assert.equal(s.manager.check(origin,'media',{mediaType:'video'},{tabId:'1',documentId:2}),false);
  s.manager.forgetDocument('1');assert.equal(s.manager.check(origin,'media',{mediaType:'video'},{tabId:'1',documentId:1}),false);
  assert.ok(s.saves.every(data=>Object.keys(data.origins).length===0));
});
test('visit grant survives document navigation, ends with visit, and is never persisted',()=>{
  const s=setup();s.manager.respond(s.request('media',{details:{mediaTypes:['audio','video']}}),'allow-session');
  s.manager.forgetDocument('1');assert.equal(s.manager.check(origin,'media',{}),true);
  assert.equal(new PermissionManager({data:s.manager.data}).check(origin,'media',{}),false);
  s.manager.endVisit(origin);assert.equal(s.manager.check(origin,'media',{}),false);assert.ok(s.saves.every(data=>Object.keys(data.origins).length===0));
});
test('block persists and never opens another prompt until reset',()=>{
  const s=setup();s.manager.respond(s.request('media',{details:{mediaTypes:['audio']}}),'block');
  s.request('media',{details:{mediaTypes:['audio','video']}});
  assert.deepEqual(s.answers,[false,false]);assert.equal(s.manager.prompt,null);
  const restored=new PermissionManager({data:s.saves.at(-1)});assert.equal(restored.state(origin,'microphone').state,'block');
  s.manager.reset(origin);s.request('media',{details:{mediaTypes:['audio']}});assert.equal(s.manager.prompt.permission,'media');
});
test('dismissal does not save a block and every callback runs once',()=>{
  const s=setup();const id=s.request('clipboard-read');s.manager.respond(id,'dismiss');s.manager.respond(id,'allow');
  assert.deepEqual(s.answers,[false]);assert.ok(s.saves.every(data=>Object.keys(data.origins).length===0));assert.equal(s.manager.state(origin,'clipboard-read').state,'ask');
  assert.notEqual(s.request('clipboard-read'),id);
});
test('queued requests are independent and stale response IDs never grant the next request',()=>{
  const s=setup();const first=s.request(),second=s.request('clipboard-read');
  s.manager.respond(first,'allow');assert.equal(s.manager.prompt.id,second);
  assert.equal(s.manager.respond(first,'allow'),false);assert.deepEqual(s.answers,[true]);
  s.manager.respond(second,'block');assert.deepEqual(s.answers,[true,false]);
});
test('closing a document cancels only its pending requests and advances queue',()=>{
  const s=setup();s.request();const next=s.request('clipboard-read',{tabId:'2'});
  s.manager.forgetDocument('1');assert.deepEqual(s.answers,[false]);assert.equal(s.manager.prompt.id,next);
  s.manager.respond(next,'allow');assert.deepEqual(s.answers,[false,true]);
});
test('navigated or destroyed requesting frames cannot receive delayed grants',()=>{
  const s=setup();let valid=true;const id=s.request('media',{details:{mediaTypes:['audio']},valid:()=>valid});
  valid=false;assert.equal(s.manager.respond(id,'allow'),false);assert.deepEqual(s.answers,[false]);assert.ok(s.saves.every(data=>Object.keys(data.origins).length===0));
});
test('revoking and resetting permissions remove visit and one-time overrides',()=>{
  const s=setup();s.manager.respond(s.request('media',{details:{mediaTypes:['audio']}}),'allow-session');
  s.manager.respond(s.request('media',{details:{mediaTypes:['video']}}),'allow-once');
  s.manager.set(origin,'microphone','block');assert.equal(s.manager.check(origin,'media',{mediaType:'audio'}),false);
  s.manager.set(origin,'microphone','ask');assert.equal(s.manager.state(origin,'microphone').state,'ask');
  s.manager.reset(origin);assert.ok(s.manager.list(origin,{tabId:'1',documentId:1}).every(x=>x.state==='ask'));
});
test('failed persistence never grants access or consumes the pending decision',()=>{
  const s=setup({persist:()=>{throw new Error('Disk full');}});const id=s.request();
  assert.throws(()=>s.manager.respond(id,'allow'),/Disk full/);assert.deepEqual(s.answers,[]);
  assert.equal(s.manager.prompt.id,id);assert.equal(s.manager.check(origin,'notifications'),false);
  s.manager.respond(id,'dismiss');assert.deepEqual(s.answers,[false]);
});
test('shutdown rejects all pending requests, clears temporary grants and prevents future grants',()=>{
  const s=setup();s.manager.respond(s.request('media',{details:{mediaTypes:['audio']}}),'allow-session');
  s.request();s.request('clipboard-read');s.manager.close();s.manager.close();s.request('notifications');
  assert.deepEqual(s.answers,[true,false,false,false]);assert.equal(s.manager.prompt,null);assert.equal(s.manager.check(origin,'media',{mediaType:'audio'}),false);
});
test('invalid persisted state is ignored rather than granting unsupported capabilities',()=>{
  const data=cleanData({version:1,origins:{[origin]:{notifications:'allow','clipboard-read':true,camera:'ask',openExternal:'allow'},'file:///tmp/demo':{microphone:'allow'},'https://demo.invalid/path':{camera:'allow'}}});
  assert.deepEqual(Object.keys(data.origins),[origin]);assert.deepEqual({...data.origins[origin]},{notifications:'allow'});
  assert.equal(new PermissionManager({data:{origins:{[origin]:{camera:'allow'}}}}).check(origin,'media',{}),false);
});
test('queue limit denies excess requests while preserving existing decisions',()=>{
  const s=setup({maxPending:1});const id=s.request();s.request('clipboard-read');
  assert.deepEqual(s.answers,[false]);assert.equal(s.manager.prompt.id,id);s.manager.respond(id,'allow');assert.deepEqual(s.answers,[false,true]);
});

test('site controls show only actual requested capabilities, never permission probes',()=>{
  const s=setup();
  for(const permission of ['media','notifications','geolocation','clipboard-read','persistent-storage','pointerLock','keyboardLock'])s.manager.check(origin,permission);
  assert.deepEqual(s.manager.list(origin),[]);
  const id=s.request('media',{details:{mediaTypes:['audio']}});
  assert.deepEqual(s.manager.list(origin).map(item=>item.key),['microphone']);
  s.manager.respond(id,'dismiss');
  const restored=new PermissionManager({data:s.saves.at(-1)});
  assert.deepEqual(restored.list(origin).map(item=>[item.key,item.state]),[['microphone','ask']]);
  assert.deepEqual(restored.list('http://127.0.0.1:43882'),[]);
  restored.reset(origin);assert.deepEqual(restored.list(origin).map(item=>item.key),['microphone']);
});
test('legacy saved choices become visible site-used capabilities without adding unused ones',()=>{
  const manager=new PermissionManager({data:{version:1,origins:{[origin]:{notifications:'allow'}},used:{[origin]:['clipboard-read','openExternal']}}});
  assert.deepEqual(manager.list(origin).map(item=>item.key),['notifications','clipboard-read']);
});
test('durable storage protection requires a site request and an explicit saved decision',()=>{
  const s=setup();assert.equal(s.manager.check(origin,'persistent-storage'),false);assert.deepEqual(s.manager.list(origin),[]);
  const id=s.request('persistent-storage');assert.deepEqual(s.answers,[]);assert.equal(s.manager.prompt.layout,'simple');
  assert.deepEqual(s.manager.list(origin).map(item=>item.key),['persistent-storage']);
  s.manager.respond(id,'allow');assert.deepEqual(s.answers,[true]);
  const restored=new PermissionManager({data:s.saves.at(-1)});assert.equal(restored.check(origin,'persistent-storage'),true);
  restored.reset(origin);assert.equal(restored.check(origin,'persistent-storage'),false);
});
