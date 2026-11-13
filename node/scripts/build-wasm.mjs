// Builds the WebAssembly binding into wasm-dist/: cargo for wasm32, then wasm-bindgen (same version as the crate).
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const crate = join(root, "wasm");
execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], { cwd: crate, stdio: "inherit" });
rmSync(join(root, "wasm-dist"), { recursive: true, force: true });
execFileSync(
  "wasm-bindgen",
  ["--target", "web", "--out-dir", join(root, "wasm-dist"), "--out-name", "packmem", join(crate, "target/wasm32-unknown-unknown/release/packmem_wasm.wasm")],
  { stdio: "inherit" },
);
console.log("built wasm-dist/packmem.js and wasm-dist/packmem_bg.wasm");
