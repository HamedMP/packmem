"""Compare two exports whose bytes differ: parsed equality, and where they part.

    python3 compare.py <reference dir> <candidate dir>
Exit status 0 when every JSON file parses equal, 1 otherwise.
"""

import json
import sys
from pathlib import Path


def first_difference(a, b, path="$"):
    if type(a) is not type(b):
        return f"{path}: {type(a).__name__} {a!r:.80} != {type(b).__name__} {b!r:.80}"
    if isinstance(a, dict):
        if list(a) != list(b):
            return f"{path}: keys {list(a)} != {list(b)}"
        for k in a:
            if (d := first_difference(a[k], b[k], f"{path}.{k}")) is not None:
                return d
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return f"{path}: length {len(a)} != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            if (d := first_difference(x, y, f"{path}[{i}]")) is not None:
                return d
        return None
    return None if a == b else f"{path}: {a!r:.120} != {b!r:.120}"


def main() -> None:
    ref, cand = Path(sys.argv[1]), Path(sys.argv[2])
    names = sorted(p.relative_to(ref) for p in ref.rglob("*") if p.is_file())
    other = sorted(p.relative_to(cand) for p in cand.rglob("*") if p.is_file())
    ok = names == other
    if not ok:
        print(f"file sets differ: {len(names)} vs {len(other)}; only in ref: {sorted(set(names) - set(other))[:5]}; only in candidate: {sorted(set(other) - set(names))[:5]}")
    bytes_differ = parsed_differ = 0
    for name in sorted(set(names) & set(other)):
        a_bytes, b_bytes = (ref / name).read_bytes(), (cand / name).read_bytes()
        if a_bytes == b_bytes:
            continue
        bytes_differ += 1
        a, b = json.loads(a_bytes), json.loads(b_bytes)
        d = first_difference(a, b)
        if d is not None:
            parsed_differ += 1
            ok = False
            if parsed_differ <= 5:
                print(f"{name}: parsed values differ at {d}")
        elif bytes_differ <= 5:
            i = next(i for i, (x, y) in enumerate(zip(a_bytes, b_bytes)) if x != y)
            print(f"{name}: parsed equal, bytes differ from offset {i}: {a_bytes[max(0, i - 60):i + 60]!r} vs {b_bytes[max(0, i - 60):i + 60]!r}")
    print(f"compared {len(names)} files: {bytes_differ} differ in bytes, {parsed_differ} in parsed values")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
