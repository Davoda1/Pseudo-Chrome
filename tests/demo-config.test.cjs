'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {parseDemoConfig,loadDemoConfig,MAX_BYTES}=require('../app/lib/demo-config.cjs');

test('demo config reads BOM, comments, quotes and normalizes display hostname',()=>{
  assert.deepEqual(parseDemoConfig('\uFEFF# Display settings\r\n; local demo\r\nSIMULATED_DOMAINNAME="Demo.Example."\r\nPORT=4173\r\n'),{simulatedDomainName:'demo.example',port:4173});
  assert.deepEqual(parseDemoConfig("SIMULATED_DOMAINNAME='bücher.test'\nPORT='0'"),{simulatedDomainName:'xn--bcher-kva.test',port:0});
  assert.deepEqual(parseDemoConfig('SIMULATED_DOMAINNAME=\n'),{simulatedDomainName:'',port:undefined});
  assert.equal(parseDemoConfig('PORT=65535').port,65535);
});
test('demo config rejects unsafe addresses, ports and unknown or duplicate flags',()=>{
  for(const value of ['https://demo.test','demo.test/path','demo.test:80','user@demo.test','demo test','a..test','-demo.test','demo-.test','demo.test?x=1','demo.test#fragment','demo\\test']) assert.throws(()=>parseDemoConfig('SIMULATED_DOMAINNAME='+value),/config\.pseudochrome:1:/,value);
  for(const value of ['','-1','65536','1.5','1e3','001','true']) assert.throws(()=>parseDemoConfig('PORT='+value),/PORT/,value);
  assert.throws(()=>parseDemoConfig('PORT=1\nPORT=2'),/:2: Duplicate/);
  assert.throws(()=>parseDemoConfig('COMMAND=run'),/Unknown setting COMMAND/);
  assert.throws(()=>parseDemoConfig('PORT=1 # comment'),/PORT/);
  assert.throws(()=>parseDemoConfig('PORT="42'),/quoted/);
  assert.throws(()=>parseDemoConfig('SIMULATED_DOMAINNAME="a\"b"'),/quotes/);
  assert.throws(()=>parseDemoConfig('PORT=1\0'),/control/);
  assert.throws(()=>parseDemoConfig('#'.repeat(MAX_BYTES+1)),/at most/);
});
test('absent demo config is benign and a valid file carries presence and absolute path',async t=>{
  const www=await fs.mkdtemp(path.join(os.tmpdir(),'pseudo-demo-config-'));t.after(()=>fs.rm(www,{recursive:true,force:true}));
  assert.deepEqual(await loadDemoConfig(www),{present:false,path:path.join(www,'config.pseudochrome'),simulatedDomainName:'',port:undefined});
  await fs.writeFile(path.join(www,'config.pseudochrome'),'SIMULATED_DOMAINNAME=demo.test\nPORT=9000');
  assert.deepEqual(await loadDemoConfig(www),{present:true,path:path.join(www,'config.pseudochrome'),simulatedDomainName:'demo.test',port:9000});
});
test('demo config rejects non-UTF8, oversized and non-regular files',async t=>{
  const www=await fs.mkdtemp(path.join(os.tmpdir(),'pseudo-demo-invalid-'));t.after(()=>fs.rm(www,{recursive:true,force:true}));
  const filename=path.join(www,'config.pseudochrome');
  await fs.writeFile(filename,Buffer.from([0xff]));await assert.rejects(loadDemoConfig(www),/UTF-8/);
  await fs.writeFile(filename,'#'.repeat(MAX_BYTES+1));await assert.rejects(loadDemoConfig(www),/at most/);
  await fs.unlink(filename);await fs.mkdir(filename);await assert.rejects(loadDemoConfig(www),/regular file/);
});
test('demo config does not read a linked file outside www',{skip:process.platform==='win32'},async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'pseudo-demo-link-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const www=path.join(dir,'www');await fs.mkdir(www);await fs.writeFile(path.join(dir,'outside'),'PORT=1234');
  await fs.symlink('../outside',path.join(www,'config.pseudochrome'));
  await assert.rejects(loadDemoConfig(www),/regular file/);
});
test('demo config rejects a pathname replaced after opening and closes its descriptor',async t=>{
  const www=await fs.mkdtemp(path.join(os.tmpdir(),'pseudo-demo-open-race-'));t.after(()=>fs.rm(www,{recursive:true,force:true}));
  const filename=path.join(www,'config.pseudochrome');
  await fs.writeFile(filename,'PORT=1234');
  const open=fs.open.bind(fs);let opened;
  t.mock.method(fs,'open',async (...args)=>{
    const handle=await open(...args);
    if(args[0]===filename){
      opened=handle;
      await fs.rename(filename,path.join(www,'original'));
      await fs.writeFile(filename,'PORT=5678');
    }
    return handle;
  });
  await assert.rejects(loadDemoConfig(www),/changed while opening/);
  assert.equal(opened.fd,-1,'the rejected descriptor is closed');
});
test('demo config reads the opened file when its pathname changes after validation',async t=>{
  const www=await fs.mkdtemp(path.join(os.tmpdir(),'pseudo-demo-read-race-'));t.after(()=>fs.rm(www,{recursive:true,force:true}));
  const filename=path.join(www,'config.pseudochrome');
  await fs.writeFile(filename,'PORT=1234');
  const lstat=fs.lstat.bind(fs);
  t.mock.method(fs,'lstat',async (...args)=>{
    const stat=await lstat(...args);
    if(args[0]===filename){
      await fs.rename(filename,path.join(www,'original'));
      await fs.writeFile(filename,'PORT=5678');
    }
    return stat;
  });
  assert.equal((await loadDemoConfig(www)).port,1234);
  assert.equal(await fs.readFile(filename,'utf8'),'PORT=5678');
});
test('demo config limits reads when the opened file grows after its size check',async t=>{
  const www=await fs.mkdtemp(path.join(os.tmpdir(),'pseudo-demo-growth-'));t.after(()=>fs.rm(www,{recursive:true,force:true}));
  const filename=path.join(www,'config.pseudochrome');
  await fs.writeFile(filename,'#');
  const open=fs.open.bind(fs);let opened,totalRead=0;
  t.mock.method(fs,'open',async (...args)=>{
    const handle=await open(...args);
    if(args[0]===filename){
      opened=handle;
      const stat=handle.stat.bind(handle),read=handle.read.bind(handle);
      t.mock.method(handle,'stat',async (...statArgs)=>{
        const result=await stat(...statArgs);
        await fs.appendFile(filename,'#'.repeat(MAX_BYTES*2));
        return result;
      });
      t.mock.method(handle,'read',async (...readArgs)=>{
        const result=await read(...readArgs);totalRead+=result.bytesRead;return result;
      });
    }
    return handle;
  });
  await assert.rejects(loadDemoConfig(www),/exceeds/);
  assert.equal(totalRead,MAX_BYTES+1,'reads at most one byte beyond the limit');
  assert.equal(opened.fd,-1,'the rejected descriptor is closed');
});
