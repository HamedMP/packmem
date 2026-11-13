import { execFileSync } from "node:child_process";
import { copyFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const profile = process.argv.includes("--debug") ? "debug" : "release";
execFileSync("cargo", ["build", ...(profile === "release" ? ["--release"] : [])], { cwd: root, stdio: "inherit" });

const lib = { darwin: "libpackmem_node.dylib", linux: "libpackmem_node.so", win32: "packmem_node.dll" }[process.platform];
if (!lib) throw new Error(`unsupported platform ${process.platform}`);
const out = `packmem.${process.platform}-${process.arch}.node`;
// remove first: overwriting a loaded binary in place keeps its inode, and macOS then kills any process that loads it
rmSync(join(root, out), { force: true });
copyFileSync(join(root, "target", profile, lib), join(root, out));
console.log(`built ${out}`);
