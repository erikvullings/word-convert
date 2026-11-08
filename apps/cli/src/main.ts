#!/usr/bin/env bun
import { runCli } from './cli.ts';

process.exitCode = await runCli(process.argv.slice(2), {
  stdout: (data) =>
    new Promise<void>((resolve, reject) => {
      process.stdout.write(data, (error) => {
        if (error) reject(error);
        else resolve();
      });
    }),
  stderr: (message) => {
    process.stderr.write(message);
  },
});
