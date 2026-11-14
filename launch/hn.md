# Hacker News

**Title** (Show HN, under 80 characters):

    Show HN: Packmem – a one-line replacement for a list of dicts, 36x less memory

  Alternative, leading with the DataLoader result:

    Show HN: Packmem – PyTorch DataLoader workers share one copy, 16 GB to 1.1 GB

**URL:** https://hamedmp.github.io/packmem/

**First comment** (post right after submitting):

    I built packmem after measuring what a Python process actually holds after json.loads: in our test, 77% of the
    heap words were zeros, pointers and small integers, not data. packmem keeps records as packed columns (dictionary,
    frame-of-reference, run-length and FSST encodings, picked per column from a sample) behind the list-of-dicts and
    array-of-objects APIs people already use, so the switch is one line. It is alpha (0.2.0).

    On 336,776 real flights (Mac figures, on a machine in normal use): 712 MB as a list of dicts, 19.7 MB in packmem; filters and group-bys run on the packed
    columns (group by destination: 59 ms to 0.14 ms). Inside FastAPI, Express and Next.js servers it cut settled
    memory 10x, 4x and 3.5x with identical responses.

    New in 0.2.0: save() once and packmem.open() memory-maps the table, so PyTorch DataLoader workers read one copy
    instead of each holding their own (pytorch#13246, open since 2018). On Linux, 4 forkserver workers over the
    665,298-record LLaVA annotation mix: 15,961 MB with a list, 1,810 MB with Hugging Face datasets, 1,144 MB with
    packmem; first batch 63.5 s, 1.8 s, 1.0 s. Most of datasets' extra is each worker importing the library (55 MB),
    not data, and datasets is still about 2x faster for batched access. Write-up:
    https://hamedmp.github.io/packmem/blog/dataloader-workers-copy-your-dataset/

    Where it loses, honestly: plain loops over every row are 4.9x slower (each row is rebuilt on demand; lazy rows or
    queries fix that), random row access 6.7x slower, sort/insert/delete rebuild the table, high-cardinality group-by is far behind polars, and polars tuned
    for memory comes within 1.6 to 2.9x. It is not a dataframe.

    Python, Node (native addon plus a WebAssembly build for Cloudflare Workers) and a Rust core, Apache-2.0. Every
    number on the page is rebuilt from the results files in the repo. I'd love to hear where it breaks.
