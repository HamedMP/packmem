// Blog posts. Every figure is read from the results files through lib/data, like the rest of the site.
import "server-only"

import { Code } from "@/components/site/code"
import { CompareBars } from "@/components/site/charts"
import * as d from "@/lib/data"
import { mb, size } from "@/lib/format"

export type Post = { slug: string; title: string; date: string; summary: string; Body: () => React.ReactNode }

const hl = d.hfLinux

function P({ children }: { children: React.ReactNode }) {
  return <p className="leading-relaxed text-foreground/90">{children}</p>
}
function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="mt-6 text-xl font-medium tracking-tight">{children}</h2>
}
function C({ children }: { children: React.ReactNode }) {
  return <code className="font-mono text-[0.85em]">{children}</code>
}
function A({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="underline underline-offset-4" href={href}>
      {children}
    </a>
  )
}
function Ul({ children }: { children: React.ReactNode }) {
  return <ul className="flex list-disc flex-col gap-2 pl-5 leading-relaxed text-foreground/90">{children}</ul>
}

const RESULT = `${d.REPO}/blob/main/benchmarks/ml_swaps/hf-datasets/pypi-0.2.0/RESULT_0.2.0.md`
const ISSUE = "https://github.com/pytorch/pytorch/issues/13246"

function LoaderBars() {
  if (!hl) return null
  const f = hl.forkserver
  return (
    <CompareBars
      unit="size"
      caption={`Peak memory of the parent and its ${hl.workers} forkserver workers together (PSS), Linux, ${hl.records.toLocaleString("en-US")} LLaVA records, medians of 3 runs.`}
      rows={[
        { label: "Python list from json.load", value: f.list.machineMb },
        { label: "Hugging Face datasets, memory-mapped Arrow", value: f.hf.machineMb },
        { label: "packmem 0.2.0 save() + open()", value: f.open.machineMb, hi: true },
      ]}
    />
  )
}

const LOADER = `import os
import packmem
from torch.utils.data import Dataset

class Conversations(Dataset):
    def __init__(self, path):
        # was: self.rows = json.load(open(path))
        saved = path + ".pkm"
        if not os.path.exists(saved):  # once, like an Arrow cache
            packmem.load_json(path).save(saved)
        self.rows = packmem.open(saved)  # memory-mapped

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, i):
        return self.rows[i]  # a dict, built on demand`

function DataLoaderPost() {
  if (!hl) return null
  const f = hl.forkserver
  return (
    <>
      <P>
        PyTorch issue <A href={ISSUE}>#13246</A>, &ldquo;DataLoader num_workers &gt; 0 causes CPU memory from parent process to be
        replicated in all worker processes&rdquo;, has been open since October 2018. On
        the {hl.records.toLocaleString("en-US")}-record LLaVA annotation mix with {hl.workers} workers, a plain list took{" "}
        {size(f.list.machineMb)} of memory across the machine, and the first batch arrived after {f.list.firstBatchS.toFixed(0)} seconds.
        With packmem 0.2.0 the same loader took {mb(f.open.machineMb)}, and the first batch arrived in {f.open.firstBatchS.toFixed(1)} s.
      </P>

      <H2>Why every worker ends up with a copy</H2>
      <P>
        Vision-language fine-tuning scripts in the LLaVA tradition load the whole annotation file in the dataset&apos;s constructor:{" "}
        <C>self.list_data_dict = json.load(open(path))</C>. That is a list of dicts with nested conversation turns, millions of
        Python objects.
      </P>
      <Ul>
        <li>
          <b className="font-medium">With fork,</b> workers start out sharing the parent&apos;s memory pages, copy-on-write. But Python
          writes to every object it reads: indexing a dict changes its reference count, and the garbage collector writes to it when it runs. Each page touched that way is copied into the worker, and over an epoch every worker builds its own copy.
        </li>
        <li>
          <b className="font-medium">With spawn or forkserver,</b> the default on macOS and, from Python 3.14, on Linux, nothing is
          shared at all: the dataset is pickled and sent to each worker. Here that was {size(f.list.sentBytes / 1e6)} of pickle per
          worker, sent before the first batch could start.
        </li>
      </Ul>
      <P>
        The usual advice in the issue is to hold the data as NumPy arrays or tensors, which works for numbers but not for nested
        conversation text. <C>gc.freeze()</C> stops the collector&apos;s writes but not the reference counts, and does nothing under
        spawn. An open pull request, <A href="https://github.com/pytorch/pytorch/pull/191555">#191555</A>, proposes a{" "}
        <C>SharedList</C> for PyTorch itself: it pickles each record into one shared-memory buffer that workers read without copying.
        Its maintainers have asked for a design review first.
      </P>

      <H2>The fix: one memory-mapped file for every worker</H2>
      <P>
        packmem keeps records as packed columns and reads them without unpacking. In 0.2.0, a table saved with <C>save()</C> is
        memory-mapped by <C>packmem.open()</C>, which takes milliseconds whatever its size. Each worker receives a handle of{" "}
        {f.open.sentBytes} bytes instead of a pickle, and the parent and every worker read the same pages. Reading a row builds a dict
        on demand, so there are no long-lived Python objects to copy. The change is in the datasetThe change to the dataset is two lines:apos;s constructor:
      </P>
      <Code install="pip install packmem" lang="python">
        {LOADER}
      </Code>
      <LoaderBars />
      <P>
        Hugging Face <C>datasets</C> also memory-maps its data, and it is a good answer. packmem used{" "}
        {Math.round((1 - f.open.machineMb / f.hf.machineMb) * 100)}% less memory across the machine ({mb(f.open.machineMb)} against{" "}
        {mb(f.hf.machineMb)}). Most of the difference is that every worker imports the library it reads with: {mb(hl.importMb.datasets)}{" "}
        for <C>datasets</C> against {mb(hl.importMb.packmem)} for packmem. The file is also {(hl.fileMb.arrow / hl.fileMb.packmem).toFixed(1)}{" "}
        times smaller ({mb(hl.fileMb.packmem)} against a {mb(hl.fileMb.arrow)} Arrow cache), and packmem takes the JSON as it is, with
        no schema to declare. With fork workers the machine held {mb(hl.fork.open.machineMb)} with packmem against{" "}
        {mb(hl.fork.hf.machineMb)} with <C>datasets</C> and {size(hl.fork.list.machineMb)} with a list.
      </P>

      <H2>What this does not show</H2>
      <Ul>
        <li>
          It measures the annotations only: no images, model or GPU. It is what holding and serving the records costs, which is the
          part that runs out of memory.
        </li>
        <li>
          Memory held to within about 1 MB across runs; the server was shared, with a load of 10 to 27, so timings are indicative.
        </li>
        <li>
          <C>datasets</C> is about twice as fast for batched access (<C>ds[i:i+64]</C>), and parsing JSON into packmem the first time
          is slower than <C>json.load</C>. The saved file is reused after that.
        </li>
        <li>
          {hl.forkserver.sameBatches ? "Every variant produced identical batches. " : ""}The scripts, raw results and the full write-up
          are in the repository: <A href={RESULT}>RESULT_0.2.0.md</A>.
        </li>
      </Ul>
    </>
  )
}

const OPEN = `import packmem

packmem.load_json("annotations.json").save("annotations.pkm")  # once

rows = packmem.open("annotations.pkm")  # milliseconds, whatever the size
rows[0]["conversations"][0]["value"]`

const NODE_SHARE = `// main thread
import { Worker } from "node:worker_threads"
import { loadJsonl } from "packmem"

const rows = loadJsonl("logs.jsonl")
new Worker("./worker.js", { workerData: rows.share() })

// worker.js
import { workerData } from "node:worker_threads"
import { Table } from "packmem"

const shared = Table.fromShared(workerData) // the same table, no copy
shared.count({ status: 404 })`

function ReleasePost() {
  if (!hl) return null
  const f = hl.forkserver
  return (
    <>
      <P>
        packmem 0.2.0 is on PyPI and npm. A saved table can now be memory-mapped and read in place, so every process on a machine reads
        one copy of the data. In a PyTorch DataLoader with {hl.workers} workers over {hl.records.toLocaleString("en-US")} LLaVA records,
        that took the whole machine from {size(f.list.machineMb)} with a Python list, and {mb(f.hf.machineMb)} with Hugging Face{" "}
        <C>datasets</C>, to {mb(f.open.machineMb)}.
      </P>

      <H2>save() and open()</H2>
      <Code install="pip install -U packmem" lang="python">
        {OPEN}
      </Code>
      <P>
        <C>open()</C> maps the file and reads rows, filters and JSON output straight from it. The process that opens it costs almost no
        memory of its own: the pages belong to the page cache, shared by every process that maps the file. Pickling an opened table
        sends only its path, so workers that receive it map the same pages.
      </P>

      <H2>Also in 0.2.0</H2>
      <Ul>
        <li>
          <C>share()</C> tables are read in place by the processes that receive them, and by the process that shared them: the data
          exists once, in the file&apos;s pages, instead of once per worker.
        </li>
        <li>
          <C>Table.__getitems__</C> fetches a batch of records in one call; PyTorch&apos;s DataLoader uses it when it is there.
        </li>
        <li>
          Node: <C>Table#share()</C>, <C>Table.fromShared(handle)</C> and <C>unshare()</C> let worker threads read one table without
          a copy. Native builds also take <C>PACKMEM_LOAD_THREADS=1</C> for the file loaders.
        </li>
      </Ul>
      <Code install="npm install packmem@0.2.0" lang="typescript">
        {NODE_SHARE}
      </Code>

      <H2>Upgrading</H2>
      <P>
        The byte form changed so arrays are aligned and can be read in place: pickles, <C>share()</C> files and <C>to_bytes</C> output
        from 0.1.x cannot be read by 0.2.0, and the reverse. Rebuild saved data from its source after upgrading. On Windows,{" "}
        <C>save</C> over a file that is open anywhere fails with an explanation; close the tables that have it open first.
      </P>

      <H2>Next</H2>
      <P>
        On main and not yet released: lists of records (the turns of a conversation) stored as sub-columns, the layout Arrow uses for a
        list of structs, with pandas-style operations on them; an opt-in <C>hint=&quot;compact&quot;</C> that compresses long text with
        Zstandard; and conversion to and from Arrow tables. The full list is in the{" "}
        <A href={`${d.REPO}/blob/main/CHANGELOG.md`}>changelog</A>, and the measurements behind this post are in{" "}
        <A href={RESULT}>RESULT_0.2.0.md</A>.
      </P>
    </>
  )
}

/** Newest first. */
export const posts: Post[] = [
  {
    slug: "dataloader-workers-copy-your-dataset",
    title: "Why every DataLoader worker holds a copy of your dataset",
    date: "2026-11-14",
    summary: hl
      ? `PyTorch issue #13246, open since 2018, and a two-line fix: ${size(hl.forkserver.list.machineMb)} to ${mb(hl.forkserver.open.machineMb)} for ${hl.workers} workers over 665k fine-tuning records.`
      : "PyTorch issue #13246, open since 2018, and a two-line fix.",
    Body: DataLoaderPost,
  },
  {
    slug: "packmem-0-2-0",
    title: "packmem 0.2.0: one memory-mapped table for every worker",
    date: "2026-11-14",
    summary: "save() and open(), zero-copy share() in Python and Node worker threads, and a new byte form.",
    Body: ReleasePost,
  },
]

export const post = (slug: string) => posts.find((p) => p.slug === slug)

export const longDate = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" })
