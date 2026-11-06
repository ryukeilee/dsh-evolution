#!/usr/bin/env python3
"""Out-of-process resident-set sampler for retention-plan-streaming.mjs.

The measured window in that benchmark is one synchronous `compact()` call in a
fresh child Node process, so an in-process timer cannot observe it: section 4.3
of docs/performance/retention-plan-cost.md records 0 interval callbacks in all
72 in-process probes and all 36 out-of-process probes. This helper is started by
the benchmark parent *after* the child reports START (the child is then blocked
on stdin) and before the parent tells the child to go. RSS is therefore read
from outside the measured process, by a process that shares no event loop with
it:

  - macOS: libproc.proc_pidinfo(PROC_PIDTASKINFO).pti_resident_size via ctypes;
  - Linux: resident pages from /proc/<pid>/statm times the page size.

Protocol (all stdin commands are single lines; stdout carries one JSON line per
phase):

  1. on start the sampler takes one baseline sample and prints
     {"ready": true, "samplerPid": ..., "baselineBytes": ...};
  2. the parent sends "go\n", then samples every --interval-ms;
  3. the parent sends "stop\n" after the child reports END; the sampler prints
     {"sampleCount", "baselineBytes", "peakBytes", "deltaBytes", "maxGapMs",
      "firstSampleMs", "lastSampleMs", "error"} and exits;
  4. if the target process disappears (ESRCH / short statm) the sampler stops,
     reports the error string and exits 0 so the parent can still use the
     samples taken so far.

This is still a sampling lower bound: a peak shorter than the sampling interval
can be missed. The maximum observed gap is reported with every sample.
"""

import argparse
import ctypes
import json
import os
import sys
import threading
import time

PROC_PIDTASKINFO = 4
TASKINFO_SIZE = 96
PTI_RESIDENT_SIZE_OFFSET = 8


def macos_reader():
    lib = ctypes.CDLL("/usr/lib/libproc.dylib")

    def read(pid):
        buffer = ctypes.create_string_buffer(TASKINFO_SIZE)
        written = lib.proc_pidinfo(int(pid), PROC_PIDTASKINFO, 0, buffer, TASKINFO_SIZE)
        if written != TASKINFO_SIZE:
            raise RuntimeError(f"proc_pidinfo returned {written} for pid {pid}")
        return ctypes.c_uint64.from_buffer(buffer, PTI_RESIDENT_SIZE_OFFSET).value

    return read


def linux_reader():
    page_size = os.sysconf("SC_PAGE_SIZE")

    def read(pid):
        with open(f"/proc/{int(pid)}/statm", "r", encoding="ascii") as handle:
            fields = handle.read().split()
        if len(fields) < 2:
            raise RuntimeError(f"short /proc/{pid}/statm")
        return int(fields[1]) * page_size

    return read


def make_reader():
    platform_name = sys.platform
    if platform_name == "darwin":
        return "darwin-libproc-proc_pidinfo", macos_reader()
    if platform_name.startswith("linux"):
        return "linux-proc-statm", linux_reader()
    raise RuntimeError(f"unsupported platform for out-of-process RSS sampling: {platform_name}")


def main():
    parser = argparse.ArgumentParser(description="sample a child process' RSS from outside its event loop")
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--interval-ms", type=float, default=2.0)
    parser.add_argument("--stop-timeout-seconds", type=float, default=900.0)
    args = parser.parse_args()
    interval = max(0.2, float(args.interval_ms)) / 1000.0
    method, read_rss = make_reader()
    pid = int(args.pid)

    go_event = threading.Event()
    stop_event = threading.Event()
    clock = {"go": None}

    def commands():
        try:
            for line in sys.stdin:
                command = line.strip()
                if command == "go":
                    clock["go"] = time.monotonic()
                    go_event.set()
                elif command == "stop":
                    break
        except Exception:  # noqa: BLE001 - stdin errors must not leave the sampler stuck
            pass
        stop_event.set()

    threading.Thread(target=commands, daemon=True).start()

    try:
        baseline = read_rss(pid)
    except Exception as error:  # noqa: BLE001
        sys.stdout.write(json.dumps({"ready": False, "method": method, "error": str(error)}) + "\n")
        sys.stdout.flush()
        return 0

    sys.stdout.write(json.dumps({"ready": True, "method": method, "samplerPid": os.getpid(), "baselineBytes": baseline}) + "\n")
    sys.stdout.flush()

    if not go_event.wait(timeout=args.stop_timeout_seconds):
        sys.stdout.write(json.dumps({"sampleCount": 0, "baselineBytes": baseline, "peakBytes": baseline,
                                     "deltaBytes": 0, "maxGapMs": 0.0, "firstSampleMs": None,
                                     "lastSampleMs": None, "method": method,
                                     "error": "no go command received"}) + "\n")
        sys.stdout.flush()
        return 0

    go_at = clock["go"]
    values = []
    times = []
    error = None
    deadline = go_at + args.stop_timeout_seconds
    while not stop_event.is_set():
        now = time.monotonic()
        if now > deadline:
            error = f"sampler deadline {args.stop_timeout_seconds}s exceeded"
            break
        try:
            value = read_rss(pid)
        except Exception as failure:  # noqa: BLE001 - target exited or became unreadable
            error = str(failure)
            break
        values.append(value)
        times.append(time.monotonic() - go_at)
        target = go_at + len(values) * interval
        delay = target - time.monotonic()
        if delay > 0:
            time.sleep(delay)

    # `times` is kept in seconds relative to the go timestamp (the sampler's
    # internal unit); the JSON fields are milliseconds, so convert on output.
    gaps = [(later - earlier) * 1000.0 for earlier, later in zip(times, times[1:])]
    peak = max(values) if values else baseline
    result = {
        "method": method,
        "baselineBytes": baseline,
        "sampleCount": len(values),
        "peakBytes": peak,
        "deltaBytes": peak - baseline,
        "maxGapMs": max(gaps) if gaps else 0.0,
        "firstSampleMs": times[0] * 1000.0 if times else None,
        "lastSampleMs": times[-1] * 1000.0 if times else None,
        "intervalMs": args.interval_ms,
        "error": error,
    }
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
