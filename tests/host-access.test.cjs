'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const net=require('node:net');
const {SiteHost,ACCESS_HEADER}=require('../app/lib/host.cjs');
const TOKEN='test-capability-0123456789-abcdefghijklmnop';
const AUTH={[ACCESS_HEADER]:TOKEN};
async function fixture(t,runtimes={}){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pseudo-access-')),www=path.join(dir,'www');await fs.mkdir(www);
  const host=new SiteHost({www,configDir:path.join(dir,'config'),runtimes:{...(process.env.PSEUDO_TEST_RUNNER?{processRunner:process.env.PSEUDO_TEST_RUNNER}:{}),...runtimes},accessPolicy:{allowExternalPrograms:false,token:TOKEN}});
  t.after(async()=>{await host.stop();await fs.rm(dir,{recursive:true,force:true});});
  return {dir,www,host,write:(name,text)=>fs.writeFile(path.join(www,name),text)};
}
function request(url,pathname='/',options={}){
  const parsed=new URL(url);
  return new Promise((resolve,reject)=>{
    const q=http.request({host:parsed.hostname,port:parsed.port,path:pathname,method:options.method||'GET',headers:options.headers||{},timeout:5000},r=>{let text='';r.on('data',b=>text+=b);r.on('end',()=>resolve({status:r.statusCode,headers:r.headers,body:text}));});
    q.on('error',reject);q.on('timeout',()=>q.destroy(Error('Request timeout')));q.end(options.body);
  });
}
const NODE_SOURCE=`const http=require('http');const s=http.createServer((q,r)=>{let body='';q.on('data',b=>body+=b);q.on('end',()=>{r.setHeader('Set-Cookie',['one=1; Path=/; HttpOnly','two=2; Path=/; SameSite=Lax']);r.setHeader('Content-Type','application/json');r.end(JSON.stringify({headers:q.headers,body,url:q.url}));});});s.on('upgrade',(q,socket)=>{socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: test\\r\\n\\r\\n');socket.write(JSON.stringify(q.headers));socket.on('data',b=>socket.write(b));});s.listen(+process.env.PORT,process.env.HOST);`;
function upgrade(url,headers={}){
  const port=+new URL(url).port;
  return new Promise((resolve,reject)=>{
    const socket=net.createConnection({host:'127.0.0.1',port});let text='';
    socket.setTimeout(5000,()=>{socket.destroy();reject(Error('Upgrade timeout'));});socket.on('error',reject);
    socket.on('connect',()=>socket.write(`GET /socket HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: test\r\n${Object.entries(headers).map(([k,v])=>k+': '+v+'\r\n').join('')}\r\n`));
    socket.on('data',b=>{text+=b;if(text.includes('403 Forbidden')||text.includes('"upgrade":"test"'))resolve({socket,text});});
  });
}
for(const engine of ['built-in','nginx'])test(`app-only gate and live access switch work through ${engine}`,{skip:engine==='nginx'&&!process.env.PSEUDO_TEST_NGINX},async t=>{
  const f=await fixture(t,engine==='nginx'?{nginx:process.env.PSEUDO_TEST_NGINX}:{});await f.write('index.html','private demo');await f.write('config.pseudochrome','SIMULATED_DOMAINNAME=example.test');
  const {url}=await f.host.start({mode:'static'});
  assert.equal((await request(url)).status,403);assert.equal((await request(url,'/',{headers:{[ACCESS_HEADER]:'incorrect-token'}})).status,403);
  assert.equal((await request(url,'/',{headers:AUTH})).body,'private demo');
  for(const name of ['/config.pseudochrome','/config%2epseudochrome','/CONFIG.PSEUDOCHROME','/config.pseudochrome.','/config.pseudochrome%20'])assert.equal((await request(url,name,{headers:AUTH})).status,403,name);
  assert.equal((await request(`http://127.0.0.1:${f.host.gateway.address().port}`)).status,403);
  f.host.setAccessPolicy({allowExternalPrograms:true});assert.equal((await request(url)).body,'private demo');
  f.host.setAccessPolicy({allowExternalPrograms:false});assert.equal((await request(url)).status,403);assert.equal((await request(url,'/',{headers:AUTH})).status,200);
  assert.ok(f.host.logs.every(line=>!line.includes(TOKEN)));
});
for(const mode of ['node','native'])test(`${mode} proxy preserves cookies, bodies and routes without leaking the access header`,async t=>{
  const f=await fixture(t,{node:process.execPath,...(process.env.PSEUDO_TEST_NGINX?{nginx:process.env.PSEUDO_TEST_NGINX}:{})});await f.write('server.cjs',NODE_SOURCE);
  const entry=mode==='node'?'server.cjs':process.platform==='win32'?'native-node.exe':'native-node';
  if(mode==='native')await fs.copyFile(process.execPath,path.join(f.www,entry));
  const {url}=await f.host.start({mode,entry,args:mode==='native'?['server.cjs']:[]});
  assert.equal((await request(url)).status,403);
  const r=await request(url,'/echo?q=1',{method:'POST',headers:{...AUTH,'Content-Type':'text/plain',Cookie:'a=1; b=2',Origin:url},body:'posted body'});
  assert.equal(r.status,200);assert.equal(r.headers['set-cookie'].length,2);
  const data=JSON.parse(r.body);assert.equal(data.body,'posted body');assert.equal(data.url,'/echo?q=1');assert.equal(data.headers.cookie,'a=1; b=2');assert.equal(data.headers.origin,url);assert.equal(data.headers[ACCESS_HEADER],undefined);
  assert.equal((await request(url,'/config.pseudochrome',{headers:AUTH})).status,403);
  assert.equal((await request(url,'/config.pseudochrome/read',{headers:AUTH})).status,403);
});
test('WebSocket gate strips private header and disabling access closes existing external streams',async t=>{
  const f=await fixture(t,{node:process.execPath,...(process.env.PSEUDO_TEST_NGINX?{nginx:process.env.PSEUDO_TEST_NGINX}:{})});await f.write('server.cjs',NODE_SOURCE);
  const {url}=await f.host.start({mode:'node',entry:'server.cjs'});
  let result=await upgrade(url);assert.match(result.text,/403 Forbidden/);result.socket.destroy();
  result=await upgrade(url,AUTH);assert.match(result.text,/101 Switching Protocols/);assert.ok(!result.text.includes(TOKEN));assert.ok(!result.text.includes(ACCESS_HEADER));result.socket.destroy();
  f.host.setAccessPolicy({allowExternalPrograms:true});result=await upgrade(url);assert.match(result.text,/101 Switching Protocols/);
  const authenticated=await upgrade(url,AUTH);
  const closed=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('External stream did not close')),3000);result.socket.once('close',()=>{clearTimeout(timer);resolve();});});
  f.host.setAccessPolicy({allowExternalPrograms:false});await closed;assert.equal((await request(url)).status,403);
  const echoed=await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('Authenticated stream stopped')),3000);authenticated.socket.on('data',b=>{text+=b;if(text.includes('still-connected')){clearTimeout(timer);resolve(text);}});authenticated.socket.write('still-connected');});
  assert.match(echoed,/still-connected/);authenticated.socket.destroy();
});
test('PHP access gate preserves session cookies and does not expose its private header',{skip:!process.env.PSEUDO_TEST_PHP},async t=>{
  const f=await fixture(t,{php:process.env.PSEUDO_TEST_PHP,...(process.env.PSEUDO_TEST_NGINX?{nginx:process.env.PSEUDO_TEST_NGINX}:{})});
  await f.write('index.php',`<?php session_start(); $_SESSION['count']=($_SESSION['count']??0)+1; header('Content-Type: application/json'); echo json_encode(['count'=>$_SESSION['count'],'private'=>$_SERVER['HTTP_X_PSEUDO_CHROME_ACCESS']??null]);`);
  const {url}=await f.host.start({mode:'php'});assert.equal((await request(url)).status,403);
  const first=await request(url,'/',{headers:AUTH});assert.equal(JSON.parse(first.body).count,1);assert.equal(JSON.parse(first.body).private,null);
  const cookie=first.headers['set-cookie'][0].split(';')[0],second=await request(url,'/',{headers:{...AUTH,Cookie:cookie}});assert.equal(JSON.parse(second.body).count,2);
  assert.equal((await request(url,'/config.pseudochrome',{headers:AUTH})).status,403);
});
test('invalid access policies fail rather than enabling private access accidentally',async t=>{
  const f=await fixture(t);
  assert.throws(()=>f.host.setAccessPolicy({allowExternalPrograms:'yes'}),/access policy/);
  assert.throws(()=>f.host.setAccessPolicy({allowExternalPrograms:false,token:''}),/access policy/);
  assert.throws(()=>f.host.setAccessPolicy({allowExternalPrograms:false,token:'short'}),/access policy/);
  assert.throws(()=>f.host.setAccessPolicy({allowExternalPrograms:true,token:TOKEN+'\r\n'}),/access policy/);
});
