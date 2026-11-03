'use strict';

// The website never receives the trusted UI bridge. Permission callbacks stay
// here until the application UI makes a decision for that exact request.
const DEFINITIONS=Object.freeze({
  microphone:{label:'Microphone',icon:'microphone',requestLabel:'Use your microphone'},
  camera:{label:'Camera',icon:'camera',requestLabel:'Use your camera'},
  notifications:{label:'Notifications',icon:'notifications',requestLabel:'Show notifications'},
  geolocation:{label:'Location',icon:'location',requestLabel:'Know your location'},
  'clipboard-read':{label:'Clipboard',icon:'clipboard',requestLabel:'See text and images copied to the clipboard'},
  'persistent-storage':{label:'Persistent storage',icon:'storage',requestLabel:'Keep website data on this device'},
  pointerLock:{label:'Pointer lock',icon:'pointer',requestLabel:'Control your mouse pointer'},
  keyboardLock:{label:'Keyboard lock',icon:'keyboard',requestLabel:'Capture keyboard input'}
});
const DEFAULT_ALLOWED=new Set(['clipboard-sanitized-write','fullscreen']);
const STATES=new Set(['ask','allow','block']);
const DECISIONS=new Set(['allow-once','allow-session','allow','block','dismiss']);
function originOf(value){
  try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.origin:null;}catch{return null;}
}
function permissionKeys(permission,details={}){
  if(permission==='media'){
    const types=Array.isArray(details.mediaTypes)?details.mediaTypes:details.mediaType?[details.mediaType]:['audio','video'];
    // An unspecified media check must have both grants. Explicit unknown types
    // cannot accidentally gain camera/microphone access.
    if(!types.length)return ['microphone','camera'];
    if(types.some(type=>!['audio','video'].includes(type)))return [];
    return [...new Set(types.map(type=>type==='audio'?'microphone':'camera'))];
  }
  return Object.hasOwn(DEFINITIONS,permission)?[permission]:[];
}
function cleanData(value){
  const origins=Object.create(null);
  const used=Object.create(null);
  if(value&&value.version===1&&value.origins&&typeof value.origins==='object'&&!Array.isArray(value.origins)){
    for(const [origin,entries] of Object.entries(value.origins)){
      if(originOf(origin)!==origin||!entries||typeof entries!=='object'||Array.isArray(entries))continue;
      const result=Object.create(null);
      for(const key of Object.keys(DEFINITIONS))if(['allow','block'].includes(entries[key]))result[key]=entries[key];
      if(Object.keys(result).length)origins[origin]=result;
    }
  }
  if(value?.version===1&&value.used&&typeof value.used==='object'&&!Array.isArray(value.used)){
    for(const [origin,keys] of Object.entries(value.used))if(originOf(origin)===origin&&Array.isArray(keys)){
      const valid=[...new Set(keys.filter(key=>Object.hasOwn(DEFINITIONS,key)))];if(valid.length)used[origin]=valid;
    }
  }
  // Earlier versions only stored explicit choices; those were made for the site.
  for(const [origin,entries] of Object.entries(origins))used[origin]=[...new Set([...(used[origin]||[]),...Object.keys(entries)])];
  return {version:1,origins,used};
}
function documentKey(context){return context&&context.tabId!==undefined&&context.documentId!==undefined?String(context.tabId)+':'+String(context.documentId):null;}

class PermissionManager{
  constructor({data={},persist=()=>{},onChange=()=>{},maxPending=32}={}){
    this.data=cleanData(data);this.persist=persist;this.onChange=onChange;this.maxPending=maxPending;
    this.sessions=new Map();this.documents=new Map();this.queue=[];this.nextId=1;this.closed=false;this.advancing=false;
  }
  state(origin,key,context={}){
    const saved=this.data.origins[origin]?.[key];
    if(saved)return {state:saved,scope:'persistent'};
    if(this.sessions.get(origin)?.has(key))return {state:'allow',scope:'session'};
    const entry=this.documents.get(documentKey(context));
    if(entry?.origin===origin&&entry.keys.has(key))return {state:'allow',scope:'once'};
    return {state:'ask',scope:'default'};
  }
  check(origin,permission,details={},context={}){
    if(this.closed||!originOf(origin))return false;
    if(DEFAULT_ALLOWED.has(permission))return true;
    const keys=permissionKeys(permission,details);
    return keys.length>0&&keys.every(key=>this.state(origin,key,context).state==='allow');
  }
  list(origin,context={}){
    const used=new Set(this.data.used[origin]||[]);
    return Object.entries(DEFINITIONS).filter(([key])=>used.has(key)).map(([key,definition])=>({key,label:definition.label,icon:definition.icon,...this.state(origin,key,context)}));
  }
  markUsed(origin,keys){
    const used=new Set(this.data.used[origin]||[]);const before=used.size;
    keys.filter(key=>Object.hasOwn(DEFINITIONS,key)).forEach(key=>used.add(key));
    if(used.size===before)return;
    this.data.used[origin]=[...used];
    // A usage record is not a grant. A read-only profile must still be able to
    // show a request and make a temporary decision; saved grants remain strict.
    try{this.persist(cleanData(this.data));}catch{}
  }
  get prompt(){
    const request=this.queue[0];if(!request)return null;
    return {id:request.id,tabId:request.tabId,origin:request.origin,host:new URL(request.origin).host,permission:request.permission,
      mediaTypes:request.keys.filter(key=>key==='camera'||key==='microphone').map(key=>key==='camera'?'video':'audio'),
      items:request.keys.map(key=>({key,label:DEFINITIONS[key].requestLabel,icon:DEFINITIONS[key].icon})),layout:request.permission==='media'?'media':'simple'};
  }
  request({origin,permission,details={},tabId,documentId,valid=()=>true},callback){
    const keys=permissionKeys(permission,details),context={tabId,documentId};
    if(this.closed||!originOf(origin)||!valid()){callback(false);return null;}
    if(DEFAULT_ALLOWED.has(permission)){callback(true);return null;}
    if(keys.length)this.markUsed(origin,keys);
    if(!keys.length||keys.some(key=>this.state(origin,key,context).state==='block')){callback(false);return null;}
    if(keys.every(key=>this.state(origin,key,context).state==='allow')){callback(true);return null;}
    if(this.queue.length>=this.maxPending){callback(false);return null;}
    const request={id:String(this.nextId++),origin,permission,keys,tabId,documentId,valid,callback};
    this.queue.push(request);this.advance();return request.id;
  }
  finish(request,allowed){try{request.callback(!!allowed);}catch{/* A destroyed Chromium request may already be gone. */}}
  advance(){
    if(this.advancing)return;this.advancing=true;
    try{
      while(this.queue.length){
        const request=this.queue[0];let allowed=null;
        if(this.closed||!request.valid())allowed=false;
        else if(request.keys.some(key=>this.state(request.origin,key,request).state==='block'))allowed=false;
        else if(request.keys.every(key=>this.state(request.origin,key,request).state==='allow'))allowed=true;
        if(allowed===null)break;
        this.queue.shift();this.finish(request,allowed);
      }
    }finally{this.advancing=false;this.onChange(this.prompt);}
  }
  save(origin,changes){
    const next=cleanData(this.data),entries={...(next.origins[origin]||{})};
    for(const [key,value] of Object.entries(changes)){if(value==='ask')delete entries[key];else entries[key]=value;}
    if(Object.keys(entries).length)next.origins[origin]=entries;else delete next.origins[origin];
    this.persist(next);this.data=next;
  }
  respond(id,decision){
    if(!DECISIONS.has(decision))throw new Error('Invalid permission decision.');
    const request=this.queue[0];if(!request||request.id!==id)return false;
    if(!request.valid()){this.queue.shift();this.finish(request,false);this.advance();return false;}
    let allowed=false;
    if(decision==='allow'||decision==='block'){
      this.save(request.origin,Object.fromEntries(request.keys.map(key=>[key,decision==='allow'?'allow':'block'])));
      allowed=decision==='allow';
    }else if(decision==='allow-session'){
      const keys=this.sessions.get(request.origin)||new Set();request.keys.forEach(key=>keys.add(key));this.sessions.set(request.origin,keys);allowed=true;
    }else if(decision==='allow-once'){
      const id=documentKey(request),entry=this.documents.get(id)||{origin:request.origin,tabId:request.tabId,keys:new Set()};
      request.keys.forEach(key=>entry.keys.add(key));this.documents.set(id,entry);allowed=true;
    }
    this.queue.shift();this.finish(request,allowed);this.advance();return true;
  }
  cancelWhere(predicate){
    const canceled=this.queue.filter(predicate);this.queue=this.queue.filter(request=>!predicate(request));
    canceled.forEach(request=>this.finish(request,false));this.advance();
  }
  forgetDocument(tabId){
    for(const [id,entry] of this.documents)if(entry.tabId===tabId)this.documents.delete(id);
    this.cancelWhere(request=>request.tabId===tabId);
  }
  endVisit(origin){this.sessions.delete(origin);for(const [id,entry] of this.documents)if(entry.origin===origin)this.documents.delete(id);this.cancelWhere(request=>request.origin===origin);}
  set(origin,key,state){
    if(originOf(origin)!==origin||!Object.hasOwn(DEFINITIONS,key)||!STATES.has(state))throw new Error('Invalid site permission.');
    this.save(origin,{[key]:state});this.sessions.get(origin)?.delete(key);
    for(const entry of this.documents.values())if(entry.origin===origin)entry.keys.delete(key);
    if(state==='ask')this.cancelWhere(request=>request.origin===origin&&request.keys.includes(key));else this.advance();
  }
  reset(origin){
    if(originOf(origin)!==origin)throw new Error('Invalid website origin.');
    this.save(origin,Object.fromEntries(Object.keys(DEFINITIONS).map(key=>[key,'ask'])));
    this.endVisit(origin);
  }
  close(){this.closed=true;this.sessions.clear();this.documents.clear();this.cancelWhere(()=>true);}
}

module.exports={PermissionManager,permissionKeys,originOf,cleanData,DEFINITIONS,DEFAULT_ALLOWED};
