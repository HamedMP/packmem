import { execFileSync } from "node:child_process";
import { copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv.includes("--debug") ? "debug" : "release";
execFileSync("cargo", ["build", ...(profile === "release" ? ["--release"] : [])], { cwd: root, stdio: "inherit" });

const lib = { darwin: "libpackmem_node.dylib", linux: "libpackmem_node.so", win32: "packmem_node.dll" }[process.platform];
if (!lib) throw new Error(`unsupported platform ${process.platform}`);
const out = `packmem.${process.platform}-${process.arch}.node`;
copyFileSync(join(root, "target", profile, lib), join(root, out));
console.log(`built ${out}`);
