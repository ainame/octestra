import { readFile } from "node:fs/promises";

const lines = (await readFile(process.argv[2] ?? ".github/octestra/config.yml", "utf8")).split("\n");
function scalar(section, key) {
  const sectionIndex = lines.findIndex((line) => new RegExp(`^${section}:\\s*(?:#.*)?$`).test(line.trim()));
  if (sectionIndex < 0) throw new Error(`Missing ${section}`);
  for (const line of lines.slice(sectionIndex + 1)) {
    if (/^\S/.test(line)) break;
    const match = line.match(new RegExp(`^  ${key}:\\s*["']?([^"'#\\n]+)`));
    if (match?.[1]?.trim()) return match[1].trim();
  }
  throw new Error(`Missing ${section}.${key}`);
}
const values = {
  OCTESTRA_GITHUB_APP_CLIENT_ID: scalar("github_app", "client_id"),
  OCTESTRA_ORCHESTRATION_RUNNER: scalar("runners", "orchestration"),
  OCTESTRA_AGENT_RUNNER: scalar("runners", "agent"),
  OCTESTRA_STATUS_FIELD_ID: scalar("status", "field_id"),
};
for (const [name, value] of Object.entries(values)) console.log(`${name}=${value}`);
