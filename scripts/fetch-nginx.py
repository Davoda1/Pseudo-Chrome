#!/usr/bin/env python3
"""Fetch verified nginx 1.30.6 and build the portable Linux loopback runtime.

Prerequisites for the Linux build: Python 3.12+, make, GCC, musl-gcc, binutils.
The source archives are pinned by SHA-256. When gpg/gpgv are available, nginx's
detached signatures are additionally verified against its pinned official key.
No network listener is started by this build script.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request
import zipfile

VERSION = "1.30.6"
PCRE_VERSION = "10.47"
ZLIB_VERSION = "1.3.2"
SIGNER = "D6786CE303D9A9022998DC6CC8464D549AF75C0A"
FILES = {
    "nginx-1.30.6.tar.gz": (
        "https://nginx.org/download/nginx-1.30.6.tar.gz",
        "3cf46f5ed7504d460125866b7bea99fb357f31d887e2e63b35503310e9b8b6c8",
    ),
    "nginx-1.30.6.zip": (
        "https://nginx.org/download/nginx-1.30.6.zip",
        "c6ee35edb0a861063323f709192ae50d1eefaf2ea7d00678bd2b22d8542dc61e",
    ),
    "pcre2-10.47.tar.bz2": (
        "https://github.com/PCRE2Project/pcre2/releases/download/pcre2-10.47/pcre2-10.47.tar.bz2",
        "47fe8c99461250d42f89e6e8fdaeba9da057855d06eb7fc08d9ca03fd08d7bc7",
    ),
    "zlib-1.3.2.tar.gz": (
        "https://zlib.net/fossils/zlib-1.3.2.tar.gz",
        "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16",
    ),
    "pluknet.key": (
        "https://nginx.org/keys/pluknet.key",
        "9a70c136946c1d18d5355c41516f1bdc95d4321938919e69065533e2aeb51e0e",
    ),
}


def digest(path: Path) -> str:
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def download(url: str, path: Path, expected: str | None = None) -> None:
    if not path.is_file() or (expected and digest(path) != expected):
        path.parent.mkdir(parents=True, exist_ok=True)
        partial = path.with_name(path.name + ".download")
        with urllib.request.urlopen(url, timeout=90) as response, partial.open("wb") as out:
            shutil.copyfileobj(response, out)
        if expected and digest(partial) != expected:
            partial.unlink(missing_ok=True)
            raise RuntimeError(f"SHA-256 verification failed for {path.name}")
        partial.replace(path)
    if expected and digest(path) != expected:
        raise RuntimeError(f"SHA-256 verification failed for {path.name}")


def run(command: list[str], cwd: Path | None = None, env: dict | None = None) -> str:
    result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f"Command failed: {command[0]}\n{result.stdout[-6000:]}\n{result.stderr[-6000:]}")
    return result.stdout + result.stderr


def signatures(downloads: Path) -> dict:
    result = {"signer_fingerprint": SIGNER, "sha256_verified": True, "pgp_verified": False}
    if not (shutil.which("gpg") and shutil.which("gpgv")):
        return result
    with tempfile.TemporaryDirectory(prefix="ngx-key-") as temp:
        keyring = Path(temp) / "nginx.gpg"
        run(["gpg", "--batch", "--yes", "--dearmor", "--output", str(keyring), str(downloads / "pluknet.key")])
        for filename in (f"nginx-{VERSION}.tar.gz", f"nginx-{VERSION}.zip"):
            asc = downloads / (filename + ".asc")
            download(f"https://nginx.org/download/{filename}.asc", asc)
            status = run(["gpgv", "--keyring", str(keyring), "--status-fd", "1", str(asc), str(downloads / filename)])
            if f"[GNUPG:] VALIDSIG {SIGNER} " not in status:
                raise RuntimeError("Unexpected nginx signature key")
    result["pgp_verified"] = True
    return result


def extract_tar(archive: Path, destination: Path) -> None:
    with tarfile.open(archive) as tf:
        tf.extractall(destination, filter="data")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--work-dir", type=Path, default=Path(__file__).resolve().parents[1] / ".build" / "nginx")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / ".build" / "runtimes")
    parser.add_argument("--musl-cc", default="musl-gcc")
    parser.add_argument("--windows-only", action="store_true")
    args = parser.parse_args()
    work = args.work_dir.resolve()
    output = args.output.resolve()
    downloads = work / "downloads"
    for name, (url, sha) in FILES.items():
        download(url, downloads / name, sha)
    verification = signatures(downloads)
    win = output / "win" / "nginx"
    with tempfile.TemporaryDirectory(prefix="nginx-win-") as temp:
        with zipfile.ZipFile(downloads / f"nginx-{VERSION}.zip") as archive:
            archive.extractall(temp)
        shutil.copytree(Path(temp) / f"nginx-{VERSION}", win, dirs_exist_ok=True)
    metadata = {
        "name": "nginx", "version": VERSION,
        "verification": verification,
        "sources": {name: {"url": url, "sha256": sha} for name, (url, sha) in FILES.items()},
        "windows_executable_sha256": digest(win / "nginx.exe"),
        "windows_architecture": "Official x86/PE32 nginx build; runs through WOW64 on supported x64 Windows systems",
        "linux_linking": "static musl, PCRE2 and zlib",
        "purpose": "Private loopback HTTP static hosting and HTTP/FastCGI proxy; external TLS terminates in the embedded browser.",
    }
    if not args.windows_only:
        cc = shutil.which(args.musl_cc) or args.musl_cc
        if not Path(cc).is_file():
            raise RuntimeError("musl-gcc is required for the portable Linux nginx runtime")
        sources = work / "sources"
        if sources.exists():
            shutil.rmtree(sources)
        sources.mkdir(parents=True, exist_ok=True)
        for filename in (f"nginx-{VERSION}.tar.gz", f"pcre2-{PCRE_VERSION}.tar.bz2", f"zlib-{ZLIB_VERSION}.tar.gz"):
            extract_tar(downloads / filename, sources)
        nginx = sources / f"nginx-{VERSION}"
        compiler_name = Path(cc).name
        configure = [
            "./configure", f"--with-cc={compiler_name}", "--prefix=.", "--sbin-path=nginx",
            "--conf-path=conf/nginx.conf", "--error-log-path=logs/error.log",
            "--http-log-path=logs/access.log", "--pid-path=logs/nginx.pid",
            "--lock-path=logs/nginx.lock", "--with-threads", "--with-http_stub_status_module",
            f"--with-pcre=../pcre2-{PCRE_VERSION}", f"--with-zlib=../zlib-{ZLIB_VERSION}",
            "--with-cc-opt=-O2 -fstack-protector-strong", "--with-ld-opt=-static -Wl,-z,relro,-z,now",
        ]
        env = dict(os.environ, CC=compiler_name)
        env["PATH"] = str(Path(cc).resolve().parent) + os.pathsep + env.get("PATH", "")
        run(configure, nginx, env)
        run(["make", f"-j{min(os.cpu_count() or 2, 4)}"], nginx, env)
        linux = output / "linux" / "nginx"
        linux.mkdir(parents=True, exist_ok=True)
        staging = linux / "nginx.new"
        shutil.copy2(nginx / "objs" / "nginx", staging)
        run(["strip", str(staging)])
        staging.chmod(0o755)
        staging.replace(linux / "nginx")
        shutil.copytree(nginx / "conf", linux / "conf", dirs_exist_ok=True)
        (linux / "logs").mkdir(exist_ok=True)
        shutil.copy2(nginx / "LICENSE", linux / "LICENSE")
        licenses = linux / "licenses"
        licenses.mkdir(exist_ok=True)
        shutil.copy2(sources / f"pcre2-{PCRE_VERSION}" / "LICENCE.md", licenses / "PCRE2-LICENSE.txt")
        shutil.copy2(sources / f"zlib-{ZLIB_VERSION}" / "LICENSE", licenses / "zlib-LICENSE.txt")
        musl_license = Path("/usr/share/doc/musl/copyright")
        if musl_license.is_file():
            shutil.copy2(musl_license, licenses / "musl-LICENSE.txt")
        metadata["linux_executable_sha256"] = digest(linux / "nginx")
        metadata["linux_version_output"] = run([str(linux / "nginx"), "-v"]).strip()
        metadata["linux_build_modules"] = "HTTP core, rewrite/PCRE2, gzip/zlib, proxy, FastCGI, uWSGI, SCGI, threads, stub_status; no TLS listener"
        # A fully static executable must not request a system ELF interpreter.
        program_headers = run(["readelf", "-l", str(linux / "nginx")])
        if "INTERP" in program_headers:
            raise RuntimeError("The Linux nginx binary unexpectedly depends on a system dynamic linker")
        (linux / "runtime-manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (win / "runtime-manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(json.dumps({"output": str(output), "version": VERSION, "verification": verification}, indent=2))


if __name__ == "__main__":
    main()
