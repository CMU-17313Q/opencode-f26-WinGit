import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261001154021_session_auxiliary_usage",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_auxiliary_usage\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`data\` text NOT NULL,
          CONSTRAINT \`fk_session_auxiliary_usage_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(
        `CREATE INDEX \`session_auxiliary_usage_session_idx\` ON \`session_auxiliary_usage\` (\`session_id\`);`,
      )
    })
  },
} satisfies DatabaseMigration.Migration
