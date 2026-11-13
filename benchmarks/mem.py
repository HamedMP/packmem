"""Process memory in MB on Linux and macOS.

resident():  resident set size now.
footprint(): macOS physical footprint (what Activity Monitor shows; counts compressed
             pages, which resident size does not). Equals resident() on Linux.
peak():      lifetime peak of the same measure footprint() reports.
"""
import ctypes, resource, sys

MAC = sys.platform == "darwin"

if MAC:
    _libproc = ctypes.CDLL("/usr/lib/libproc.dylib")
    _RUSAGE_INFO_V4 = 4
    # struct rusage_info_v4: 16-byte uuid, then uint64 fields
    _RESIDENT, _FOOTPRINT, _PEAK_FOOTPRINT, _NFIELDS = 6, 7, 28, 35

    def _info(pid):
        buf = (ctypes.c_uint64 * (2 + _NFIELDS))()
        if _libproc.proc_pid_rusage(pid, _RUSAGE_INFO_V4, ctypes.byref(buf)) != 0:
            raise OSError("proc_pid_rusage failed")
        return buf[2:]

    def resident(pid=None): return _info(pid or _pid())[_RESIDENT] / 1e6
    def footprint(pid=None): return _info(pid or _pid())[_FOOTPRINT] / 1e6
    def peak(): return _info(_pid())[_PEAK_FOOTPRINT] / 1e6
    def child_peak(): return resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1e6
else:
    def resident(pid=None): return int(open(f"/proc/{pid or 'self'}/statm").read().split()[1]) * 4096 / 1e6
    footprint = resident
    def peak(): return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e3
    def child_peak(): return resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1e3


def _pid():
    import os
    return os.getpid()
