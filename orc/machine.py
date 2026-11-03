"""Machine load for the task start gate: load average and free memory (macOS).

No new dependencies: load comes from os.getloadavg, memory from `sysctl kern.memorystatus_level`
(percent of available memory, which macOS also uses to compute memory pressure). If there is nothing to measure with,
we consider the machine free: better to start a task than to silently stall forever.
"""
from __future__ import annotations

import os
import subprocess
import sys
from dataclasses import dataclass


@dataclass(frozen=True)
class MachineLoad:
    load1: float | None       # load average over one minute
    cpus: int
    free_mem_pct: int | None  # 0-100; None means unknown (not macOS or sysctl did not answer)


def sample() -> MachineLoad:
    try:
        load1: float | None = os.getloadavg()[0]
    except OSError:
        load1 = None
    free: int | None = None
    if sys.platform == "darwin":
        try:
            out = subprocess.run(["sysctl", "-n", "kern.memorystatus_level"],
                                 capture_output=True, text=True, timeout=2)
            value = int(out.stdout.strip()) if out.returncode == 0 else None
            free = value if value is not None and 0 <= value <= 100 else None
        except (OSError, ValueError, subprocess.TimeoutExpired):
            free = None
    return MachineLoad(load1, os.cpu_count() or 1, free)


def busy_check(m: MachineLoad, max_load_pct: int, min_free_mem_pct: int) -> tuple[str, str] | None:
    """(kind, text) of the reason why a start is not allowed; None means it is allowed. Kind is "load" or "mem":
    it is stable between measurements, unlike text with live numbers. A threshold of 0 disables the check."""
    if max_load_pct > 0 and m.load1 is not None and m.load1 > m.cpus * max_load_pct / 100:
        return "load", f"load {m.load1:.1f} with {m.cpus} cores (threshold {max_load_pct}%)"
    if min_free_mem_pct > 0 and m.free_mem_pct is not None and m.free_mem_pct < min_free_mem_pct:
        return "mem", f"free memory: {m.free_mem_pct}% (threshold {min_free_mem_pct}%)"
    return None


def busy_reason(m: MachineLoad, max_load_pct: int, min_free_mem_pct: int) -> str | None:
    """Reason text from busy_check; None means a start is allowed."""
    found = busy_check(m, max_load_pct, min_free_mem_pct)
    return found[1] if found else None
