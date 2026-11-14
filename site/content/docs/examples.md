# Sample projects

Each demo is in the [repository](https://github.com/HamedMP/packmem/tree/main/demos) and runs from a checkout.
The server demos serve the same 336,776 flight records (`data/flights.jsonl`, nycflights13) and switch between
a plain array or list (`MODE=baseline`) and a packmem table (`MODE=packmem`, the default), so you can compare the
two on your machine. Their measurements are in
[demos/README.md](https://github.com/HamedMP/packmem/blob/main/demos/README.md), with the raw results in
`demos/bench/results/`.

Build the Node addon once before the Node demos (`cd node && npm run build`), and the Python wheel before the
FastAPI demo (see [Install](/docs/install/#from-a-checkout)). The flights file comes from
`benchmarks/fetch_data.py`, which needs the `nycflights13` Python package:

```sh
pip install nycflights13
mkdir -p data && (cd data && python ../benchmarks/fetch_data.py)
```

## Express

`demos/express`: an Express 5 server with filtered pages, group-bys, a summary and a full export. The export
answers `Accept: application/vnd.packmem` with packed bytes through `packmem/http`, and JSON otherwise.

```sh
cd demos/express && npm install && npm start          # port 3001; npm run start:baseline to compare
```

Shows: server memory at rest and under load against an array of objects, and JSON written from the columns.

## Next.js

`demos/nextjs`: the same API as route handlers, a dashboard at `/`, and `/browse`, a client page that fetches the
export as packed bytes, opens it with `packmem/wasm` and scrolls it with `useRows`.

```sh
cd demos/nextjs && npm install && npm run build && npm start   # port 3002
```

Shows: `serverExternalPackages`, `respond` in a route handler, serving the `.wasm` file, and a virtualized list
that holds objects only for the rows on screen. The [Next.js guide](/docs/nextjs/) walks through it.

## FastAPI

`demos/fastapi`: the same routes in Python, including the byte export.

```sh
cd demos/fastapi
uv venv .venv && uv pip install --python .venv/bin/python -r requirements.txt ../../python/dist/packmem-*.whl
MODE=packmem .venv/bin/uvicorn app:app --port 3003
```

Shows: a Python server's memory with a list of dicts against a packmem table, and `iter_json` streaming.

All three servers can load from Postgres instead of the file: set `FLIGHTS_PG_URL` (setup in the demos README).

## Cloudflare Workers

`demos/workers`: a synthetic web log held in a Worker through `packmem/wasm`, with `/stats` (a filtered group count
and sum) and `/export` (matching rows streamed as JSON). `MODE=plain` holds the same rows as objects.

```sh
cd demos/workers && npm install
npx wrangler dev        # http://localhost:8787/stats?country=SE&path=/api
node bench.mjs          # both modes at 200,000 and 1,000,000 rows
```

Shows: `initSync` with an imported `.wasm` module, and packmem inside a 128 MB isolate.

## Fine-tuning data loader

`demos/finetune-loader`: a PyTorch `DataLoader` over LLaVA instruction data with the annotations held four ways: a
list of dicts, Hugging Face `datasets`, packmem `share()` and packmem `open()` of a saved table. It measures the
parent and every worker.

```sh
pip install torch datasets psutil huggingface_hub packmem
python run.py --mode list
python run.py --mode packmem-open
```

Shows: one changed line in a training loader, and how much memory each worker holds under fork and spawn.
