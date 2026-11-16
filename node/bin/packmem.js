#!/usr/bin/env node
import { run, version } from "../archive/cli.js";

const [command, ...rest] = process.argv.slice(2);
if (command === "--version" || command === "-v") {
  process.stdout.write(`${version()}\n`);
} else if (command === "archive") {
  run(rest).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`packmem archive: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
} else {
  process.stdout.write("packmem: packed columns for arrays of records.\n\nCommands\n  packmem archive   keep AI coding-agent history, compressed (packmem archive --help)\n  packmem --version\n\nThe library: https://hamedmp.github.io/packmem/\n");
  process.exitCode = command === undefined || command === "--help" || command === "-h" ? 0 : 2;
}
