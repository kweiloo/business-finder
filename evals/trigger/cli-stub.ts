// Stand-in for src/cli/main.ts in the local mirror the link-plus-task prompts
// install from. install.ps1 runs for real against that mirror; afterwards every
// `business-finder` call lands here. It logs its arguments to BF_TRIGGER_LOG and
// prints a canned result, so no Google Maps search runs. Only `serve` reaches the
// real CLI, because install.ps1 waits for the real server to answer.
import { appendFileSync } from "node:fs";
import { main } from "./main.real.js";

const args = process.argv.slice(2);
const log = process.env.BF_TRIGGER_LOG;
if (log) appendFileSync(log, `${new Date().toISOString()}\t${args.join(" ")}\n`);

const out = (line: string) => process.stdout.write(`${line}\n`);
switch (args[0] ?? "") {
  case "serve":
    process.exitCode = await main(args, {
      out,
      err: (line) => process.stderr.write(`${line}\n`),
      env: process.env,
      cwd: process.cwd(),
      now: () => new Date(),
    });
    break;
  case "doctor":
    out("Business Finder 0.1.0: ready.");
    break;
  case "lists":
    out("No saved lists yet.");
    break;
  case "scrape":
    out("Searching around the requested place.");
    out("100 places found, 94 with a phone, WhatsApp or email.");
    out("saved as list eval0001. Run business-finder serve to see it.");
    break;
  default:
    out("Business Finder 0.1.0. Commands: doctor, lists, scrape, add, serve, delete.");
}
