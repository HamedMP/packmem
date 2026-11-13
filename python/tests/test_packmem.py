"""Model test: a packmem.Table must behave like the list of dicts it replaces."""
import json, math, random, sys, tempfile, os
import packmem

def same(a, b):
    if isinstance(a, float) and isinstance(b, float): return (math.isnan(a) and math.isnan(b)) or a == b
    if type(a) is not type(b): return False
    if isinstance(a, dict): return a.keys() == b.keys() and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list): return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b

def rand_value(r, kind):
    if kind == "int": return r.randint(-5, 10**6)
    if kind == "small": return r.randint(0, 7)
    if kind == "price": return round(r.uniform(0, 500), 2)
    if kind == "float": return r.random() * 1e9 if r.random() < .98 else r.choice([float("nan"), float("inf"), -0.0, 1e300])
    if kind == "bool": return r.random() < .3
    if kind == "cat": return r.choice(["GET", "POST", "PUT", "DELETE"])
    if kind == "text": return "/item/%d/%s" % (r.randint(0, 10**7), r.choice(["a", "é", "日本", ""]))
    if kind == "nested": return {"tags": [r.randint(0, 3), "x"], "ok": None} if r.random() < .5 else [1, [2.5, "y"]]
    if kind == "mixed": return r.choice([1, 1.0, "1", True, None, 2**70, [1], {"a": 1}, -7, 3.25])
    if kind == "nullable": return None if r.random() < .2 else r.randint(0, 99)
    if kind == "big": return r.choice([2**63 - 1, -2**63, 2**64, -2**80])

KINDS = ["int", "small", "price", "float", "bool", "cat", "text", "nested", "mixed", "nullable", "big"]
def rand_row(r, i):
    row = {k: rand_value(r, k) for k in KINDS if r.random() < .9}
    if i > 150_000 and r.random() < .5: row["late_col"] = i          # column that appears after sealed chunks exist
    if 70_000 < i < 140_000: row["int"] = "now a string %d" % (i % 50)  # type change in a later chunk
    return row

def check_filters(t, model, r):
    def col(k): return [row.get(k, packmem) for row in model]
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and (isinstance(v, float) or -2**63 <= v < 2**63)  # integers beyond 64 bits are kept exactly but are not filterable as numbers
    cases = [
        (dict(cat="POST"), lambda row: row.get("cat") == "POST"),
        (dict(small=3), lambda row: type(row.get("small")) is int and row["small"] == 3),
        (dict(text__prefix="/item/12"), lambda row: isinstance(row.get("text"), str) and row["text"].startswith("/item/12")),
        (dict(text__contains="日"), lambda row: isinstance(row.get("text"), str) and "日" in row["text"]),
        (dict(int__between=(100, 5000)), lambda row: num(row.get("int")) and 100 <= row["int"] <= 5000),
        (dict(price__gte=250.5), lambda row: num(row.get("price")) and row["price"] >= 250.5),
        (dict(price__lt=10), lambda row: num(row.get("price")) and row["price"] < 10),
        (dict(nullable__gt=97), lambda row: num(row.get("nullable")) and row["nullable"] > 97),
        (dict(nullable__lte=0.5), lambda row: num(row.get("nullable")) and row["nullable"] <= 0.5),
        (dict(bool=True), lambda row: row.get("bool") is True),
        (dict(nope=1), lambda row: False),
        (dict(cat="GET", small__gte=6, bool=False), lambda row: row.get("cat") == "GET" and num(row.get("small")) and row["small"] >= 6 and row.get("bool") is False),
    ]
    for flt, fn in cases:
        want = [i for i, row in enumerate(model) if fn(row)]
        v = t.where(**flt)
        assert v.indices() == want, (flt, len(v), len(want))
        assert t.count(**flt) == len(want)
        ws = math.fsum(model[i]["small"] for i in want if isinstance(model[i].get("small"), (int, float)))   # sum() adds ints, floats and bools, skips the rest
        assert abs(v.sum("small") - ws) < 1e-6 * max(1, abs(ws)), (flt, v.sum("small"), ws)
        if want: assert same(v.rows(3), [model[i] for i in want[:3]])
    # aggregates without a filter
    ws = math.fsum(row["small"] for row in model if isinstance(row.get("small"), (int, float)))
    assert abs(t.sum("small") - ws) < 1e-6 * max(1, abs(ws)), (t.sum("small"), ws)
    vals = [row["price"] for row in model if isinstance(row.get("price"), (int, float)) and (isinstance(row["price"], float) or -2**63 <= row["price"] < 2**63)]
    ps = float("nan") if any(isinstance(v, float) and math.isnan(v) for v in vals) else math.fsum(vals); got = t.sum("price")
    assert (math.isnan(ps) and math.isnan(got)) or got == ps or abs(got - ps) <= 1e-6 * max(1, abs(ps)), (got, ps)
    vals = [row["bool"] for row in model if isinstance(row.get("bool"), (int, float)) and (isinstance(row["bool"], float) or -2**63 <= row["bool"] < 2**63)]
    if not any(isinstance(v, float) and not math.isfinite(v) for v in vals):
        ps = math.fsum(vals); got = t.sum("bool"); assert abs(got - ps) <= 1e-6 * max(1, abs(ps)), (got, ps)
    want = {}
    for row in model:
        if "cat" in row:
            k = row["cat"] if not isinstance(row["cat"], (list, dict)) else json.dumps(row["cat"], separators=(",", ":"), ensure_ascii=False)
            want[k] = want.get(k, 0) + 1
    nonan = lambda d: {k: v for k, v in d.items() if not (isinstance(k, float) and math.isnan(k))}
    assert nonan(t.group_count("cat")) == nonan(want), "group_count(cat) differs"
    want = {}
    for row in model:
        if "nullable" in row:
            k = row["nullable"] if not isinstance(row["nullable"], (list, dict)) else json.dumps(row["nullable"], separators=(",", ":"), ensure_ascii=False)
            want[k] = want.get(k, 0) + 1
    assert nonan(t.group_count("nullable")) == nonan(want), "group_count(nullable) differs"

def main(n=200_000, seed=7):
    r = random.Random(seed)
    model = [rand_row(r, i) for i in range(n)]
    t = packmem.Table(model[: n // 2])               # bulk build
    for row in model[n // 2 : n // 2 + 1000]: t.append(row)   # appends one by one
    t.extend(model[n // 2 + 1000 :])                 # extend across several chunk seals
    assert len(t) == n and t.count() == n
    for i in r.sample(range(n), 3000): assert same(t[i], model[i]), (i, t[i], model[i])
    assert same(t[-1], model[-1]) and same(t[65530:65545], model[65530:65545]) and same(t[::50000], model[::50000])
    it = iter(t)
    for i in range(70_000): assert same(next(it), model[i]), i
    check_filters(t, model, r)
    # updates: single fields, whole rows, new columns, sealed chunks and tail, enough to force re-encoding of one chunk
    targets = r.sample(range(n), 2000) + list(range(1000, 6000)) + [n - 1, n - 2, 0]
    for j, i in enumerate(targets):
        if j % 3 == 0:
            new = rand_row(r, i); t[i] = new; model[i] = new
        elif j % 3 == 1:
            k = r.choice(KINDS); v = rand_value(r, r.choice(["small", "nullable", "bool", "cat", "price"] if k == "small" else KINDS)); t.update(i, {k: v}); model[i][k] = v
        else:
            t.update(i, added_later=j, cat="PATCH"); model[i]["added_later"] = j; model[i]["cat"] = "PATCH"
    for i in targets + r.sample(range(n), 2000): assert same(t[i], model[i]), (i, t[i], model[i])
    check_filters(t, model, r)
    assert t.count(cat="PATCH") == sum(1 for row in model if row.get("cat") == "PATCH") > 0
    # appends after updates, then everything once more
    extra = [rand_row(r, n + i) for i in range(70_000)]
    t.extend(extra); model.extend(extra)
    check_filters(t, model, r)
    assert all(same(a, b) for a, b in zip(t, model)) and len(t) == len(model)
    # loaders
    d = tempfile.mkdtemp(); p = os.path.join(d, "x.jsonl"); sub = [row for row in model[:5000]]
    for row in sub:
        for k in ("float", "mixed", "big"): row.pop(k, None)   # NaN/huge ints are not portable JSON
    open(p, "w").write("\n".join(json.dumps(row) for row in sub) + "\n")
    ref = [json.loads(l) for l in open(p)]
    assert same(list(packmem.load_jsonl(p)), ref) and same(list(packmem.load_jsonl(open(p))), ref) and same(list(packmem.load_jsonl(open(p, "rb"))), ref)
    pj = os.path.join(d, "x.json"); json.dump(ref, open(pj, "w")); assert same(list(packmem.load_json(pj)), ref) and same(list(packmem.load_json(open(pj))), ref) and same(list(packmem.load_json(open(pj, 'rb'))), ref)
    import csv
    pc = os.path.join(d, "x.csv")
    with open(pc, "w", newline="") as f:
        w = csv.DictWriter(f, ["cat", "small", "text"]); w.writeheader(); [w.writerow({k: row.get(k, "") for k in ("cat", "small", "text")}) for row in ref]
    assert list(packmem.read_csv(pc)) == list(csv.DictReader(open(pc, newline="")))
    # small tables: packed by extend(), then appended to and updated across the packed/unpacked boundary
    for size in (1, 100, 5000, 20_000):
        m = [rand_row(r, i) for i in range(size)]; s = packmem.Table(m)
        for step in range(3):
            more = [rand_row(r, i) for i in range(r.choice([1, 7, 9000]))]
            for row in more: s.append(row)
            m.extend(more)
            for i in r.sample(range(len(m)), min(len(m), 300)):
                new = rand_row(r, i); s[i] = new; m[i] = new
            if step == 1: s.compact()
            assert len(s) == len(m) and all(same(a, b) for a, b in zip(s, m)), (size, step)
            assert s.where(cat="GET").indices() == [i for i, row in enumerate(m) if row.get("cat") == "GET"]
            assert s.group_count("cat").get("PUT", 0) == sum(1 for row in m if row.get("cat") == "PUT")
    # edges
    e = packmem.Table(); assert len(e) == 0 and list(e) == [] and e.sum("x") == 0 and e.count(x=1) == 0
    e.append({}); e.append({"a": 1}); assert list(e) == [{}, {"a": 1}] and e.columns == ["a"]
    for bad in (lambda: e[5], lambda: e.append({1: 2}), lambda: e.append({"a": object()})):
        try: bad(); raise SystemExit("expected an error")
        except (IndexError, TypeError, ValueError): pass
    print("ok: %d rows, %d columns, %.1f MB packed" % (len(t), len(t.columns), t.nbytes / 1e6))

if __name__ == "__main__":
    main()
