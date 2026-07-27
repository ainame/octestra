import { readFile } from "node:fs/promises";
import { parse } from "yaml";
const config = parse(await readFile(process.argv[2] ?? ".github/octestra/config.yml", "utf8"));
const values = {
  OCTESTRA_GITHUB_APP_CLIENT_ID: config.github_app.client_id,
  OCTESTRA_ORCHESTRATION_RUNNER: config.runners.orchestration,
  OCTESTRA_AGENT_RUNNER: config.runners.agent,
  OCTESTRA_STATUS_FIELD_ID: String(config.status.field_id),
};
for (const [name, value] of Object.entries(values)) { if (!value) throw new Error(`Missing ${name}`); console.log(`${name}=${value}`); }
