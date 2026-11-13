# Hacker News

**Title** (Show HN, under 80 characters):

    Show HN: Packmem – a list of dicts in 1/36th of the memory, still a list

**URL:** https://hamedmp.github.io/packmem/

**First comment** (post right after submitting):

    I built packmem after measuring what a Python process actually holds after json.loads: in our test, 77% of the
    heap words were zeros, pointers and small integers, not data. packmem keeps records as packed columns (dictionary,
    frame-of-reference, run-length and FSST encodings, picked per column from a sample) behind the list-of-dicts and
    array-of-objects APIs people already use, so the switch is one line.

    On 336,776 real flights: 712 MB as a list of dicts, 19.7 MB in packmem; filters and group-bys run on the packed
    columns (group by destination: 59 ms to 0.14 ms). Inside FastAPI, Express and Next.js servers it cut settled
    memory 10x, 4x and 3.5x with identical responses.

    Where it loses, honestly: plain loops over every row are 4.9x slower (each row is rebuilt on demand; lazy rows or
    queries fix that), random row access 6.7x slower, high-cardinality group-by is far behind polars, and polars tuned
    for memory comes within 1.6 to 2.9x. It is not a dataframe.

    Python, Node (native addon plus a WebAssembly build for Cloudflare Workers) and a Rust core, Apache-2.0. Every
    number on the page is rebuilt from the results files in the repo. I'd love to hear where it breaks.
