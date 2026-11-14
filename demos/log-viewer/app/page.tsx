import { Viewer } from "./viewer";

export default function Page() {
  return (
    <main>
      <header>
        <p className="eyebrow">packmem · log viewer</p>
        <h1>A million log lines in the browser</h1>
        <p className="lede">
          The server builds the logs once as a packmem table. This page fetches them with <code>useTable</code>, which
          asks for packmem bytes and opens them with <code>packmem/wasm</code> without parsing, and{" "}
          <code>useRows</code> builds objects only for the rows on screen. Switch to <strong>plain JSON</strong> to load
          the same rows the usual way, with <code>res.json()</code>, and compare the numbers.
        </p>
      </header>
      <Viewer />
      <footer>
        JS heap is Chrome&apos;s <code>performance.memory</code>; packmem&apos;s rows live in WebAssembly memory, shown
        as the packed table size. Numbers vary with the machine, the network and the browser.
      </footer>
    </main>
  );
}
