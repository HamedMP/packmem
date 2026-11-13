"""packmem: a list of dicts that takes a fraction of the memory.

    rows = [json.loads(line) for line in f]      # before
    rows = packmem.load_jsonl(f)                 # after

`rows` still supports len(), indexing, slicing, iteration, append, extend and item
assignment, and adds filters and aggregates that run on the packed data:

    rows.where(status=404, ua__contains="curl").sum("bytes")
"""
import os as _os
from ._packmem import _Table, Selection, Row

__all__ = ["Table", "View", "Row", "load_jsonl", "load_json", "from_records", "read_csv"]
__version__ = "0.1.0"
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
        self._t.extend(rows)

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
        return [c for c in self._t.names() if c != ""]

    @property
    def nbytes(self):
        """Approximate bytes held by the table."""
        return self._t.nbytes()

    def describe(self):
        """(column, encodings, bytes) for the sealed part of each column."""
        return self._t.describe()


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

    def rows(self, limit=None):
        return self._t.rows(self._sel, limit)

    def __iter__(self):
        return iter(self._t.rows(self._sel))

    def indices(self):
        return self._sel.ids()


def from_records(records, hint="balanced"):
    """Pack any iterable of mappings (dicts, csv.DictReader, sqlite3.Row with keys, ...)."""
    return Table(records, hint=hint)


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
    t = Table(hint=hint)
    if isinstance(src, (str, _os.PathLike)):
        t._t.load_json_array_path(_os.fspath(src))
    else:
        t._t.load_json_array_file(src)
    return t


def read_csv(path, hint="balanced", **csv_kwargs):
    """Load a CSV file as records of strings, like list(csv.DictReader(f))."""
    import csv
    with open(path, newline="", encoding=csv_kwargs.pop("encoding", "utf-8")) as f:
        return Table(csv.DictReader(f, **csv_kwargs), hint=hint)
