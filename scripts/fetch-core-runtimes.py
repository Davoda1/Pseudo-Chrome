#!/usr/bin/env python3
"""Fetch pinned Electron and Node distributions, verify official SHA256 manifests.

No application or project code is executed by this script.
"""
import argparse, concurrent.futures, hashlib, json, os, shutil, tarfile, urllib.request, zipfile
from pathlib import Path

ELECTRON='45.2.1'
NODE='26.13.0'

def fetch(url, dest):
    if dest.exists(): return dest
    tmp=dest.with_name(dest.name+'.part')
    dest.parent.mkdir(parents=True,exist_ok=True)
    print('Downloading',dest.name,flush=True)
    request=urllib.request.Request(url,headers={'User-Agent':'Pseudo-Chrome-build/1.0'})
    with urllib.request.urlopen(request,timeout=90) as response, tmp.open('wb') as out:
        shutil.copyfileobj(response,out,1024*1024)
    tmp.replace(dest)
    return dest

def sha256(path):
    h=hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cache',type=Path,required=True);parser.add_argument('--stage',type=Path,required=True)
    args=parser.parse_args();args.cache.mkdir(parents=True,exist_ok=True)
    bases={'electron':f'https://github.com/electron/electron/releases/download/v{ELECTRON}/','node':f'https://nodejs.org/dist/v{NODE}/'}
    sums={}
    for component,base in bases.items():
        manifest=fetch(base+'SHASUMS256.txt',args.cache/(component+'-SHASUMS256.txt'))
        sums[component]={line.split()[1].lstrip('*'):line.split()[0] for line in manifest.read_text().splitlines() if len(line.split())==2}
    specs=[('electron','linux',f'electron-v{ELECTRON}-linux-x64.zip'),('electron','win',f'electron-v{ELECTRON}-win32-x64.zip'),('node','linux',f'node-v{NODE}-linux-x64.tar.xz'),('node','win',f'node-v{NODE}-win-x64.zip')]
    records=[]
    def prepare(spec):
        component,platform,name=spec;url=bases[component]+name
        archive=fetch(url,args.cache/name);actual=sha256(archive);expected=sums[component][name]
        if actual!=expected:raise RuntimeError(f'SHA256 mismatch for {name}: expected {expected}, got {actual}')
        target=args.stage/('electron' if component=='electron' else 'runtimes')/platform
        if component=='node':target=target/'node'
        if not target.exists():
            target.mkdir(parents=True)
            if name.endswith('.zip'):
                with zipfile.ZipFile(archive) as z:
                    for member in z.infolist():
                        member_name=member.filename.split('/',1)[1] if component=='node' and '/' in member.filename else member.filename
                        if not member_name:continue
                        out=target/member_name
                        if not out.resolve().is_relative_to(target.resolve()):raise RuntimeError('Unsafe archive path')
                        if member.is_dir():out.mkdir(parents=True,exist_ok=True);continue
                        out.parent.mkdir(parents=True,exist_ok=True)
                        with z.open(member) as src,out.open('wb') as dst:shutil.copyfileobj(src,dst)
                        perm=(member.external_attr>>16)&0o777
                        if perm:out.chmod(perm)
            else:
                with tarfile.open(archive) as t:
                    for member in t.getmembers():
                        stripped=member.name.split('/',1)[1] if '/' in member.name else ''
                        if not stripped:continue
                        member.name=stripped;t.extract(member,target,filter='data')
        record={'component':component,'platform':platform,'version':ELECTRON if component=='electron' else NODE,'url':url,'sha256':actual,'verification':'Official HTTPS SHASUMS256.txt','manifest_url':bases[component]+'SHASUMS256.txt','path':str(target)}
        print('Verified',name,flush=True);return record
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:records=list(pool.map(prepare,specs))
    (args.stage/'core-runtime-manifest.json').write_text(json.dumps(records,indent=2)+'\n')
    print('Core runtimes ready',args.stage,flush=True)

if __name__=='__main__':main()
