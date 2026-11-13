"""Property-based checks (needs `hypothesis`): arbitrary records must survive every way in and out of a Table."""
import json, math
from hypothesis import given, settings, strategies as st
import packmem


def same(a, b):
    """Equality that tells 1, 1.0 and True apart, treats NaN as equal to itself and checks the sign of zero."""
    if isinstance(a, float) and isinstance(b, float):
        return (math.isnan(a) and math.isnan(b)) or (a == b and math.copysign(1, a) == math.copysign(1, b))
    if type(a) is not type(b): return False
    if isinstance(a, dict): return list(a) == list(b) and all(same(a[k], b[k]) for k in a)
    if isinstance(a, list): return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return a == b


scalars = st.one_of(st.none(), st.booleans(), st.integers(-2**70, 2**70), st.integers(-100, 100), st.floats(allow_nan=True, allow_infinity=True),
                    st.decimals(-1000, 1000, places=2).map(float), st.text(max_size=12), st.sampled_from(["GET", "POST", "", "é", "a\"b\\c\n"]))
nested = st.recursive(scalars, lambda c: st.one_of(st.lists(c, max_size=3), st.dictionaries(st.text(max_size=4), c, max_size=3)), max_leaves=6)
keys = st.one_of(st.sampled_from(["a", "b", "c", "id", ""]), st.text(max_size=6))
records = st.lists(st.dictionaries(keys, nested, max_size=5), max_size=40)


def key_order(rows):
    """Records come back with keys in the order the columns were first seen."""
    cols = []
    for r in rows:
        for k in r:
            if k not in cols: cols.append(k)
    return [{k: r[k] for k in cols if k in r} for r in rows]


@settings(max_examples=400, deadline=None)
@given(records, st.integers(0, 40), st.sampled_from(["memory", "balanced", "speed"]))
def test_round_trip(rows, cut, hint):
    want = key_order(rows)
    t = packmem.Table(rows[:cut], hint=hint)
    t.compact()                                   # seal what is there, then keep appending
    for r in rows[cut:]: t.append(r)
    assert len(t) == len(want)
    assert same(list(t), want), (list(t), want)
    assert same([t[i] for i in range(len(t))], want)
    assert same(t[1:-1:2], want[1:-1:2])
    assert same([r.to_dict() for r in t.lazy()], want)
    t.compact(); assert same(list(t), want)


@settings(max_examples=300, deadline=None)
@given(records)
def test_json_lines_match_json_loads(rows):
    lines = [json.dumps(r) for r in rows]
    want = key_order([json.loads(l) for l in lines])
    assert same(list(packmem.load_jsonl(lines)), want)
    assert same(list(packmem.load_json(__import__("io").StringIO(json.dumps(rows)))), want)


@settings(max_examples=300, deadline=None)
@given(records.filter(lambda r: len(r) > 0), st.data())
def test_edits_match_a_list(rows, data):
    m = [dict(r) for r in rows]; t = packmem.Table(rows); t.compact()
    for _ in range(6):
        op = data.draw(st.sampled_from(["set", "update", "del", "insert", "reverse", "append"]))
        if not m: op = "append"
        i = data.draw(st.integers(0, max(len(m) - 1, 0)))
        row = data.draw(st.dictionaries(keys, nested, max_size=4))
        if op == "set": m[i] = row; t[i] = row
        elif op == "update": m[i] = {**m[i], **row}; t.update(i, row)
        elif op == "del": del m[i]; del t[i]
        elif op == "insert": m.insert(i, row); t.insert(i, row)
        elif op == "reverse": m.reverse(); t.reverse()
        else: m.append(row); t.append(row)
        got = list(t)
        assert len(got) == len(m) and all(same(dict(sorted(g.items())), dict(sorted(w.items()))) for g, w in zip(got, m)), (op, got, m)


if __name__ == "__main__":
    for name, f in list(globals().items()):
        if name.startswith("test_"): f(); print("ok", name)
