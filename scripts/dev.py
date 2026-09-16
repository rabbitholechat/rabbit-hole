"""Start both servers and terminate their complete process groups on exit."""
import os
import signal
import subprocess
import sys
import time

processes = []


def stop(_signum, _frame):
    raise KeyboardInterrupt


signal.signal(signal.SIGTERM, stop)
try:
    processes.append(subprocess.Popen(['make', 'backend'], start_new_session=True))
    processes.append(subprocess.Popen(['make', 'frontend'], start_new_session=True))
    while all(p.poll() is None for p in processes):
        time.sleep(0.5)
except KeyboardInterrupt:
    pass
finally:
    for process in processes:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    for process in processes:
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
    sys.exit(0)
