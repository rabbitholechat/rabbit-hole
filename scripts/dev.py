"""Keep dev servers in a single process group controlled by this launcher."""
import subprocess
import time

processes = []
try:
    processes.append(subprocess.Popen(["make", "backend"]))
    processes.append(subprocess.Popen(["make", "frontend"]))
    while all(p.poll() is None for p in processes):
        time.sleep(0.5)
except KeyboardInterrupt:
    pass
finally:
    for process in processes:
        process.terminate()
    for process in processes:
        process.wait()
