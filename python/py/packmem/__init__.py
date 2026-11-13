"""packmem: a list of dicts that takes a fraction of the memory.

    rows = [json.loads(line) for line in f]      # before
    rows = packmem.load_jsonl(f)                 # after

`rows` still supports len(), indexing, slicing, iteration, append, extend and item
assignment, and adds filters and aggregates that run on the packed data:

    rows.where(status=404, ua__contains="curl").sum("bytes")
"""
import builtins as _builtins      # this module defines its own open()
import os as _os
from collections.abc import MutableSequence as _MutableSequence
from ._packmem import _Table, Selection, Row

__all__ = ["Table", "View", "Row", "load_jsonl", "load_json", "from_records", "from_cursor", "from_queryset", "read_csv", "open", "cleanup_stale"]
try:
    from importlib.metadata import version as _version
    __version__ = _version("packmem")
except Exception:  # running from a source tree without the package installed
    __version__ = "unknown"


def _restore(cls, data):
    t = cls.__new__(cls)
    t._t = _Table.from_bytes(data)
    t._share = None
    return t


def _attach(cls, path, size):
    t = cls.__new__(cls)
    try:
        t._t = _Table.attach(path, size)
    except FileNotFoundError:
        raise FileNotFoundError(f"packed table file {path} is gone: it was deleted, or the table that shared it was closed or its process ended") from None
    # this table reads the file in place; passing it on to another process sends the file's location again
    h = _Share()
    h.path, h.size, h.pid, h.release = path, size, None, _nothing
    t._share = h
    return t


def _nothing():
    pass


def open(path):
    """Open a table saved with `Table.save(path)`, read-only and without loading it.

    The file is memory-mapped and the packed columns are read in place: opening takes milliseconds whatever the
    size, pages are read from disk as they are touched, and every process that opens the same file shares them.
    Use `copy()` for a private table that can be changed. Do not truncate or rewrite the file while it is open.
    """
    path = _os.path.abspath(_os.fspath(path))
    return _attach(Table, path, _os.path.getsize(path))


class _Share:
    __slots__ = ("path", "size", "pid", "release", "__weakref__")


def _unlink(path, pid):
    # only the process that created the file removes it; forked children inherit the handle but must not
    if _os.getpid() == pid:
        try:
            _os.unlink(path)
        except OSError:
            pass


def _share_dir(dir=None):
    if dir is not None:
        return _os.fspath(dir)
    if _os.path.isdir("/dev/shm") and _os.access("/dev/shm", _os.W_OK):
        return "/dev/shm"
    import tempfile
    return tempfile.gettempdir()


def _alive(pid):
    if _os.name == "nt":
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)      # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        code = ctypes.c_ulong()
        ok = k.GetExitCodeProcess(h, ctypes.byref(code))
        k.CloseHandle(h)
        return bool(ok) and code.value == 259      # STILL_ACTIVE
    try:
        _os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def cleanup_stale(dir=None):
    """Remove shared-table files left behind by processes that no longer exist. Returns how many were removed.

    A table's file is normally removed when the table is unshared or garbage-collected; this is for crashes.
    """
    d, n = _share_dir(dir), 0
    for name in _os.listdir(d):
        parts = name.split("-")
        if len(parts) == 3 and parts[0] == "packmem" and name.endswith(".pkm") and parts[1].isdigit() and not _alive(int(parts[1])):
            try:
                _os.unlink(_os.path.join(d, name))
                n += 1
            except OSError:
                pass
    return n


def _json_chunks(n, batch, part):
    """Yield bytes that concatenate to one JSON array, `batch` rows at a time."""
    if n == 0:
        yield b"[]"
        return
    batch = max(1, batch)
    for a in range(0, n, batch):
        b = min(a + batch, n)
        yield (b"[" if a == 0 else b",") + part(a, b) + (b"]" if b == n else b"")


_OPS = ("prefix", "contains", "gte", "lte", "gt", "lt", "between")


def _select(t, filters, base=None):
    sel = base
    for key, value in filters.items():
        name, op = key, "eq"
        for o in _OPS:
            if key.endswith("__" + o):
                name, op = key[: -len(o) - 2], o
                break
        s = t.select(name, op, value)
        sel = s if sel is None else sel.intersect(s)
    return sel


class Table:
    """A mutable sequence of dict records stored as packed columns."""

    __slots__ = ("_t", "_share")

    def __init__(self, records=None, hint="balanced"):
        self._t = _Table(hint)
        self._share = None
        if records is not None:
            self._t.extend(records)

    # --- list-of-dicts behaviour ---
    def __len__(self):
        return len(self._t)

    def _idx(self, i):
        n = len(self._t)
        if i < 0:
            i += n
        if not 0 <= i < n:
            raise IndexError("row index out of range")
        return i

    def __getitem__(self, i):
        if isinstance(i, slice):
            return [self._t.row(j) for j in range(*i.indices(len(self._t)))]
        return self._t.row(self._idx(i))

    def __setitem__(self, i, row):
        self._t.set_row(self._idx(i), dict(row))

    def __iter__(self):
        n, step = len(self._t), 2048
        for a in range(0, n, step):
            yield from self._t.rows_range(a, min(a + step, n))

    def to_json(self):
        """All records as one JSON array, in bytes, written straight from the columns (no dict per record)."""
        return b"".join(self.iter_json(batch=1 << 16))

    def iter_json(self, batch=4096):
        """The same JSON array as `to_json`, yielded in chunks of `batch` records: suits streaming responses."""
        return _json_chunks(len(self._t), batch, self._t.json_range)

    def lazy(self):
        """Iterate records as `Row` objects that decode a field only when it is read.

        Use it for loops that touch a few fields per record: `for r in rows.lazy(): total += r["bytes"]`.
        A `Row` is a mapping, not a dict: `r["k"] = v` writes to the table, and `r.to_dict()` gives a real dict.
        """
        n, step = len(self._t), 2048
        for a in range(0, n, step):
            yield from self._t.rows_lazy(a, min(a + step, n))

    def __eq__(self, other):
        if isinstance(other, (Table, list)):
            return len(self) == len(other) and all(a == b for a, b in zip(self, other))
        return NotImplemented

    def __repr__(self):
        return f"<packmem.Table {len(self)} rows x {len(self.columns)} columns, {self.nbytes / 1e6:.1f} MB>"

    def append(self, row):
        self._t.append(row)

    def extend(self, rows):
        if isinstance(rows, Table):
            self._t.extend_table((rows.copy() if rows is self else rows)._t)
        else:
            self._t.extend(rows)

    def set_column(self, name, values):
        """Set one field on every record: `values` is a single value, or one value per record.

        Use this rather than updating row by row; it packs the column once.
        """
        if isinstance(values, (str, bytes, dict)) or not hasattr(values, "__iter__"):
            self._t.fill_column(name, values)
        else:
            self._t.set_column(name, values)

    def take(self, indices):
        """A new Table holding the rows at `indices`, in that order (rows may repeat)."""
        n = len(self._t)
        new = Table.__new__(Table)
        new._t = self._t.take([i + n if i < 0 else i for i in indices])
        new._share = None
        return new

    def copy(self):
        return self.take(range(len(self._t)))

    def shuffle(self, random=None):
        """Shuffle in place with one rebuild. `random.shuffle(table)` also works but rewrites two rows per swap."""
        import random as _random
        order = list(range(len(self._t)))
        (random or _random).shuffle(order)
        self._t.reorder(order)

    def __reduce__(self):
        # pickled as the packed columns themselves: unpickling copies them and re-encodes nothing
        # a subclass comes back as itself, with whatever it keeps in __dict__ or its own __slots__
        state = dict(getattr(self, "__dict__", ()))
        for klass in type(self).__mro__:
            slots = klass.__dict__.get("__slots__", ())
            for name in (slots,) if isinstance(slots, str) else slots:
                if name not in ("_t", "_share", "__dict__", "__weakref__") and hasattr(self, name):
                    state[name] = getattr(self, name)
        share = getattr(self, "_share", None)
        if share is not None:
            # a shared table pickles as a pointer to its file: a few hundred bytes, whatever its size
            return _attach, (type(self), share.path, share.size), state or None
        return _restore, (type(self), self._t.to_bytes()), state or None

    def share(self, dir=None):
        """Write the packed table once to a file and make this table read-only, so that pickling it sends only the
        file's location. Worker processes that unpickle it load from the file instead of receiving the data.

        The file goes to /dev/shm where that exists, otherwise the temp directory, or `dir`. It is removed by
        `unshare()`, or when this table is garbage-collected or its process exits normally; workers must attach
        before then. A process started later than that gets FileNotFoundError.
        """
        if getattr(self, "_share", None) is None:
            if self._t.frozen:
                raise TypeError("this table was loaded from another process's shared file; copy() it first")
            import secrets, weakref
            h = _Share()
            h.pid = _os.getpid()
            h.path = _os.path.join(_share_dir(dir), f"packmem-{h.pid}-{secrets.token_hex(8)}.pkm")
            h.size = self._t.write_file(h.path)
            h.release = weakref.finalize(h, _unlink, h.path, h.pid)
            self._t.set_frozen(True)
            self._share = h
        return self

    def save(self, path):
        """Write the packed table to `path`, to be reopened with `packmem.open(path)`.

        The file is written beside `path` and moved into place, so a reader never sees a partial file. The format
        belongs to this version of packmem.
        """
        import secrets
        path = _os.path.abspath(_os.fspath(path))
        tmp = f"{path}.{_os.getpid()}-{secrets.token_hex(4)}.tmp"
        try:
            self._t.write_file(tmp, False)
            _os.replace(tmp, path)
        except BaseException:
            try:
                _os.unlink(tmp)
            except OSError:
                pass
            raise

    def unshare(self):
        """Remove the shared file and make this table writable again. Processes that already loaded it keep their copy."""
        h = getattr(self, "_share", None)
        if h is not None:
            h.release()
            self._share = None
            self._t.set_frozen(False)

    @property
    def shared(self):
        """True for a table that is read-only because it is shared, here or in the process it came from."""
        return self._t.frozen

    def __setstate__(self, state):
        for name, value in state.items():
            setattr(self, name, value)

    def to_bytes(self):
        """The packed table as bytes (`Table.from_bytes` reads it back). The format is tied to this version of packmem."""
        return self._t.to_bytes()

    @classmethod
    def from_bytes(cls, data):
        return _restore(cls, data)

    def __delitem__(self, i):
        n = len(self._t)
        drop = set(range(*i.indices(n))) if isinstance(i, slice) else {self._idx(i)}
        if drop:
            self._t.reorder([j for j in range(n) if j not in drop])

    def insert(self, i, row):
        """Insert a record before position i. Rebuilds the table unless i is at the end."""
        n = len(self._t)
        i = max(0, i + n) if i < 0 else min(i, n)
        self._t.append(row)
        if i < n:
            self._t.reorder([*range(i), n, *range(i, n)])

    def pop(self, i=-1):
        row = self[i]
        del self[i]
        return row

    def clear(self):
        self._t.reorder([])

    def reverse(self):
        self._t.reorder(range(len(self._t) - 1, -1, -1))

    def sort(self, *, key, reverse=False):
        """Sort in place, stably. `key` is a column name or a function of a record, as in list.sort."""
        keys = self._t.column(key) if isinstance(key, str) else [key(r) for r in self]
        self._t.reorder(sorted(range(len(keys)), key=keys.__getitem__, reverse=reverse))

    def compact(self):
        """Pack rows that are still held uncompressed (done automatically as the table grows)."""
        self._t.compact()

    def update(self, i, fields=None, **more):
        """Change some fields of row i in place."""
        i = self._idx(i)
        for k, v in {**(fields or {}), **more}.items():
            self._t.set_cell(i, k, v)

    # --- queries on packed data ---
    def where(self, **filters):
        """Filter rows. Keys: col=value, col__prefix, col__contains, col__gte, col__gt, col__lte, col__lt, col__between=(lo, hi)."""
        return View(self._t, _select(self._t, filters))

    def count(self, **filters):
        return len(self.where(**filters)) if filters else len(self)

    def sum(self, column, **filters):
        return self._t.sum(column, _select(self._t, filters) if filters else None)

    def group_count(self, column, **filters):
        return self._t.group_count(column, _select(self._t, filters) if filters else None)

    def column(self, name):
        return self._t.column(name)

    @property
    def columns(self):
        return self._t.names()

    @property
    def nbytes(self):
        """Approximate bytes held by the table."""
        return self._t.nbytes()

    def describe(self):
        """(column, encodings, bytes) for the sealed part of each column."""
        return self._t.describe()


_MutableSequence.register(Table)


class View:
    """The rows of a Table that matched a filter."""

    __slots__ = ("_t", "_sel")

    def __init__(self, t, sel):
        self._t, self._sel = t, sel if sel is not None else t.all()

    def __len__(self):
        return len(self._sel)

    count = __len__

    def where(self, **filters):
        return View(self._t, _select(self._t, filters, self._sel))

    def sum(self, column):
        return self._t.sum(column, self._sel)

    def group_count(self, column):
        return self._t.group_count(column, self._sel)

    def column(self, name):
        return self._t.column(name, self._sel)

    def rows(self, limit=None, offset=0):
        """Matching records as dicts; `offset` and `limit` page through them."""
        return self._t.rows(self._sel, None if limit is None else max(0, limit), max(0, offset))

    def to_json(self, limit=None, offset=0):
        """Matching records as one JSON array, in bytes, without building dicts."""
        return b"".join(self.iter_json(1 << 16, limit, offset))

    def iter_json(self, batch=4096, limit=None, offset=0):
        """The same JSON array yielded in chunks of `batch` records."""
        offset = max(0, offset)
        n = max(0, len(self._sel) - offset)
        n = n if limit is None else max(0, min(n, limit))
        return _json_chunks(n, batch, lambda a, b: self._t.json_sel(self._sel, offset + a, offset + b))

    def __iter__(self):
        return iter(self._t.rows(self._sel))

    def indices(self):
        return self._sel.ids()


def from_records(records, hint="balanced"):
    """Pack any iterable of mappings (dicts, csv.DictReader, sqlite3.Row with keys, ...)."""
    return Table(records, hint=hint)


def from_cursor(cursor, hint="balanced", default=None):
    """Pack the remaining rows of a DB-API cursor (sqlite3, psycopg, ...) without building a dict per row.

    Replaces `[dict(zip(names, row)) for row in cursor]`. Column names come from `cursor.description`.
    Values must be None, bool, int, float, str or JSON-like. `default` is called for any other value
    (dates, decimals, UUIDs, bytes) and must return one of those, as with `json.dumps(default=...)`;
    `default=str` stores them as text.
    """
    t = Table(hint=hint)
    t._t.extend_rows([d[0] for d in cursor.description], cursor, default)
    return t


def from_queryset(queryset, fields=None, hint="balanced", default=None):
    """Pack a Django queryset without building model instances or dicts.

    Replaces `list(queryset.values(*fields))`. `fields` defaults to the model's concrete columns.
    Rows are streamed with `values_list(...).iterator()`. See `from_cursor` for `default`.
    """
    if fields is None:
        fields = [f.attname for f in queryset.model._meta.concrete_fields]
    fields = list(fields)
    t = Table(hint=hint)
    t._t.extend_rows(fields, queryset.values_list(*fields).iterator(), default)
    return t


def _only(fields):
    if fields is None:
        return None
    if isinstance(fields, str):
        raise TypeError("fields must be a list of key names, not a single string")
    return list(fields)


def load_jsonl(src, hint="balanced", fields=None):
    """Load JSON lines from a path or an iterable of lines. Paths are parsed natively.

    `fields` keeps only those top-level keys; the others are skipped while parsing and never stored.
    """
    t = Table(hint=hint)
    t._t.set_fields(_only(fields))
    try:
        if isinstance(src, (str, _os.PathLike)):
            t._t.load_jsonl_path(_os.fspath(src))
        else:
            t._t.extend_json(src)
    finally:
        t._t.set_fields(None)
    return t


def load_json(src, hint="balanced", fields=None):
    """Load one JSON array of objects from a path or an open file, streaming element by element.

    Replaces `json.load(f)` when the file holds a list of records; the full list of dicts is never built.
    `fields` keeps only those top-level keys; the others are skipped while parsing and never stored.
    """
    fields = _only(fields)
    path = isinstance(src, (str, _os.PathLike))
    start = src.tell() if not path and getattr(src, "seekable", lambda: False)() else None
    t = Table(hint=hint)
    t._t.set_fields(fields)
    try:
        if path:
            t._t.load_json_array_path(_os.fspath(src))
        else:
            t._t.load_json_array_file(src)
        t._t.set_fields(None)
    except ValueError:
        # Python's json also accepts NaN and Infinity; retry with it when the input can be read again
        import json
        if path:
            with _builtins.open(src, encoding="utf-8") as f:
                data = json.load(f)
        elif start is not None:
            src.seek(start)
            data = json.load(src)
        else:
            raise
        if not isinstance(data, list) or not all(isinstance(r, dict) for r in data):
            raise
        if fields is not None:
            keep = set(fields)
            data = ({k: v for k, v in r.items() if k in keep} for r in data)
        t = Table(data, hint=hint)
    return t


def read_csv(path, hint="balanced", infer=False, **csv_kwargs):
    """Load a CSV file as records of strings, like list(csv.DictReader(f)).

    `infer=True` turns integer and decimal columns into numbers instead (codes with a leading zero stay text).
    Plain UTF-8 files are parsed natively; other encodings, csv dialect options and files whose rows vary in
    length go through csv.DictReader.
    """
    import csv
    encoding = csv_kwargs.pop("encoding", "utf-8")
    if encoding.lower().replace("_", "-") in ("utf-8", "utf8") and set(csv_kwargs) <= {"delimiter"}:
        t = Table(hint=hint)
        try:
            t._t.load_csv_path(_os.fspath(path), csv_kwargs.get("delimiter", ","), infer)
            return t
        except ValueError:
            if infer:
                raise
    if infer:
        raise ValueError("infer=True needs a UTF-8 file and no csv dialect options other than delimiter")
    with _builtins.open(path, newline="", encoding=encoding) as f:
        return Table(csv.DictReader(f, **csv_kwargs), hint=hint)
