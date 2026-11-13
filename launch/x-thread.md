# X / Bluesky thread

1/ Most of the memory behind a list of records isn't the records. Load 336,776 flight records into a Python list of dicts: 712 MB.
Pack the same records into columns your code can still index and query: 19.7 MB. That's packmem, one line to switch.
https://hamedmp.github.io/packmem/

2/ Why: in a Python heap holding parsed JSON, 77% of the words were zeros, pointers and small integers. Object
headers and references, not your data. packmem never creates them: each field becomes a packed column.

3/ Filters run on the packed form, so they got faster too: group by destination 59 ms → 0.14 ms. In a FastAPI server
holding the data, 731 MB → 72 MB at rest, identical responses.

4/ Where it loses: a plain loop over every row is 4.9x slower, random row access 6.7x slower, and polars tuned for
memory comes within 1.6–2.9x. It's not a dataframe.

5/ Alpha (0.1.1). Python, Node and a WebAssembly build for Cloudflare Workers, Rust core, Apache-2.0.
pip install packmem / npm install packmem — every number on the site is rebuilt from the results files in the repo.
