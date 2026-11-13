import ctypes, os
_lib = ctypes.CDLL("/usr/lib/libproc.dylib")
class RU(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in (
        "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size", "resident_size",
        "phys_footprint", "proc_start_abstime", "proc_exit_abstime", "child_user_time", "child_system_time",
        "child_pkg_idle_wkups", "child_interrupt_wkups", "child_pageins", "child_elapsed_abstime", "diskio_bytesread",
        "diskio_byteswritten", "cpu_time_qos_default", "cpu_time_qos_maintenance", "cpu_time_qos_background",
        "cpu_time_qos_utility", "cpu_time_qos_legacy", "cpu_time_qos_user_initiated", "cpu_time_qos_user_interactive",
        "billed_system_time", "serviced_system_time", "logical_writes", "lifetime_max_phys_footprint", "instructions", "cycles", "billed_energy", "serviced_energy", "interval_max_phys_footprint", "runnable_time", "pad0", "pad1", "pad2", "pad3", "pad4", "pad5", "pad6", "pad7")]
def footprint(pid=None):
    """(current, lifetime max) phys_footprint in MB, the figure Activity Monitor shows as Memory."""
    ru = RU()
    _lib.proc_pid_rusage(pid or os.getpid(), 4, ctypes.byref(ru))
    return ru.phys_footprint / 2**20, ru.lifetime_max_phys_footprint / 2**20
