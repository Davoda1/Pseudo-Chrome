'use strict';
// Integration test: set PSEUDO_TEST_PHP to the bundled PHP-CGI executable.
// Set PSEUDO_TEST_NGINX as well to verify the complete production request path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { SiteHost } = require('../app/lib/host.cjs');
function request(url, pathname = '/', options = {}) {
  const u = new URL(url);
  return new Promise((resolve,reject) => {
    const req = http.request({hostname:u.hostname,port:u.port,path:pathname,method:options.method||'GET',headers:options.headers||{}},res=>{const chunks=[];res.on('data',c=>chunks.push(c));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString('utf8')}));});
    req.on('error',reject);if(options.chunked){req.write(options.body.slice(0,3));req.end(options.body.slice(3));}else req.end(options.body);
  });
}
function phpJson(response, host) {
  try { return JSON.parse(response.body); }
  catch (error) {
    throw new Error(`PHP returned invalid JSON (HTTP ${response.status}).\nResponse body:\n${response.body}\nHosting logs:\n${host.logs.join('\n')}`, { cause: error });
  }
}
test('bundled PHP: query, forms, chunked body, cookies, sessions, uploads, redirects, PATH_INFO and SQLite', { skip: !process.env.PSEUDO_TEST_PHP }, async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pseudo php~integration ')),www=path.join(dir,'website with spaces');await fs.mkdir(www);
  const host=new SiteHost({www,configDir:path.join(dir,'user configuration'),runtimes:{php:process.env.PSEUDO_TEST_PHP,...(process.env.PSEUDO_TEST_NGINX?{nginx:process.env.PSEUDO_TEST_NGINX}:{}),...(process.env.PSEUDO_TEST_RUNNER?{processRunner:process.env.PSEUDO_TEST_RUNNER}:{})}});
  t.after(async()=>{await host.stop();await fs.rm(dir,{recursive:true,force:true})});
  const source=`<?php
session_start(); $_SESSION['visits']=($_SESSION['visits']??0)+1;
if(parse_url($_SERVER['REQUEST_URI'],PHP_URL_PATH)==='/redirect'){header('Location: /target');exit;}
setcookie('first','one');setcookie('second','two');header('Content-Type: application/json');
$db=new PDO('sqlite:'.__DIR__.'/example.sqlite');$db->exec('CREATE TABLE IF NOT EXISTS demo (value TEXT)');$db->exec("INSERT INTO demo VALUES ('ok')");
echo json_encode(['method'=>$_SERVER['REQUEST_METHOD'],'query'=>$_GET,'post'=>$_POST,'raw'=>file_get_contents('php://input'),'uri'=>$_SERVER['REQUEST_URI'],'script'=>$_SERVER['SCRIPT_NAME'],'pathInfo'=>$_SERVER['PATH_INFO']??'','visits'=>$_SESSION['visits'],'sqliteRows'=>$db->query('SELECT COUNT(*) FROM demo')->fetchColumn(),'upload'=>isset($_FILES['asset'])?['name'=>$_FILES['asset']['name'],'data'=>file_get_contents($_FILES['asset']['tmp_name']),'temp'=>$_FILES['asset']['tmp_name']]:null,'caExists'=>file_exists(ini_get('curl.cainfo'))]);`;
  await fs.writeFile(path.join(www,'index.php'),source);await fs.writeFile(path.join(www,'style.css'),'body{color:red}');
  const state=await host.start({mode:'php'});assert.equal(state.mode,'php');
  const first=await request(state.url,'/?hello=world');assert.equal(first.status,200);const a=phpJson(first,host);assert.equal(a.query.hello,'world');assert.equal(a.caExists,true);assert.ok(a.sqliteRows>=1);assert.equal(first.headers['set-cookie'].length,3);
  const cookie=first.headers['set-cookie'].map(s=>s.split(';')[0]).join('; ');
  const second=await request(state.url,'/pretty/route?x=2',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/x-www-form-urlencoded'},body:'name=Example&value=42'});const b=phpJson(second,host);assert.equal(b.post.name,'Example');assert.equal(b.post.value,'42');assert.equal(b.visits,a.visits+1);assert.equal(b.uri,'/pretty/route?x=2');
  const chunked=phpJson(await request(state.url,'/',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'name=Chunked',chunked:true}),host);assert.equal(chunked.post.name,'Chunked');
  const info=phpJson(await request(state.url,'/index.php/nested/info'),host);assert.equal(info.pathInfo,'/nested/info');assert.equal(info.script,'/index.php');
  const redirect=await request(state.url,'/redirect');assert.equal(redirect.status,302);assert.equal(redirect.headers.location,'/target');
  const boundary='PseudoChromeTestBoundary';const multipart='--'+boundary+'\r\nContent-Disposition: form-data; name="asset"; filename="demo.txt"\r\nContent-Type: text/plain\r\n\r\nfile payload\r\n--'+boundary+'--\r\n';
  const uploaded=phpJson(await request(state.url,'/',{method:'POST',headers:{'Content-Type':'multipart/form-data; boundary='+boundary},body:multipart}),host);assert.equal(uploaded.upload.name,'demo.txt');assert.equal(uploaded.upload.data,'file payload');assert.ok(uploaded.upload.temp.includes('php-temp'));
  assert.equal((await request(state.url,'/style.css')).body,'body{color:red}');assert.equal((await request(state.url,'/example.sqlite')).status,403);
  assert.ok(!first.body.includes('<?php'));assert.equal(host.status.state,'ready');
});
