# Reddit

## r/Python

**Title:** packmem: a one-line replacement for a list of dicts that used 36x less memory on 336k real records

**Body:**

    `rows = packmem.load_jsonl("flights.jsonl")` instead of `[json.loads(l) for l in f]`. On nycflights13
    (336,776 rows, 104 MB of JSON lines) the list of dicts takes 712 MB; packmem takes 19.7 MB (Mac, on a machine in normal
    use) and supports the list operations: index, iterate, append, update, sort. It is not a list subclass: a row you
    read is a fresh dict, so changing it does not change the table (lazy rows write through). Queries like `rows.count(carrier="UA")` or `rows.group_count("dest")`
    run on the packed columns and were 24 to 426 times faster than loops over the dicts.

    It also reads CSV (`packmem.read_csv`), DB-API cursors without a dict per row (`packmem.from_cursor`) and Django
    querysets (`packmem.from_queryset`). In a FastAPI server holding the data, settled memory went from 731 MB to 72 MB.

    Costs: a plain `for r in rows` loop is 4.9x slower than over the list (use `rows.lazy()` or a query), random row
    access 6.7x slower, and below a few hundred rows there is no saving. polars tuned for memory comes within 1.6 to
    2.9x and loads faster; packmem is for code that wants a list, not a dataframe. New in 0.2.0: `save()` once and
    `packmem.open()` in every run memory-maps the packed table, so DataLoader workers share it. In a fine-tuning loader
    over 157,712 LLaVA records with 4 spawn workers, that held 3 MB above an empty loader, against 228 MB for Hugging
    Face `datasets` (memory-mapped Arrow) and 4.0 GB for a list (Apple M4 Pro, medians of 3, annotations only).
    `datasets` is still faster for batched access, and its Parquet is smaller at rest.

    Alpha (0.2.0). pip install packmem — benchmarks, scripts and every results file: https://github.com/HamedMP/packmem

## r/node

**Title:** packmem: an array of objects in a fraction of the memory, with JSON responses streamed from packed columns

**Body:**

    `loadJsonl(path)` instead of `lines.map(JSON.parse)`. In Express and Next.js servers holding 336,776 records,
    settled memory dropped from 390 MB to 94 MB and 411 MB to 118 MB, and peak memory 3.6 to 5.3 times, with identical
    responses. `rows.where({...}).jsonStream().pipe(res)` writes JSON straight from the columns (byte-identical to
    JSON.stringify for flat records) without building objects or a full-size string.

    Postgres: `fromPgCopy(client, sql)` streams COPY output into the columns with no row objects (448 ms against 436 ms
    for plain node-postgres rows on our data); `fromQuery` takes Drizzle and Kysely queries. `packmem/wasm` runs the same code on
    Cloudflare Workers.

    Honest part: V8 already stores same-shape objects compactly, so the gain in Node is memory more than speed, and a
    loop over every row is slower than over a plain array. Details and every number's source in the repo.

    Alpha (0.2.0). npm install packmem — https://github.com/HamedMP/packmem
