#!/usr/bin/env python3
"""Build the small Windows backend Job Object supervisor (not an app launcher)."""
import argparse, shutil, subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--out',type=Path,required=True);args=p.parse_args()
args.out.parent.mkdir(parents=True,exist_ok=True)
source=Path(__file__).with_name('process-runner-win.c')
compiler=shutil.which('x86_64-w64-mingw32-gcc')
if compiler:
 subprocess.run([compiler,'-municode','-Os','-s','-static','-static-libgcc',str(source),'-o',str(args.out)],check=True)
elif shutil.which('cl'):
 subprocess.run(['cl','/nologo','/O2','/MT',str(source),'/link','/SUBSYSTEM:CONSOLE','/OUT:'+str(args.out)],check=True,cwd=args.out.parent)
else:
 raise SystemExit('A Windows C compiler is required: install gcc-mingw-w64-x86-64 on Linux or use an MSVC developer command prompt on Windows.')
print(args.out)
