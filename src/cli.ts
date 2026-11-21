#!/usr/bin/env node
const [command] = process.argv.slice(2);

if (command === undefined || command === "--help" || command === "-h") {
  console.log("bundle-gate: gate Next.js route bundle size in CI.\n\nUsage: bundle-gate check");
  process.exit(0);
}

console.error(`bundle-gate: "${command}" is not implemented yet.`);
process.exit(1);
