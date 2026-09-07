// Usage:
//   pnpm seed org <name> [id]
//   pnpm seed project <id> <name> [repo] [org-id]
//
// Members and their roles are NOT seeded here: better-auth is the only auth.
// People onboard via email sign-in (creating their own org + project) and mint
// headless API keys for coders from the dashboard.
import { openDb, openPostgresDb } from "../src/db.js";
import { Admin } from "../src/admin.js";

const [cmd, ...rest] = process.argv.slice(2);
const db = process.env.DATABASE_URL
  ? await openPostgresDb(process.env.DATABASE_URL)
  : openDb(process.env.MEMRACER_DB_PATH ?? "memracer.db");
const admin = new Admin(db);
const usage = () => {
  console.error(
    "usage:\n  pnpm seed org <name> [id]\n  pnpm seed project <id> <name> [repo] [org-id]",
  );
  process.exit(1);
};

switch (cmd) {
  case "org": {
    const [name, idArg] = rest;
    if (!name) usage();
    const org = await admin.createOrg(name, idArg);
    console.log(`org ${org.id} ("${name}")`);
    break;
  }
  case "project": {
    const [id, name, repo, orgId] = rest;
    if (!id || !name) usage();
    const project = await admin.createProject(id, name, { repo, orgId });
    console.log(`project ${project.id} ("${name}")${repo ? ` repo ${repo}` : ""}${orgId ? ` org ${orgId}` : ""}`);
    break;
  }
  default:
    usage();
}
await db.close();
