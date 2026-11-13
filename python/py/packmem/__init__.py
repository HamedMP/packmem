"""packmem: a list of dicts that takes a fraction of the memory.

    rows = [json.loads(line) for line in f]      # before
    rows = packmem.load_jsonl(f)                 # after

`rows` still supports len(), indexing, slicing, iteration, append, extend and item
assignment, and adds filters and aggregates that run on the packed data:

    rows.where(status=404, ua__contains="curl").sum("bytes")
"""
import os as _os
from collections.abc import MutableSequence as _MutableSequence
from ._packmem import _Table, Selection, Row

__all__ = ["Table", "View", "Row", "load_jsonl", "load_json", "from_records", "from_cursor", "read_csv"]
__version__ = "0.1.0"


def _restore(data):
    t = Table.__new__(Table)
    t._t = _Table.from_bytes(data)
    return t


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

    __slots__ = ("_t",)

    def __init__(self, records=None, hint="balanced"):
        self._t = _Table(hint)
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

    def take(self, indices):
        """A new Table holding the rows at `indices`, in that order (rows may repeat)."""
        n = len(self._t)
        new = Table.__new__(Table)
        new._t = self._t.take([i + n if i < 0 else i for i in indices])
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
        return _restore, (self._t.to_bytes(),)

    def to_bytes(self):
        """The packed table as bytes (`Table.from_bytes` reads it back). The format is tied to this version of packmem."""
        return self._t.to_bytes()

    @classmethod
    def from_bytes(cls, data):
        return _restore(data)

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


def from_cursor(cursor, hint="balanced"):
    """Pack the remaining rows of a DB-API cursor (sqlite3, psycopg, ...) without building a dict per row.

    Replaces `[dict(zip(names, row)) for row in cursor]`. Column names come from `cursor.description`.
    Values must be None, bool, int, float, str or JSON-like; convert dates and decimals in the query.
    """
    t = Table(hint=hint)
    t._t.extend_rows([d[0] for d in cursor.description], cursor)
    return t


def load_jsonl(src, hint="balanced"):
    """Load JSON lines from a path or an iterable of lines. Paths are parsed natively."""
    t = Table(hint=hint)
    if isinstance(src, (str, _os.PathLike)):
        t._t.load_jsonl_path(_os.fspath(src))
    else:
        t._t.extend_json(src)
    return t


def load_json(src, hint="balanced"):
    """Load one JSON array of objects from a path or an open file, streaming element by element.

    Replaces `json.load(f)` when the file holds a list of records; the full list of dicts is never built.
    """
    path = isinstance(src, (str, _os.PathLike))
    start = src.tell() if not path and getattr(src, "seekable", lambda: False)() else None
    t = Table(hint=hint)
    try:
        if path:
            t._t.load_json_array_path(_os.fspath(src))
        else:
            t._t.load_json_array_file(src)
    except ValueError:
        # Python's json also accepts NaN and Infinity; retry with it when the input can be read again
        import json
        if path:
            with open(src, encoding="utf-8") as f:
                data = json.load(f)
        elif start is not None:
            src.seek(start)
            data = json.load(src)
        else:
            raise
        if not isinstance(data, list) or not all(isinstance(r, dict) for r in data):
            raise
        t = Table(data, hint=hint)
    return t


def read_csv(path, hint="balanced", **csv_kwargs):
    """Load a CSV file as records of strings, like list(csv.DictReader(f))."""
    import csv
    with open(path, newline="", encoding=csv_kwargs.pop("encoding", "utf-8")) as f:
        return Table(csv.DictReader(f, **csv_kwargs), hint=hint)
