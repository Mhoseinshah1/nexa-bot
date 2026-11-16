#!/usr/bin/env python3
"""Linux: sample a command's process-session RSS every 100 ms; retain its exit status.

Usage: python3 scripts/claude/measure-rss.py /tmp/build -- pnpm build
Writes /tmp/build.log and /tmp/build.json. RSS sums include shared pages per process.
"""

import json
import os
from pathlib import Path
import subprocess
import sys
import time

output = Path(sys.argv[1])
command = sys.argv[2:]
if command[:1] == ["--"]:
    command = command[1:]
output.parent.mkdir(parents=True, exist_ok=True)
with output.with_suffix(".log").open("w") as log:
    child = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
    peak = 0
    largest = 0
    while child.poll() is None:
        total = 0
        for stat in Path("/proc").glob("[0-9]*/stat"):
            try:
                fields = stat.read_text().rsplit(") ", 1)[1].split()
                if int(fields[3]) != child.pid:
                    continue
                rss = int(fields[21]) * os.sysconf("SC_PAGE_SIZE")
                total += rss
                largest = max(largest, rss)
            except (OSError, ValueError, IndexError):
                continue  # A process may exit while /proc is being sampled.
        peak = max(peak, total)
        time.sleep(0.1)
    result = {"exit": child.returncode, "sampledPeakAggregateRSSMiB": round(peak / 1048576, 1),
              "sampledLargestProcessRSSMiB": round(largest / 1048576, 1)}
    output.with_suffix(".json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    sys.exit(child.returncode if child.returncode >= 0 else 128 - child.returncode)
