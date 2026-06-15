// Read-only SQLite query helper for the nanoclaw agent.
// The agent container has `bun` but no `sqlite3`/`python3`, so we use bun:sqlite.
// Deployed by setup/garmin/install.sh into the nanoclaw group folder, where it is
// visible to the agent at /workspace/agent/query.js.
//
// Usage (inside the agent): bun /workspace/agent/query.js "SELECT ..."
import { Database } from "bun:sqlite";

const DB_PATH = "/workspace/agent/garmin_data.db";
const sql = process.argv[2];
if (!sql) {
  console.error('usage: bun query.js "SELECT ..."');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
try {
  console.log(JSON.stringify(db.query(sql).all(), null, 2));
} finally {
  db.close();
}
