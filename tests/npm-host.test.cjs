'use strict';
// Optional real bundled-runtime integration. Set PSEUDO_TEST_NODE and
// PSEUDO_TEST_NPM_CLI to their absolute package runtime paths.
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {SiteHost}=require('../app/lib/host.cjs');
test('bundled Node/npm start a project script with arguments and environment', {skip:!process.env.PSEUDO_TEST_NODE||!process.env.PSEUDO_TEST_NPM_CLI}, async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pseudo npm project '));const www=path.join(dir,'www');await fs.mkdir(www);
 await fs.writeFile(path.join(www,'package.json'),JSON.stringify({name:'local-runtime-test',version:'1.0.0',scripts:{start:'node backend.cjs'}}));
 await fs.writeFile(path.join(www,'backend.cjs'),"require('http').createServer((q,s)=>{s.setHeader('Content-Type','application/json');s.end(JSON.stringify({argument:process.argv[2],label:process.env.DEMO_LABEL,version:process.version,host:process.env.HOST}))}).listen(+process.env.PORT,process.env.HOST)");
 const host=new SiteHost({www,configDir:path.join(dir,'config'),runtimes:{...(process.env.PSEUDO_TEST_RUNNER?{processRunner:process.env.PSEUDO_TEST_RUNNER}:{}),node:process.env.PSEUDO_TEST_NODE,npmCli:process.env.PSEUDO_TEST_NPM_CLI,...(process.env.PSEUDO_TEST_NGINX?{nginx:process.env.PSEUDO_TEST_NGINX}:{})}});
 t.after(async()=>{await host.stop();await fs.rm(dir,{recursive:true,force:true})});
 const {url,mode}=await host.start({mode:'auto',args:['example argument'],env:{DEMO_LABEL:'runtime works'}});assert.equal(mode,'node');
 const data=await (await fetch(url)).json();assert.equal(data.argument,'example argument');assert.equal(data.label,'runtime works');assert.equal(data.host,'127.0.0.1');assert.match(data.version,/^v\d+/);
});
