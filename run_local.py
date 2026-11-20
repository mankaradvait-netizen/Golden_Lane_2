#!/usr/bin/env python3
"""
Golden Lane EMS — Local Full-Stack Orchestrator
Starts both the FastAPI backend and React Vite frontend connected together.
"""
import os
import sys
import time
import signal
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FRONTEND_DIR = ROOT / "frontend"


def main():
    print("=" * 60)
    print("  Golden Lane EMS — Starting Full-Stack Services")
    print("=" * 60)
    print("Backend API:       http://localhost:8000")
    print("API Documentation: http://localhost:8000/docs")
    print("Frontend UI:       http://localhost:5173")
    print("-" * 60)
    print("Demo Credentials (password: demo1234 for all):")
    print("  - Patient:   9820112233")
    print("  - EMT:       AMB-108")
    print("  - Hospital:  HOSP-01")
    print("=" * 60)
    print("Starting backend (uvicorn)...")

    env = os.environ.copy()
    backend_proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "backend.app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            "8000",
        ],
        cwd=str(ROOT),
        env=env,
    )

    # Allow backend 1.5s to initialize
    time.sleep(1.5)

    print("Starting frontend (vite dev)...")
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
    frontend_proc = subprocess.Popen(
        [npm_cmd, "run", "dev", "--", "--host", "127.0.0.1", "--port", "5173"],
        cwd=str(FRONTEND_DIR),
        env=env,
    )

    def shutdown(signum=None, frame=None):
        print("\n[Golden Lane] Shutting down services...")
        try:
            frontend_proc.terminate()
            backend_proc.terminate()
        except Exception:
            pass
        sys.exit(0)

    signal.signal(signal.SIGINT, shutdown)
    signal.signal(signal.SIGTERM, shutdown)

    try:
        while True:
            b_code = backend_proc.poll()
            f_code = frontend_proc.poll()
            if b_code is not None:
                print(f"[Golden Lane] Backend exited with code {b_code}")
                frontend_proc.terminate()
                break
            if f_code is not None:
                print(f"[Golden Lane] Frontend exited with code {f_code}")
                backend_proc.terminate()
                break
            time.sleep(0.5)
    except KeyboardInterrupt:
        shutdown()


if __name__ == "__main__":
    main()
