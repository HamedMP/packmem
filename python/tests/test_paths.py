"""Checks for the fast paths: decimal range filters, lazy rows, native JSON parsing, failed appends."""
import io, json, math, os, random, tempfile
import packmem


def model_filter(m, key, op, v):
    num = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)
    ops = {"gt": lambda x: x > v, "gte": lambda x: x >= v, "lt": lambda x: x < v, "lte": lambda x: x <= v, "eq": lambda x: x == v}
    return [i for i, r in enumerate(m) if key in r and num(r[key]) and ops[op](r[key])]


def test_decimal_filters():
    r = random.Random(7)
    m = []
    for i in range(40_000):
        row = {"price": round(r.uniform(-50, 500), 2), "half": r.randint(-40, 40) / 2, "whole": float(r.randint(0, 30))}
        if r.random() < .1: row["price"] = None
        if r.random() < .05: del row["half"]
        m.append(row)
    t = packmem.Table(m)
    kinds = dict((n, e) for n, e, _ in t.describe())
    assert all("decimal" in kinds[k] for k in ("price", "half", "whole")), kinds
    probes = [0, 0.0, -0.0, 0.5, 1, 12.34, 12.345, 499.99, 500, -50, -50.01, 1e-9, 1e300, -1e300, float("inf"), float("-inf"), 30, 29.999999999999996]
    probes += [m[r.randrange(len(m))].get("price") or 0.0 for _ in range(30)]
    for key in ("price", "half", "whole"):
        for v in probes:
            for op in ("gt", "gte", "lt", "lte"):
                assert t.where(**{f"{key}__{op}": v}).indices() == model_filter(m, key, op, v), (key, op, v)
            if isinstance(v, float):
                assert t.where(**{key: v}).indices() == model_filter(m, key, "eq", v), (key, v)
        assert t.count(**{f"{key}__gt": float("nan")}) == 0
        lo, hi = 3.5, 250.25
        assert t.where(**{f"{key}__between": (lo, hi)}).indices() == [i for i, row in enumerate(m) if isinstance(row.get(key), float) and lo <= row[key] <= hi]
    # after updates the patched chunk must still answer correctly
    for i in r.sample(range(len(m)), 300):
        m[i]["price"] = 777.77; t.update(i, price=777.77)
    assert t.where(price__gt=700).indices() == model_filter(m, "price", "gt", 700)
    assert t.sum("whole", price__gt=100) == sum(row["whole"] for row in m if isinstance(row.get("price"), float) and row["price"] > 100)


def test_negative_zero_keeps_its_sign():
    t = packmem.Table([{"x": -0.0}, {"x": 0.0}, {"x": 1.5}] * 5000)
    assert [math.copysign(1, row["x"]) for row in t[:3]] == [-1.0, 1.0, 1.0]


def test_lazy_rows():
    r = random.Random(3)
    m = [{"id": i, "name": r.choice(["a", "b", "é"]), "v": r.random(), "nested": {"k": [i]}, **({"opt": i} if i % 3 else {})} for i in range(40_000)]
    t = packmem.Table(m)
    n = 0
    for row, want in zip(t.lazy(), m):
        assert row["id"] == want["id"] and row["name"] == want["name"] and row.get("opt") == want.get("opt") and ("opt" in row) == ("opt" in want)
        n += 1
    assert n == len(m)
    rows = list(t.lazy())
    for i in (0, 1, 2, 9999, 20_000, len(m) - 1):
        row = rows[i]
        assert row == m[i] and row.to_dict() == m[i] and dict(row.items()) == m[i] and list(row) == list(m[i]) and len(row) == len(m[i]) and row.index == i
        assert row["nested"] == m[i]["nested"] and row.get("missing", 5) == 5
        try: row["missing"]; raise AssertionError("expected KeyError")
        except KeyError: pass
    t.update(1, name="changed"); assert rows[1]["name"] == "changed"          # a Row shows current contents
    rows[2]["name"] = "written"; rows[2]["new_key"] = 1; assert t[2]["name"] == "written" and t[2]["new_key"] == 1 and "new_key" not in rows[3]


def test_native_json():
    recs = [{"a": 1, "s": "plain", "e": 'quote " and \\ slash \n newline', "u": "日本 é \u0001", "f": 1.5, "big": 2**70, "n": None, "t": True, "nest": {"x": [1, 2.0, "3"]}, "esc\"key": 1},
            {"s": "", "a": -9223372036854775808, "f": 1e-7, "extra": [1, {"deep": None}]},
            {}]
    lines = [json.dumps(x, ensure_ascii=e) for e in (True, False) for x in recs]
    want = recs + recs
    assert list(packmem.load_jsonl(lines)) == want
    assert list(packmem.load_jsonl([l.encode() for l in lines] + [b"", b"  \n"])) == want
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "x.jsonl"); open(p, "w", encoding="utf-8").write("\n".join(lines) + "\n\n")
        assert list(packmem.load_jsonl(p)) == want
        q = os.path.join(d, "x.json"); open(q, "w", encoding="utf-8").write(json.dumps(want, indent=1))
        assert list(packmem.load_json(q)) == want
        assert list(packmem.load_json(io.StringIO(json.dumps(want)))) == want
        open(q, "w", encoding="utf-8").write(json.dumps(want) + " trailing")
        for bad in (lambda: packmem.load_json(q), lambda: packmem.load_json(io.StringIO("[{\"a\":1}, 5]")), lambda: packmem.load_jsonl(['{"a":1}', '{"a":1} x']),
                    lambda: packmem.load_jsonl(['{"a":1}', '[1]']), lambda: packmem.load_jsonl(['{"a":1}', '{"a":']), lambda: packmem.load_jsonl(['{"a":1,"b":{"c":}}'])):
            try: bad(); raise AssertionError("expected ValueError")
            except ValueError: pass
    # fields=: other keys are skipped while parsing, on every loader and on the Python-parser fallback (NaN)
    src = [{"id": i, "big": "x" * 50, "nest": {"k": [i]}, "v": float("nan") if i == 7 else i / 2, **({"opt": i} if i % 2 else {})} for i in range(300)]
    keep = lambda ks: [{k: r[k] for k in r if k in ks} for r in src]
    same_nan = lambda a, b: json.dumps(a) == json.dumps(b)
    jl = [json.dumps(x) for x in src]
    for ks in (["id"], ["opt", "id"], ["nest", "v"], ["missing"], []):
        assert same_nan(list(packmem.load_jsonl(jl, fields=ks)), keep(ks)), ks
        assert same_nan(list(packmem.load_json(io.StringIO(json.dumps(src)), fields=ks)), keep(ks)), ks
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "f.jsonl"); open(p, "w", encoding="utf-8").write("\n".join(jl))
        q = os.path.join(d, "f.json"); json.dump(src, open(q, "w", encoding="utf-8"))
        assert same_nan(list(packmem.load_jsonl(p, fields=["id", "v"])), keep(["id", "v"])) and same_nan(list(packmem.load_json(q, fields=("id", "v"))), keep(["id", "v"]))
        t = packmem.load_jsonl(p, fields=["id"]); assert t.columns == ["id"]; t.append({"other": 1}); assert t[-1] == {"other": 1}     # the filter ends with the load
    try: packmem.load_jsonl(jl, fields="id"); raise AssertionError("expected TypeError")
    except TypeError: pass
    assert list(packmem.load_jsonl(['{"a":1,"a":2,"b":3}'])) == [{"a": 2, "b": 3}]   # duplicate keys: last wins, as in json.loads
    # key order differing between records, and keys appearing late
    mixed = [{"a": 1, "b": 2}, {"b": 3, "a": 4}, {"c": 5}, {"b": 6, "c": 7, "a": 8}] * 6000
    assert list(packmem.load_jsonl(json.dumps(x) for x in mixed)) == mixed and list(packmem.Table(mixed)) == mixed


def test_failed_append_leaves_table_intact():
    t = packmem.Table([{"a": 1, "b": "x"}])
    for bad in ({"a": 2, "b": object()}, {"a": 3, 4: 5}):
        try: t.append(bad); raise AssertionError("expected an error")
        except (TypeError, ValueError): pass
    try: t._t.append_json('{"a": 9, "b": ')
    except ValueError: pass
    t.append({"b": "y"}); t.extend([{"a": 7}])
    assert list(t) == [{"a": 1, "b": "x"}, {"b": "y"}, {"a": 7}] and len(t) == 3
    try: t.extend([{"a": 8}, {"a": object()}])
    except (TypeError, ValueError): pass
    assert list(t) == [{"a": 1, "b": "x"}, {"b": "y"}, {"a": 7}, {"a": 8}]



def test_sort_insert_delete():
    r = random.Random(11)
    mk = lambda i: {"id": i, "g": r.choice(["x", "y", "z"]), "v": round(r.uniform(0, 9), 1), **({"opt": [i]} if i % 4 else {})}
    m = [mk(i) for i in range(36_000)]
    t = packmem.Table(m)
    for step in range(40):
        op = r.choice(["del", "delslice", "insert", "pop", "sort_col", "sort_fn", "reverse", "append"])
        n = len(m)
        if op == "del": i = r.randrange(-n, n); del m[i]; del t[i]
        elif op == "delslice": a = r.randrange(n); sl = slice(a, a + r.randrange(0, 3000), r.choice([1, 1, 2, 7])); del m[sl]; del t[sl]
        elif op == "insert": i = r.randrange(-n - 5, n + 5); row = mk(-step); m.insert(i, row); t.insert(i, row)
        elif op == "pop": i = r.choice([-1, 0, r.randrange(n)]); assert m.pop(i) == t.pop(i)
        elif op == "sort_col": rev = r.random() < .5; k = r.choice(["g", "v", "id"]); m.sort(key=lambda x: x[k], reverse=rev); t.sort(key=k, reverse=rev)
        elif op == "sort_fn": f = lambda x: (x["g"], -x["v"]); m.sort(key=f); t.sort(key=f)
        elif op == "reverse": m.reverse(); t.reverse()
        else: row = mk(10**6 + step); m.append(row); t.append(row)
        assert len(t) == len(m), op
        for i in (0, 1, len(m) // 2, len(m) - 1): assert t[i] == m[i], (op, i)
    assert list(t) == m and t.count(g="x") == sum(1 for x in m if x["g"] == "x")
    assert t.columns == ["id", "g", "v", "opt"]
    t.clear(); assert len(t) == 0 and list(t) == [] and t.columns == ["id", "g", "v", "opt"]
    t.append({"id": 1}); assert list(t) == [{"id": 1}]
    try: t.sort(key=lambda x: x.get("opt"))            # None is fine alone; mixing types must raise as in list.sort
    except TypeError: raise AssertionError("single row sort must not raise")
    t.extend([{"id": "a"}])
    try: t.sort(key="id"); raise AssertionError("expected TypeError")
    except TypeError: pass



def test_json_output():
    r = random.Random(5)
    dump = lambda rows: json.dumps(rows, separators=(",", ":"), ensure_ascii=False).encode()
    floats = [0.0, -0.0, 1.0, 2.5, 1e16, 1.5e16, 9999999999999998.0, 1e-4, 1e-5, 1.2345e-7, 5e-324, 1.7976931348623157e308, 123456789012345.6, 0.1 + 0.2, -3e22, float("nan"), float("inf"), -float("inf")]
    m = [{"id": i, "f": r.choice(floats + [r.random(), round(r.uniform(0, 500), 2)]), "s": r.choice(["GET", "é 日本", 'q"\\\n\t\x01\x7f', ""]),
          "u": "id-%d" % r.randrange(10**9), "b": r.random() < .5, "n": None if i % 5 == 0 else i, **({"opt": -i} if i % 3 else {})} for i in range(40_000)]
    t = packmem.Table(m)
    assert t.to_json() == dump(m)                                         # byte-identical for flat records
    assert b"".join(t.iter_json(batch=777)) == dump(m)
    # floats of any magnitude read back as the same value (the text can differ from repr() where two shortest forms exist)
    wide = [{"f": r.random() * 10 ** r.randint(-30, 30) * r.choice([1, -1])} for _ in range(40_000)]
    assert [x["f"] for x in json.loads(packmem.Table(wide).to_json())] == [x["f"] for x in wide]
    v = t.where(s="GET"); want = [x for x in m if x["s"] == "GET"]
    assert v.to_json() == dump(want) and b"".join(v.iter_json(batch=100)) == dump(want)
    assert v.to_json(limit=10, offset=7) == dump(want[7:17]) and dump(v.rows(limit=10, offset=7)) == dump(want[7:17])
    assert v.to_json(limit=-5) == b"[]" and v.rows(limit=-5) == [] and v.to_json(limit=3, offset=-9) == dump(want[:3]) and b"".join(v.iter_json(batch=0, limit=3)) == dump(want[:3])
    assert v.to_json(offset=10**9) == b"[]" and packmem.Table().to_json() == b"[]" and t.where(s="nope").to_json() == b"[]"
    t.update(3, s="patched", extra={"k": [1, 2.5, None]}); m[3] = {**m[3], "s": "patched", "extra": {"k": [1, 2.5, None]}}
    nested = [{"a": {"x": [1, 2.0, "é", None, True]}, "big": 2**70, "mixed": i if i % 2 else "s"} for i in range(300)]
    for rows in (m, nested, [{}], [{"a": 1}, {}, {"b": float("nan")}]):
        got = json.loads(packmem.Table(rows).to_json() if rows is not m else t.to_json())
        assert len(got) == len(rows) and all(g == w or (g != g) or str(g) == str(w) for g, w in zip(got, rows)), rows[:2]



def test_from_cursor():
    import sqlite3
    con = sqlite3.connect(":memory:")
    con.execute("create table t (id integer, name text, v real, note text)")
    data = [(i, "n%d" % (i % 7), i / 4, None if i % 3 else "x") for i in range(20_000)]
    con.executemany("insert into t values (?,?,?,?)", data)
    cur = con.execute("select id, name, v, note from t order by id")
    t = packmem.from_cursor(cur)
    want = [dict(zip(("id", "name", "v", "note"), row)) for row in data]
    assert list(t) == want and t.columns == ["id", "name", "v", "note"] and t.count(name="n3") == sum(1 for w in want if w["name"] == "n3")
    assert list(packmem.from_cursor(con.execute("select id from t where id < 0"))) == []
    import datetime, decimal, uuid
    con.execute("create table d (id integer, at text)")
    odd = [(1, datetime.date(2026, 1, 2), decimal.Decimal("1.50"), uuid.UUID(int=7), b"\x00\xff")]
    w = packmem.Table(); w._t.extend_rows(["id", "day", "amount", "uid", "raw"], odd, str)
    assert list(w) == [{"id": 1, "day": "2026-01-02", "amount": "1.50", "uid": str(uuid.UUID(int=7)), "raw": str(b"\x00\xff")}]
    w = packmem.Table(); w._t.extend_rows(["id", "day", "amount", "uid", "raw"], odd, lambda v: float(v) if isinstance(v, decimal.Decimal) else str(v))
    assert w[0]["amount"] == 1.5
    try: packmem.Table()._t.extend_rows(["id", "day", "amount", "uid", "raw"], odd); raise AssertionError("expected TypeError")
    except TypeError: pass
    for bad in ([(1, 2, 3)], [(1,)], [(1, object())]):
        u = packmem.Table([{"a": 0, "b": 0}])
        try: u._t.extend_rows(["a", "b"], bad); raise AssertionError("expected an error")
        except (ValueError, TypeError): pass
        assert list(u) == [{"a": 0, "b": 0}]



def test_pickle_take_extend_and_surrogates():
    import pickle, random as rnd
    r = rnd.Random(9)
    m = [{"id": i, "s": r.choice(["a", "é", ""]), "f": r.choice([1.5, float("inf"), -0.0, 2.0]), "big": 2**70 + i, "n": None if i % 4 else [i, {"k": None}], **({"late": i} if i > 20_000 else {})} for i in range(40_000)]
    t = packmem.Table(m, hint="memory")
    u = pickle.loads(pickle.dumps(t))
    assert list(u) == m and u.columns == t.columns and u._t.hint == "memory" and len(pickle.dumps(t)) < len(pickle.dumps(m))
    assert u.count(s="é") == sum(1 for x in m if x["s"] == "é") and u.sum("id") == sum(x["id"] for x in m)
    u.append({"id": -1}); u.update(3, s="patched"); w = pickle.loads(pickle.dumps(u)); assert w[3]["s"] == "patched" and w[-1] == {"id": -1} and len(w) == len(m) + 1
    for junk in (b"", b"PKM1", t.to_bytes()[:-7], b"nope" + t.to_bytes()[4:], t.to_bytes() + b"x"):
        try: packmem.Table.from_bytes(junk); raise AssertionError("expected ValueError")
        except ValueError: pass
    nan = packmem.Table([{"x": float("nan"), "y": 1}, {"y": 2}]); back = list(pickle.loads(pickle.dumps(nan)))
    assert back[0]["x"] != back[0]["x"] and back[1] == {"y": 2}
    e = pickle.loads(pickle.dumps(packmem.Table())); assert len(e) == 0 and e.columns == []
    # take, copy, shuffle, extend with another table, and the Sequence protocol
    idx = [5, -1, 5, 39_999, 0]
    assert list(t.take(idx)) == [m[i] for i in idx] and list(t.copy()) == m and len(t) == len(m)
    a = packmem.Table(m[:30_000]); b = packmem.Table([{"other": 1, "id": -1}] + m[30_000:])
    a.extend(b); assert list(a) == m[:30_000] + [{"id": -1, "other": 1}] + m[30_000:]
    c = packmem.Table(m[:10]); c.extend(c); assert list(c) == m[:10] * 2
    s = t.copy(); s.shuffle(rnd.Random(1)); assert sorted(x["id"] for x in s) == list(range(len(m))) and [x["id"] for x in s[:50]] != list(range(50))
    assert len(rnd.Random(2).sample(t, 5)) == 5 and m[7] in t
    # a lone surrogate has no UTF-8 form; it must still round-trip, as it does through json.loads
    line = '{"a":"\\udd56 x","b":1,"c":"ok"}'
    want = [json.loads(line)]
    for tab in (packmem.load_jsonl([line] * 3), packmem.Table(want * 3), pickle.loads(pickle.dumps(packmem.Table(want * 3)))):
        assert list(tab) == want * 3 and json.loads(tab.to_json()) == want * 3 and tab.count(c="ok") == 3
    big = packmem.Table(want * 20_000 + [{"a": "plain", "b": 2, "c": "ok"}]); big.compact()
    assert big[0] == want[0] and big[-1]["a"] == "plain" and big[19_999]["a"] == want[0]["a"]



def test_set_column():
    m = [{"id": i, "s": "v%d" % (i % 5), **({"opt": i} if i % 2 else {})} for i in range(40_000)]
    t = packmem.Table(m[:39_000]); t.extend(m[39_000:])
    t.set_column("path", "/data/a"); [row.update(path="/data/a") for row in m]
    assert list(t) == m and t.count(path="/data/a") == len(m) and t.columns == ["id", "s", "opt", "path"]
    vals = [None if i % 7 == 0 else i * 1.5 for i in range(len(m))]
    t.set_column("opt", vals); [row.update(opt=v) for row, v in zip(m, vals)]            # replaces a sparse column
    assert list(t) == m and t.sum("opt") == sum(v for v in vals if v is not None)
    t.set_column("s", (x.upper() for x in t.column("s"))); [row.update(s=row["s"].upper()) for row in m]
    assert list(t) == m and t.count(s="V3") == sum(1 for row in m if row["s"] == "V3")
    t.set_column("nested", {"k": [1]}); assert t[0]["nested"] == {"k": [1]} and t[-1]["nested"] == {"k": [1]}
    t.append({"id": -1}); assert t[-1] == {"id": -1} and len(t) == len(m) + 1
    for bad in ([1, 2, 3], iter(range(10))):
        try: t.set_column("x", bad); raise AssertionError("expected ValueError")
        except ValueError: pass
    assert "x" not in t[0]
    e = packmem.Table(); e.set_column("a", 1); assert list(e) == []


def test_text_heavy_load_uses_background_packing():
    # chunks with megabytes of text are packed on a background thread; the result must not depend on that
    r = random.Random(2); words = ["alpha", "beta", "gamma", "delta", "épsilon", "日本", "zeta"]
    def rec(i):
        turns = [{"from": "human" if k % 2 == 0 else "gpt", "value": " ".join(r.choice(words) for _ in range(r.randint(20, 90)))} for k in range(r.choice([2, 4]))]
        out = {"id": i if i % 3 else str(i), "conversations": turns, "note": " ".join(r.choice(words) for _ in range(40))}
        if i > 30_000: out["late"] = i                    # a column that first appears after chunks were handed off
        if i % 11 == 0: del out["note"]
        return out
    m = [rec(i) for i in range(52_000)]
    lines = [json.dumps(x, ensure_ascii=False) for x in m]
    blobs = []
    for threads in ("0", "1", "3"):
        os.environ["PACKMEM_LOAD_THREADS"] = threads
        try:
            t = packmem.load_jsonl(lines)
            assert list(t) == m and t.columns == ["id", "conversations", "note", "late"] and t.count(late=40_000) == 1
            t.append({"id": -1}); assert t[-1] == {"id": -1} and len(t) == len(m) + 1
            u = packmem.Table(m[:40_000]); u.extend(m[40_000:]); assert list(u) == m
            blobs.append(packmem.load_jsonl(lines).to_bytes())
        finally:
            del os.environ["PACKMEM_LOAD_THREADS"]
    assert blobs[0] == blobs[1] == blobs[2]                # byte-identical packed form with or without threads


def _worker_reads(t):
    return (len(t), t.sum("id"), t.count(g="x"), t.shared)


def test_share_between_processes():
    import multiprocessing as mp, pickle, tempfile, gc
    m = [{"id": i, "g": "xyz"[i % 3], "v": i / 8, **({"opt": [i]} if i % 5 else {})} for i in range(40_000)]
    with tempfile.TemporaryDirectory() as d:
        t = packmem.Table(m); t.append({"id": -1, "g": "x"}); m.append({"id": -1, "g": "x"})
        plain = len(pickle.dumps(t))
        assert t.share(dir=d) is t and t.shared and len(os.listdir(d)) == 1 and t.share(dir=d) is t and len(os.listdir(d)) == 1
        if os.name == "posix":
            assert os.stat(os.path.join(d, os.listdir(d)[0])).st_mode & 0o077 == 0     # readable by its owner only
        blob = pickle.dumps(t)
        assert len(blob) < 600 < plain                                    # a pointer, not the data
        u = pickle.loads(blob)
        assert list(u) == m and u.shared and u.count(g="x") == t.count(g="x") and list(t) == m
        for change in (lambda x: x.append({"id": 1}), lambda x: x.update(0, id=5), lambda x: x.sort(key="id"), lambda x: x.set_column("z", 1),
                       lambda x: x.extend([{"id": 2}]), lambda x: x.pop(), lambda x: x.__setitem__(0, {"id": 9}), lambda x: next(iter(x.lazy())).__setitem__("id", 9)):
            for table in (t, u):
                try: change(table); raise AssertionError("expected a shared table to refuse changes")
                except TypeError: pass
        assert list(t) == m and list(u) == m
        c = u.copy(); c.append({"id": 3}); assert len(c) == len(m) + 1 and not c.shared       # a copy is private and writable
        try: u.share(dir=d); raise AssertionError("expected TypeError")
        except TypeError: pass
        want = (len(m), sum(r["id"] for r in m), sum(1 for r in m if r["g"] == "x"), True)
        with mp.get_context("spawn").Pool(2) as pool:
            assert pool.map(_worker_reads, [t, t, t]) == [want] * 3
        e = Examples(m[:10]); e.stats = {"n": 10}; e.share(dir=d)
        back = pickle.loads(pickle.dumps(e)); assert type(back) is Examples and back.stats == {"n": 10} and list(back) == m[:10]
        t.unshare(); assert not t.shared and len(os.listdir(d)) == 1
        t.append({"id": 7}); assert len(t) == len(m) + 1 and len(pickle.dumps(t)) > 600
        try: pickle.loads(blob); raise AssertionError("expected FileNotFoundError after unshare")
        except FileNotFoundError: pass
        del e, back; gc.collect(); assert os.listdir(d) == []                                    # collected: file removed
        open(os.path.join(d, "packmem-999999999-00.pkm"), "w").close(); open(os.path.join(d, "packmem-%d-00.pkm" % os.getpid()), "w").close()
        assert packmem.cleanup_stale(d) == 1 and os.listdir(d) == ["packmem-%d-00.pkm" % os.getpid()]


class Examples(packmem.Table):
    __slots__ = ("stats",)


class Loose(packmem.Table):
    pass


def test_subclasses_survive_pickling():
    import pickle
    e = Examples([{"a": 1}, {"a": 2}]); e.stats = {"n": 2}
    back = pickle.loads(pickle.dumps(e))
    assert type(back) is Examples and back.stats == {"n": 2} and list(back) == [{"a": 1}, {"a": 2}]
    bare = pickle.loads(pickle.dumps(Examples([{"a": 1}])))          # slot never set: stays unset
    assert type(bare) is Examples and not hasattr(bare, "stats")
    l = Loose([{"b": 1}]); l.tag = "x"; l.n = 3
    back = pickle.loads(pickle.dumps(l)); assert type(back) is Loose and (back.tag, back.n) == ("x", 3) and list(back) == [{"b": 1}]
    assert type(Examples.from_bytes(e.to_bytes())) is Examples and type(packmem.Table.from_bytes(e.to_bytes())) is packmem.Table
    assert type(pickle.loads(pickle.dumps(packmem.Table([{"a": 1}])))) is packmem.Table



def test_from_queryset():
    try:
        import django
    except ImportError:
        return                                   # optional: only runs where Django is installed
    import datetime, decimal
    from django.conf import settings
    if not settings.configured:
        settings.configure(DATABASES={"default": {"ENGINE": "django.db.backends.sqlite3", "NAME": ":memory:"}}, INSTALLED_APPS=[], USE_TZ=False)
        django.setup()
    from django.db import connection, models

    class Order(models.Model):
        customer = models.CharField(max_length=20)
        qty = models.IntegerField()
        price = models.DecimalField(max_digits=8, decimal_places=2)
        day = models.DateField()
        note = models.TextField(null=True)
        class Meta:
            app_label = "packmem_test"

    with connection.schema_editor() as ed:
        ed.create_model(Order)
    Order.objects.bulk_create(Order(customer="c%d" % (i % 9), qty=i, price=decimal.Decimal(i) / 4, day=datetime.date(2026, 1, 1 + i % 28), note=None if i % 3 else "n") for i in range(5000))
    qs = Order.objects.filter(qty__gte=10).order_by("id")
    t = packmem.from_queryset(qs, fields=["id", "customer", "qty", "note"])
    assert list(t) == list(qs.values("id", "customer", "qty", "note")) and t.count(customer="c3") == qs.filter(customer="c3").count()
    full = packmem.from_queryset(qs, default=str)
    want = [{k: (str(v) if isinstance(v, (decimal.Decimal, datetime.date)) else v) for k, v in row.items()} for row in qs.values()]
    assert list(full) == want and full.columns == ["id", "customer", "qty", "price", "day", "note"]
    try: packmem.from_queryset(qs); raise AssertionError("expected TypeError without default")
    except TypeError: pass


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_"): f(); print("ok", name)
