"""Prompt enhancer check on this computer (macOS, Linux, Windows). Standard library only, Python 3.9+.

Talks to Kokon's local API. Checks that the engine is Kokon's own (kokon-...) with text
generation, then runs text-to-image and an edit with the enhancer off and on (same seed) and
records the time the enhancer adds, its tokens/s and the peak memory.

Normal mode, against the running Kokon app (open Kokon first; jobs land in the gallery with
client "enhancer-check", so the records can be checked in the app afterwards):

    python3 scripts/dev/enhancer-check.py

8 GB card emulated on a bigger NVIDIA card (Windows; close Kokon first). Starts its own service
with a copy of your config (isolated data folder, free ports, 8gb preset) and holds the VRAM a
real 8 GB card does not have with vram-ballast.py:

    cargo build -p qls-service
    python scripts\\dev\\enhancer-check.py --card-mib 8188

On a slow Mac, 2 images instead of 6 (no enhancer-off runs; the enhancer's own time
comes from the service log):

    python3 scripts/dev/enhancer-check.py --quick

Fallback check (engine without the prompt enhancer, e.g. an official sd-server started by hand
on Kokon's port before opening Kokon): a job with enhance on must still finish, with a note:

    python3 scripts/dev/enhancer-check.py --expect-no-enhancer

Results: <Desktop or home>/kokon-enhancer-check/<timestamp>/ (report.md, results.json, the
images are in Kokon's gallery). Paste report.md back in the chat.

Start Kokon from branch prompt-enhancer first:
  git pull && npx tauri dev   (Mac, Linux, Windows)

In the app, by hand, after the script:
  1. At first start the engine update is offered (What's New / Setup): accept it before the script.
  2. The Enhance pill is visible in the composer (text-to-image and edit).
  3. Enhance on, a short prompt in Italian: the job card shows the prompt being written live.
  4. The record (also the script's "enhancer-check" images) shows your prompt and the expanded one.
  5. --expect-no-enhancer run only: the Enhance pill is hidden.
"""

import argparse
import datetime as dt
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WANT_ENGINE = "kokon-992-dfaab76"
CLIENT = "enhancer-check"
T2I_PROMPT = "un gatto rosso che dorme su un davanzale, foto"
EDIT_PROMPT = "rendi il gatto nero e aggiungi un vaso di basilico accanto"


# ---------------------------------------------------------------------------------------
# Kokon folders (same rules as crates/qls-core/src/config.rs)
# ---------------------------------------------------------------------------------------

def data_dir():
    if os.environ.get("QLS_DATA_DIR"):
        return Path(os.environ["QLS_DATA_DIR"])
    home = Path.home()
    if sys.platform == "win32":
        return Path(os.environ["LOCALAPPDATA"]) / "KokonData"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "KokonData"
    return Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share") / "KokonData"


def config_dir():
    if os.environ.get("QLS_CONFIG_DIR"):
        return Path(os.environ["QLS_CONFIG_DIR"])
    home = Path.home()
    if sys.platform == "win32":
        return Path(os.environ["APPDATA"]) / "Kokon"
    if sys.platform == "darwin":
        return home / "Library" / "Application Support" / "Kokon"
    return Path(os.environ.get("XDG_CONFIG_HOME") or home / ".config") / "Kokon"


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


# ---------------------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------------------

class Api:
    def __init__(self, port, token):
        self.base = "http://127.0.0.1:%d/api/v1" % port
        self.token = token

    def call(self, method, path, body=None, timeout=60):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.token)
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read() or b"null")
        except urllib.error.HTTPError as e:
            raise RuntimeError("%s %s -> %s: %s" % (method, path, e.code, e.read().decode(errors="replace")[:600]))

    def get(self, path, timeout=60):
        return self.call("GET", path, timeout=timeout)

    def post(self, path, body=None, timeout=60):
        return self.call("POST", path, {} if body is None else body, timeout=timeout)


def connect(ddir, wait_s=0):
    info_path = ddir / "service.json"
    deadline = time.time() + wait_s
    while True:
        try:
            info = json.loads(info_path.read_text(encoding="utf-8-sig"))
            api = Api(info["port"], info["token"])
            api.get("/status", timeout=5)
            return api
        except Exception as e:
            if time.time() >= deadline:
                raise SystemExit("Kokon's service is not reachable (%s: %s). Open Kokon first." % (info_path, e))
            time.sleep(0.5)


# ---------------------------------------------------------------------------------------
# Memory sampler: whole GPU (nvidia-smi) and sd-server's process footprint (macOS) / RSS
# ---------------------------------------------------------------------------------------

def nvidia_used_mib():
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=memory.used", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5).stdout
        return int(out.strip().splitlines()[0])
    except Exception:
        return None


def process_mib(pid):
    if not pid or sys.platform == "win32":
        return None
    if sys.platform == "darwin" and shutil.which("footprint"):
        # phys_footprint counts Metal (unified) allocations too, unlike RSS.
        try:
            out = subprocess.run(["footprint", "-p", str(pid)], capture_output=True, text=True, timeout=10).stdout
            m = re.search(r"Footprint:\s*([\d.]+)\s*(KB|MB|GB)", out)
            if m:
                return float(m.group(1)) * {"KB": 1 / 1024, "MB": 1, "GB": 1024}[m.group(2)]
        except Exception:
            pass
    try:
        out = subprocess.run(["ps", "-o", "rss=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
        return int(out.strip()) / 1024
    except Exception:
        return None


class Sampler:
    def __init__(self, pid_fn):
        self.pid_fn = pid_fn
        self.has_gpu = nvidia_used_mib() is not None
        self.lock = threading.Lock()
        self.gpu_peak = None
        self.proc_peak = None
        self.stop = False
        threading.Thread(target=self.run, daemon=True).start()

    def run(self):
        while not self.stop:
            g = nvidia_used_mib() if self.has_gpu else None
            p = process_mib(self.pid_fn())
            with self.lock:
                if g is not None:
                    self.gpu_peak = max(self.gpu_peak or 0, g)
                if p is not None:
                    self.proc_peak = max(self.proc_peak or 0, p)
            time.sleep(0.5)

    def reset(self):
        with self.lock:
            self.gpu_peak = nvidia_used_mib() if self.has_gpu else None
            self.proc_peak = None

    def peaks(self):
        with self.lock:
            return self.gpu_peak, self.proc_peak


# ---------------------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------------------

class LogReader:
    """New lines of the service log since the last call."""

    def __init__(self, path):
        self.path = path
        self.pos = path.stat().st_size if path.exists() else 0

    def new_lines(self):
        if not self.path.exists():
            return []
        with open(self.path, "rb") as f:
            f.seek(self.pos)
            data = f.read()
            self.pos += len(data)
        return data.decode(errors="replace").splitlines()


def run_job(api, sampler, log, name, request, timeout_s):
    print("  %-22s ..." % name, end="", flush=True)
    log.new_lines()
    sampler.reset()
    t0 = time.time()
    job = api.post("/jobs", dict(request, client=CLIENT))
    partials = set()
    statuses = []
    while not job["status"] in ("done", "failed", "cancelled"):
        if time.time() - t0 > timeout_s:
            api.post("/jobs/%s/cancel" % job["id"])
            raise SystemExit("\n%s took more than %d s; cancelled." % (name, timeout_s))
        time.sleep(0.15)
        job = api.get("/jobs/" + job["id"])
        if not statuses or statuses[-1] != job["status"]:
            statuses.append(job["status"])
        if job["status"] == "enhancing_prompt" and job.get("enhanced_prompt"):
            partials.add(len(job["enhanced_prompt"]))
    wall = time.time() - t0
    gpu, proc = sampler.peaks()
    enh = None
    for line in log.new_lines():
        m = re.search(r"prompt enhancer: (\d+) tokens in ([\d.]+) s", line)
        if m:
            enh = (int(m.group(1)), float(m.group(2)))
    rec = job["results"][0] if job.get("results") else None
    r = {
        "name": name,
        "status": job["status"],
        "wall_s": round(wall, 1),
        "duration_s": round(rec["duration_ms"] / 1000, 1) if rec else None,
        "enhancer_tokens": enh[0] if enh else None,
        "enhancer_s": enh[1] if enh else None,
        "live_updates": len(partials),
        "statuses": statuses,
        "gpu_peak_mib": gpu,
        "proc_peak_mib": round(proc) if proc else None,
        "notes": job.get("notes") or [],
        "error": job.get("error"),
        "record_id": rec["id"] if rec else None,
        "record_prompt": rec["prompt"] if rec else None,
        "record_original_prompt": rec.get("original_prompt") if rec else None,
        "job_enhanced_prompt": job.get("enhanced_prompt"),
        "size": "%dx%d" % (rec["width"], rec["height"]) if rec else None,
    }
    extra = " enhancer %d tok / %.1f s" % enh if enh else ""
    print(" %s in %.1f s%s" % (job["status"], wall, extra))
    if job["status"] != "done":
        print("    error: %s" % json.dumps(job.get("error"))[:600])
    return r


# ---------------------------------------------------------------------------------------
# Isolated service for the 8 GB emulation
# ---------------------------------------------------------------------------------------

def any_sd_server_running():
    if sys.platform == "win32":
        out = subprocess.run(["tasklist", "/fi", "imagename eq sd-server.exe", "/fo", "csv", "/nh"], capture_output=True, text=True).stdout
        return "sd-server.exe" in out
    return subprocess.run(["pgrep", "-x", "sd-server"], capture_output=True).returncode == 0


def start_isolated(card_mib, out, reserve_gib=1.0, cuda_eager=False):
    if any_sd_server_running():
        raise SystemExit("sd-server is running. Close Kokon (and any sd-server) first: the GPU must be free.")
    exe = ROOT / "target" / "debug" / ("kokon-service.exe" if sys.platform == "win32" else "kokon-service")
    if not exe.exists():
        raise SystemExit("Build the service first: cargo build -p qls-service")
    real = json.loads((config_dir() / "config.json").read_text(encoding="utf-8-sig"))
    iso = out / "isolated"
    cdir, ddir, odir = iso / "config", iso / "data", iso / "output"
    for d in (cdir, ddir, odir):
        d.mkdir(parents=True, exist_ok=True)
    svc_port, srv_port = free_port(), free_port()
    sdcpp = real.get("sdcppDir") or str(data_dir() / "sdcpp")

    procs = []
    blog = open(iso / "ballast.log", "w")
    ballast = subprocess.Popen([sys.executable, "-I", str(ROOT / "scripts" / "dev" / "vram-ballast.py"), "--card-mib", str(card_mib), "--sdcpp", sdcpp],
                               stdout=blog, stderr=subprocess.STDOUT)
    procs.append(ballast)
    for _ in range(80):
        time.sleep(0.25)
        if "Holding" in (iso / "ballast.log").read_text(errors="replace") or ballast.poll() is not None:
            break
    if ballast.poll() is not None or "Holding" not in (iso / "ballast.log").read_text(errors="replace"):
        raise SystemExit("VRAM ballast failed:\n" + (iso / "ballast.log").read_text(errors="replace"))
    held = (iso / "ballast.log").read_text(errors="replace").splitlines()[0]
    print(held)
    # On Windows sd-server's own free-VRAM query does not see the ballast (it reported ~14.7 of
    # 16 GiB free beside it), so its automatic budget (--max-vram -1) would overcommit and spill.
    # Give it what a real card of this size detects: free VRAM now minus the same 1 GiB reserve.
    free = int(re.search(r"(\d+) MiB free now", held).group(1))
    budget_gib = round((free - reserve_gib * 1024) / 1024, 2)
    cfg = dict(real)
    cfg.update({"servicePort": svc_port, "serverPort": srv_port, "outputDir": str(odir), "sdcppDir": sdcpp,
                "hardwarePreset": "8gb", "vramOverrideMib": card_mib, "setupComplete": True,
                "vramReserveGib": 0, "extraServerArgs": list(real.get("extraServerArgs") or []) + ["--max-vram", str(budget_gib)]})
    (cdir / "config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")
    print("sd-server budget: --max-vram %s GiB (%d MiB free with the ballast, minus %s GiB)" % (budget_gib, free, reserve_gib))

    env = dict(os.environ, QLS_DATA_DIR=str(ddir), QLS_CONFIG_DIR=str(cdir))
    if cuda_eager:
        # Experiment: load every CUDA kernel at start instead of on first use (sd-server inherits it).
        env["CUDA_MODULE_LOADING"] = "EAGER"
    svc = subprocess.Popen([str(exe), "--port", str(svc_port), "--persistent"], env=env,
                           stdout=open(iso / "service.out", "w"), stderr=subprocess.STDOUT)
    procs.append(svc)
    os.environ["QLS_DATA_DIR"] = str(ddir)
    return procs, ddir


# ---------------------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------------------

def system_info():
    info = {"platform": platform.platform(), "machine": platform.machine(), "python": platform.python_version()}
    if shutil.which("nvidia-smi"):
        info["gpu"] = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
                                     capture_output=True, text=True).stdout.strip()
    if sys.platform == "darwin":
        info["cpu"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"], capture_output=True, text=True).stdout.strip()
        info["memory_gb"] = int(subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout) // 2**30
    elif sys.platform.startswith("linux"):
        try:
            kb = int(re.search(r"MemTotal:\s+(\d+)", Path("/proc/meminfo").read_text()).group(1))
            info["memory_gb"] = round(kb / 2**20)
        except Exception:
            pass
    return info


def engine_markers(sdcpp):
    found = []
    for p in Path(sdcpp).glob("**/kokon-engine.txt"):
        if "models" not in p.parts:
            found.append("%s: %s" % (p.parent.name, p.read_text().strip()))
    return found


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--card-mib", type=int, help="emulate a card with this much VRAM (8 GB: 8188); NVIDIA, Kokon closed")
    ap.add_argument("--reserve-gib", type=float, default=1.0, help="with --card-mib: VRAM left out of sd-server's budget (sd-server's own default: 1)")
    ap.add_argument("--cuda-eager", action="store_true", help="with --card-mib: CUDA_MODULE_LOADING=EAGER for sd-server (experiment)")
    ap.add_argument("--expect-no-enhancer", action="store_true", help="fallback check on an engine without text generation")
    ap.add_argument("--quick", action="store_true", help="2 images only (text-to-image and edit, enhancer on): for slow Macs")
    ap.add_argument("--quality", default="fast", choices=["fast", "balanced", "quality"])
    ap.add_argument("--timeout", type=int, default=1800, help="seconds per job (Macs are slow)")
    ap.add_argument("--out", help="results folder (default: Desktop or home / kokon-enhancer-check / <timestamp>)")
    a = ap.parse_args()

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    base = Path(a.out) if a.out else ((Path.home() / "Desktop") if (Path.home() / "Desktop").is_dir() else Path.home()) / "kokon-enhancer-check"
    out = base / stamp
    out.mkdir(parents=True, exist_ok=False)
    print("Results: %s" % out)

    procs = []
    try:
        if a.card_mib:
            procs, ddir = start_isolated(a.card_mib, out, a.reserve_gib, a.cuda_eager)
            api = connect(ddir, wait_s=30)
        else:
            ddir = data_dir()
            api = connect(ddir)
        checks = []

        def check(name, ok, detail=""):
            checks.append((name, bool(ok), detail))
            print("  [%s] %s %s" % ("PASS" if ok else "FAIL", name, detail))

        cfg = api.get("/config")
        sdcpp = cfg.get("sdcppDir") or cfg.get("sdcpp_dir") or str(ddir / "sdcpp")
        st = api.get("/status")
        print("\n1. Engine")
        release = st["engine"]["release"]
        markers = engine_markers(sdcpp)
        if st["engine"]["update_needed"]:
            check("engine installed = %s" % release, False, "update needed: open Kokon, accept the engine update (What's New / Setup), run again")
            raise SystemExit(1)
        check("app wants %s" % WANT_ENGINE, release == WANT_ENGINE, "(app: %s)" % release)
        check("engine folder marked %s" % WANT_ENGINE, any(WANT_ENGINE in m for m in markers), "; ".join(markers) or "no marker found")

        print("\n2. Inference server (first start loads the models: minutes on a Mac)")
        t0 = time.time()
        api.post("/backend/start", timeout=1800)
        st = api.get("/status")
        srv = st["server"]
        print("  ready in %.0f s, model %s, port %s" % (time.time() - t0, srv.get("model"), srv.get("port")))
        tg = srv.get("text_generation")
        if a.expect_no_enhancer:
            check("status.server.text_generation is false", tg is False, "(%r)" % tg)
        else:
            check("status.server.text_generation is true", tg is True, "(%r)" % tg)
            if tg is not True:
                raise SystemExit(1)

        sampler = Sampler(lambda: (api.get("/status").get("server") or {}).get("pid"))
        log = LogReader(ddir / "logs" / "service.log")
        q = a.quality
        t2i = {"prompt": T2I_PROMPT, "mode": "generate", "quality": q, "aspect_ratio": "1:1"}
        results = []

        print("\n3. Jobs (quality %s)" % q)
        if a.expect_no_enhancer:
            r = run_job(api, sampler, log, "t2i enhance=on", dict(t2i, seed=102, enhance=True), a.timeout)
            results.append(r)
            check("job finished", r["status"] == "done", r["status"])
            check("note says the engine has no enhancer", any("no prompt enhancer" in n for n in r["notes"]), "; ".join(r["notes"]))
            check("record keeps the user's prompt, no original_prompt", r["record_prompt"] == T2I_PROMPT and not r["record_original_prompt"])
        elif a.quick:
            on = run_job(api, sampler, log, "t2i on", dict(t2i, seed=102, enhance=True), a.timeout)
            edit = {"prompt": EDIT_PROMPT, "mode": "edit", "quality": q, "images": ["gen:%s" % on["record_id"]]}
            eon = run_job(api, sampler, log, "edit on", dict(edit, seed=7, enhance=True), a.timeout)
            results += [on, eon]
            print("\n4. Checks")
            enhancer_checks(check, results, (on, eon))
        else:
            results.append(run_job(api, sampler, log, "warm-up (not counted)", dict(t2i, seed=100), a.timeout))
            results.append(run_job(api, sampler, log, "t2i enhance first use", dict(t2i, seed=101, enhance=True), a.timeout))
            off = run_job(api, sampler, log, "t2i off", dict(t2i, seed=102), a.timeout)
            on = run_job(api, sampler, log, "t2i on", dict(t2i, seed=102, enhance=True), a.timeout)
            results += [off, on]
            src = "gen:%s" % off["record_id"]
            edit = {"prompt": EDIT_PROMPT, "mode": "edit", "quality": q, "images": [src]}
            eoff = run_job(api, sampler, log, "edit off", dict(edit, seed=7), a.timeout)
            eon = run_job(api, sampler, log, "edit on", dict(edit, seed=7, enhance=True), a.timeout)
            results += [eoff, eon]

            print("\n4. Checks")
            enhancer_checks(check, results, (results[1], on, eon))
            for r in (off, eoff):
                check("%s: no original_prompt (enhancer off)" % r["name"], not r["record_original_prompt"])

        (out / "results.json").write_text(json.dumps({"system": system_info(), "engine": release, "markers": markers,
                                                       "status_server": srv, "checks": checks, "jobs": results}, indent=2), encoding="utf-8")
        write_report(out, a, system_info(), release, markers, srv, checks, results)
        failed = [c for c in checks if not c[1]]
        print("\n%d checks, %d failed. Report: %s" % (len(checks), len(failed), out / "report.md"))
        sampler.stop = True
    finally:
        for p in reversed(procs):
            if p.poll() is None:
                p.kill()
        if procs:
            # The isolated service's sd-server outlives the service when killed: stop it too.
            if sys.platform == "win32":
                subprocess.run(["taskkill", "/f", "/im", "sd-server.exe"], capture_output=True)
            else:
                subprocess.run(["pkill", "-x", "sd-server"], capture_output=True)


def enhancer_checks(check, results, enhanced):
    for r in results:
        check("%s finished" % r["name"], r["status"] == "done", r["status"])
    for r in enhanced:
        n = r["name"]
        check("%s: enhancing_prompt stage seen" % n, "enhancing_prompt" in r["statuses"], "->".join(r["statuses"]))
        check("%s: live text (>= 3 partial updates)" % n, r["live_updates"] >= 3, "%d updates" % r["live_updates"])
        check("%s: record has original + expanded prompt" % n,
              r["record_original_prompt"] == (EDIT_PROMPT if n.startswith("edit") else T2I_PROMPT)
              and r["record_prompt"] and r["record_prompt"] != r["record_original_prompt"])
        check("%s: no enhancer failure note" % n, not any("enhancer" in x for x in r["notes"]), "; ".join(r["notes"]))


def write_report(out, a, sysinfo, release, markers, srv, checks, results):
    L = ["# Prompt enhancer check %s" % out.name, ""]
    L += ["- System: %s" % ", ".join("%s %s" % (k, v) for k, v in sysinfo.items())]
    if a.card_mib:
        L += ["- Emulated card: %d MiB (VRAM ballast + 8gb preset + --max-vram = free - %s GiB%s, isolated service)" % (a.card_mib, a.reserve_gib, ", CUDA_MODULE_LOADING=EAGER" if a.cuda_eager else "")]
    L += ["- Engine: %s; markers: %s" % (release, "; ".join(markers) or "none"),
          "- Server: model %s, text_generation %s" % (srv.get("model"), srv.get("text_generation")),
          "- Quality: %s" % a.quality, ""]
    L += ["## Checks", ""] + ["- %s %s %s" % ("PASS" if ok else "**FAIL**", n, d) for n, ok, d in checks] + [""]
    L += ["## Jobs", "",
          "| Job | Status | Wall s | Image s | Enhancer tok | Enhancer s | tok/s | Live updates | Peak GPU MiB (whole GPU) | Peak sd-server MiB | Size |",
          "|---|---|---|---|---|---|---|---|---|---|---|"]
    for r in results:
        tps = "%.0f" % (r["enhancer_tokens"] / r["enhancer_s"]) if r["enhancer_s"] else ""
        L.append("| %s | %s | %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
            r["name"], r["status"], r["wall_s"], r["duration_s"] or "", r["enhancer_tokens"] or "", r["enhancer_s"] or "",
            tps, r["live_updates"], r["gpu_peak_mib"] or "", r["proc_peak_mib"] or "", r["size"] or ""))
    by = {r["name"]: r for r in results}
    if "t2i off" in by:
        L += ["", "Added by the enhancer (same seed, wall time): text-to-image %+.1f s, edit %+.1f s." % (
            by["t2i on"]["wall_s"] - by["t2i off"]["wall_s"], by["edit on"]["wall_s"] - by["edit off"]["wall_s"])]
    L += ["", "## Prompts", ""]
    for r in results:
        if r["record_original_prompt"] or r["job_enhanced_prompt"]:
            L += ["**%s**" % r["name"], "", "- user: %s" % r["record_original_prompt"], "- sent to the model: %s" % r["record_prompt"], ""]
        if r["notes"]:
            L += ["- notes (%s): %s" % (r["name"], "; ".join(r["notes"])), ""]
    (out / "report.md").write_text("\n".join(L) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
