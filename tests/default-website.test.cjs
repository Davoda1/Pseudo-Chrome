'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {seedDefaultWebsite}=require('../app/lib/default-website.cjs');
const source=path.resolve(__dirname,'../app/default-www');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'pseudo-manual-test-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return{root,www:path.join(root,'www'),source,siteConfig:path.join(root,'site.json')};}
test('fresh installation gets the offline manual, including its local assets',async t=>{const f=await fixture(t);assert.equal(await seedDefaultWebsite(f),true);assert.match(await fs.readFile(path.join(f.www,'index.html'),'utf8'),/Welcome to/);assert.deepEqual(await fs.readFile(path.join(f.www,'assets/icon.svg')),await fs.readFile(path.join(source,'assets/icon.svg')));await assert.rejects(fs.access(f.siteConfig),{code:'ENOENT'});});
test('existing website is preserved byte for byte and receives no manual files',async t=>{const f=await fixture(t);await fs.mkdir(f.www);await fs.writeFile(path.join(f.www,'index.html'),'User website');assert.equal(await seedDefaultWebsite(f),false);assert.equal(await fs.readFile(path.join(f.www,'index.html'),'utf8'),'User website');assert.deepEqual(await fs.readdir(f.www),['index.html']);});
test('existing configuration is preserved and an empty configured folder is not seeded',async t=>{const f=await fixture(t);const config='{"mode":"node","entry":"server.cjs"}\n';await fs.writeFile(f.siteConfig,config);assert.equal(await seedDefaultWebsite(f),false);assert.equal(await fs.readFile(f.siteConfig,'utf8'),config);assert.deepEqual(await fs.readdir(f.www),[]);});
