#!/usr/bin/env node
import { runAgentCli } from "../src/agent/cli.js";

try {
  await runAgentCli(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
