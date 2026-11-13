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
        p = os.path.join(d, "x.jsonl"); open(p, "w").write("\n".join(lines) + "\n\n")
        assert list(packmem.load_jsonl(p)) == want
        q = os.path.join(d, "x.json"); open(q, "w").write(json.dumps(want, indent=1))
        assert list(packmem.load_json(q)) == want
        assert list(packmem.load_json(io.StringIO(json.dumps(want)))) == want
        open(q, "w").write(json.dumps(want) + " trailing")
        for bad in (lambda: packmem.load_json(q), lambda: packmem.load_json(io.StringIO("[{\"a\":1}, 5]")), lambda: packmem.load_jsonl(['{"a":1}', '{"a":1} x']),
                    lambda: packmem.load_jsonl(['{"a":1}', '[1]']), lambda: packmem.load_jsonl(['{"a":1}', '{"a":']), lambda: packmem.load_jsonl(['{"a":1,"b":{"c":}}'])):
            try: bad(); raise AssertionError("expected ValueError")
            except ValueError: pass
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


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_"): f(); print("ok", name)
