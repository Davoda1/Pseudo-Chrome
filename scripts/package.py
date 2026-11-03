#!/usr/bin/env python3
"""Stage and package Pseudo-Chrome without application launcher scripts.

Run fetch-core-runtimes.py, fetch-nginx.py and fetch-php.py first.
Then: python3 scripts/package.py --stage ../pseudo-build --out ../deliverables --phase stage
After validation repeat with --phase release. All release files use version in package.json.
"""
import argparse, gzip, hashlib, json, os, re, shutil, subprocess, tarfile, tempfile, zipfile
from pathlib import Path

ROOT=Path(__file__).resolve().parent.parent
SKIP={'.git','node_modules','__pycache__','.DS_Store','dist','build','.build','.cache','deliverables','.runtime-cache'}
SOURCE_PRIVATE_ROOT={'www','site.json','settings.json','permissions.json','test-results','playwright-report','pseudo-build'}

TEMP_BINARY=re.compile(r'^\.(?:electron(?:\.exe)?|pseudo-chrome(?:-runtime)?|Pseudo-Chrome\.exe|node(?:\.exe)?)\.[A-Za-z0-9.]+$')

def temporary_path(path):
    return any(TEMP_BINARY.fullmatch(part) for part in path.parts)

def copytree(src,dst):
    def ignore(directory,names):
        return [n for n in names if n in ('__pycache__','.DS_Store') or n.endswith('.pyc') or TEMP_BINARY.fullmatch(n)]
    shutil.copytree(src,dst,dirs_exist_ok=True,symlinks=True,ignore=ignore)

def clean_copy_temporaries(root):
    pattern=re.compile(r'^\.(?:electron(?:\.exe)?|pseudo-chrome(?:-runtime)?|Pseudo-Chrome\.exe|node(?:\.exe)?)\.[A-Za-z0-9.]+$')
    for path in root.rglob('.*'):
        if path.is_file() and pattern.fullmatch(path.name):path.unlink()

def digest(path):
    h=hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda:f.read(1048576),b''):h.update(block)
    return h.hexdigest()

def package_manifest(stage,platform):
    records=[]
    for pattern in ['core-runtime-manifest.json','nginx-runtime-manifest.json','php-runtime-manifest.json']:
        file=stage/pattern
        if file.exists():
            item=json.loads(file.read_text())
            candidates=item if isinstance(item,list) else [item]
            for record in candidates:
                if isinstance(record,dict) and record.get('platform') in (platform,None):
                    record={k:v for k,v in record.items() if k not in ('path','build_dir','staging_dir','workspace','archive_path')}
                    records.append(record)
    return records

def stage_package(stage,platform,version,package_root=None):
    target=(package_root or stage/'packages')/('Pseudo-Chrome-Windows-x64' if platform=='win' else 'Pseudo-Chrome-Linux-x64')
    if target.exists():shutil.rmtree(target)
    copytree(stage/'electron'/platform,target)
    appdir=target/'resources'/'app';appdir.mkdir(parents=True,exist_ok=True)
    copytree(ROOT/'app',appdir/'app')
    package=json.loads((ROOT/'package.json').read_text())
    package.pop('devDependencies',None);package.pop('scripts',None)
    (appdir/'package.json').write_text(json.dumps(package,indent=2)+'\n')
    if (ROOT/'README.md').exists():shutil.copy2(ROOT/'README.md',target/'README.md')
    if (ROOT/'LICENSE').exists():
        shutil.copy2(ROOT/'LICENSE',appdir/'LICENSE')
        # Keep Electron's own root LICENSE intact and identify the app license.
        shutil.copy2(ROOT/'LICENSE',target/'LICENSE-PSEUDO-CHROME')
    if (ROOT/'THIRD-PARTY-NOTICES.md').exists():shutil.copy2(ROOT/'THIRD-PARTY-NOTICES.md',target/'THIRD-PARTY-NOTICES.md')
    if (ROOT/'examples').exists():copytree(ROOT/'examples',target/'examples')
    (target/'resources'/'default_app.asar').unlink(missing_ok=True)
    runtimes=target/'resources'/'runtimes';copytree(stage/'runtimes'/platform,runtimes)
    if platform=='win':
        paths={'node':'node/node.exe','npmCli':'node/node_modules/npm/bin/npm-cli.js','nginx':'nginx/nginx.exe','php':'php/php-cgi.exe','processRunner':'process-runner.exe'}
        source=target/'electron.exe';dest=target/'Pseudo-Chrome.exe'
        env=os.environ.copy()
        if 'RESEDIT_MODULE_PATH' not in env:
            local=ROOT/'scripts'/'build-tools'/'node_modules'/'resedit'/'dist'/'index.js'
            staged=stage/'build-tools'/'node_modules'/'resedit'/'dist'/'index.js'
            env['RESEDIT_MODULE_PATH']=str(local if local.exists() else staged)
        subprocess.run(['node',str(ROOT/'scripts'/'brand-windows.cjs'),str(source),str(dest),str(ROOT/'app'/'assets'/'icon.ico'),version],check=True,env=env)
        source.unlink()
    else:
        paths={'node':'node/bin/node','npmCli':'node/lib/node_modules/npm/bin/npm-cli.js','nginx':'nginx/nginx','php':'php/php-cgi'}
        (target/'electron').rename(target/'pseudo-chrome');(target/'pseudo-chrome').chmod(0o755)
        (target/'chrome-sandbox').chmod(0o755)
    for name,relative in paths.items():
        if not (runtimes/relative).is_file():raise RuntimeError(f'Missing {name} runtime: {runtimes/relative}')
    (runtimes/'paths.json').write_text(json.dumps(paths,indent=2)+'\n')
    manifests=package_manifest(stage,platform)
    for component in ('nginx','php'):
        m=runtimes/component/'runtime-manifest.json'
        if m.exists():manifests.append(json.loads(m.read_text()))
    if platform=='win':manifests.append({'component':'process-runner','version':version,'architecture':'x86_64','source':'scripts/process-runner-win.c','sha256':digest(runtimes/'process-runner.exe')})
    (runtimes/'runtime-manifest.json').write_text(json.dumps(manifests,indent=2)+'\n')
    clean_copy_temporaries(target)
    return target

def make_deb(stage,linux,output,version,debroot=None):
    debroot=debroot or stage/'debian-root'
    if debroot.exists():shutil.rmtree(debroot)
    runtime=debroot/'usr'/'lib'/'pseudo-chrome';runtime.parent.mkdir(parents=True,exist_ok=True)
    copytree(linux,runtime);(runtime/'pseudo-chrome').rename(runtime/'pseudo-chrome-runtime')
    (runtime/'chrome-sandbox').chmod(0o4755)
    entry=debroot/'usr'/'bin'/'pseudo-chrome';entry.parent.mkdir(parents=True)
    compiler=shutil.which('musl-gcc')
    if not compiler:raise RuntimeError('musl-gcc is required for the static Debian entry point')
    subprocess.run([compiler,'-O2','-s','-static',str(ROOT/'scripts'/'debian-entry.c'),'-o',str(entry)],check=True)
    if entry.is_symlink() or entry.read_bytes()[:4]!=b'\x7fELF':raise RuntimeError('Debian entry is not a real ELF executable')
    entry.chmod(0o755)
    desktop=debroot/'usr'/'share'/'applications'/'pseudo-chrome.desktop';desktop.parent.mkdir(parents=True)
    desktop.write_text('[Desktop Entry]\nType=Application\nName=Pseudo-Chrome\nComment=Showcase a local website in a Chromium-based desktop window\nExec=/usr/bin/pseudo-chrome\nIcon=pseudo-chrome\nTerminal=false\nCategories=Development;WebDevelopment;\nStartupWMClass=Pseudo-Chrome\n')
    icon=debroot/'usr'/'share'/'icons'/'hicolor'/'256x256'/'apps'/'pseudo-chrome.png';icon.parent.mkdir(parents=True)
    shutil.copy2(ROOT/'app'/'assets'/'icon.png',icon)
    license_file=ROOT/'LICENSE'
    if license_file.is_file():
        copyright_file=debroot/'usr'/'share'/'doc'/'pseudo-chrome'/'copyright'
        copyright_file.parent.mkdir(parents=True,exist_ok=True)
        copyright_file.write_text('Pseudo-Chrome\nCopyright davoda1\nSource: https://github.com/Davoda1/Pseudo-Chrome\n\n'+license_file.read_text())
    control=debroot/'DEBIAN'/'control';control.parent.mkdir()
    installed=sum(f.stat().st_size for f in debroot.rglob('*') if f.is_file())//1024
    control.write_text(f'''Package: pseudo-chrome
Version: {version}
Section: devel
Priority: optional
Architecture: amd64
Maintainer: Pseudo-Chrome <noreply@invalid.example>
Installed-Size: {installed}
Depends: libc6 (>= 2.28), libasound2 | libasound2t64, libatk1.0-0 | libatk1.0-0t64, libatk-bridge2.0-0 | libatk-bridge2.0-0t64, libcups2 | libcups2t64, libdbus-1-3, libdrm2, libexpat1, libgbm1, libglib2.0-0 | libglib2.0-0t64, libgtk-3-0 | libgtk-3-0t64, libnspr4, libnss3, libpango-1.0-0, libx11-6, libxcb1, libxcomposite1, libxdamage1, libxext6, libxfixes3, libxkbcommon0, libxrandr2
Homepage: https://github.com/Davoda1/Pseudo-Chrome
Description: Local website demonstration utility
 Chrome-style desktop shell with local tabs, managed nginx hosting,
 Node.js and PHP runtimes, and support for prepared native backends.
''')
    clean_copy_temporaries(debroot)
    subprocess.run(['dpkg-deb','--root-owner-group','--build','-Zxz','-z6',str(debroot),str(output)],check=True)
    return debroot

def zip_tree(root,output,prefix=''):
    with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=6,allowZip64=True) as z:
        for f in sorted(root.rglob('*')):
            if temporary_path(f.relative_to(root)):continue
            if f.is_file():z.write(f,Path(prefix)/f.relative_to(root))

def tar_tree(root,output,prefix=''):
    with tarfile.open(output,'w:gz',compresslevel=6) as t:
        for f in sorted(root.rglob('*')):
            if temporary_path(f.relative_to(root)):continue
            arc=str(Path(prefix)/f.relative_to(root))
            info=t.gettarinfo(str(f),arcname=arc);info.uid=info.gid=0;info.uname=info.gname='root'
            if info.isfile():
                with f.open('rb') as stream:t.addfile(info,stream)
            else:t.addfile(info)

def source_copy(stage):
    src=stage/'source-export'
    if src.exists():shutil.rmtree(src)
    def ignore(directory,names):
        at_root=Path(directory).resolve()==ROOT.resolve()
        return [n for n in names if n in SKIP or n.endswith(('.pyc','.log','.part')) or TEMP_BINARY.fullmatch(n)
                or n=='.env' or (n.startswith('.env.') and n!='.env.example')
                or (at_root and n in SOURCE_PRIVATE_ROOT)]
    shutil.copytree(ROOT,src,ignore=ignore)
    return src

def main():
    p=argparse.ArgumentParser();p.add_argument('--stage',type=Path,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--phase',choices=['stage','release'],default='stage')
    args=p.parse_args();stage=args.stage.resolve();out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
    version=json.loads((ROOT/'package.json').read_text())['version']
    # Release staging stays outside synchronized workspaces; archive traversal
    # also rejects partial-copy filenames even if a source sync is in progress.
    private=tempfile.TemporaryDirectory(prefix='pseudo-chrome-release-') if args.phase=='release' else None
    private_root=Path(private.name) if private else stage
    package_root=private_root/'packages'
    linux=stage_package(stage,'linux',version,package_root);windows=stage_package(stage,'win',version,package_root)
    if args.phase=='stage':
        print(json.dumps({'linux':str(linux),'windows':str(windows)}));return
    readme=ROOT/'README.md';preview=ROOT/'Preview.html'
    if not readme.is_file() or not preview.is_file():raise RuntimeError('README.md and Preview.html must be final before release packaging')
    paths=[out/f'Pseudo-Chrome-{version}-Windows-x64-portable.zip',out/f'Pseudo-Chrome-{version}-Linux-x64.tar.gz',out/f'pseudo-chrome_{version}_amd64.deb',out/f'Pseudo-Chrome-{version}-Source.zip',out/f'Pseudo-Chrome-{version}-Source.tar.gz',out/f'Pseudo-Chrome-{version}-Preview.html',out/f'Pseudo-Chrome-{version}-README.txt']
    zip_tree(windows,paths[0]);tar_tree(linux,paths[1]);debroot=make_deb(stage,linux,paths[2],version,private_root/'debian-root')
    source=source_copy(private_root);zip_tree(source,paths[3],f'Pseudo-Chrome-{version}');tar_tree(source,paths[4],f'Pseudo-Chrome-{version}')
    shutil.copy2(preview,paths[5]);shutil.copy2(readme,paths[6])
    sums=out/'SHA256SUM.txt';sums.write_text(''.join(f'{digest(f)}  {f.name}\n' for f in paths))
    sizes={label:sum(f.lstat().st_size for f in folder.rglob('*') if f.is_file() and not f.is_symlink()) for label,folder in [('linux',linux),('windows',windows),('debian',debroot)]}
    (stage/'release-uncompressed-sizes.json').write_text(json.dumps(sizes,indent=2)+'\n')
    print(json.dumps({'uncompressed_bytes':sizes,'files':[{'path':str(f),'size':f.stat().st_size} for f in paths+[sums]]},indent=2))
if __name__=='__main__':main()
