import { Browser } from "./browser";

export const metadata = { title: "packmem flights in the browser" };

export default function Page() {
  return (
    <main>
      <header>
        <p className="eyebrow">packmem · WebAssembly in the browser</p>
        <h1>The export, opened in the browser</h1>
        <p className="lede">
          This page fetches <code>/api/flights/export</code> asking for packmem bytes, opens them with{" "}
          <code>packmem/wasm</code> without parsing, and builds objects only for the rows on screen with{" "}
          <code>useRows</code> from <code>packmem/react</code>.
        </p>
      </header>
      <Browser />
    </main>
  );
}
