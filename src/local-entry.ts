#!/usr/bin/env node
import { runLocalCommand } from './local-cli.js';

runLocalCommand(process.argv.slice(2)).catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
