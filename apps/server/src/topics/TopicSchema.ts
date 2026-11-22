import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Atelier fork tables, created outside the numbered migrations: the migrator skips ids at or
 * below the latest recorded one, so a fork migration would collide with a later upstream one.
 * Fork tables never reference upstream tables, which upstream may rebuild.
 */
export const ensureTopicTables = Effect.fn("TopicSchema.ensureTopicTables")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS atelier_thread_topics (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      title TEXT NOT NULL,
      order_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS atelier_thread_topics_project_idx
    ON atelier_thread_topics(project_id, order_key)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS atelier_thread_topic_members (
      thread_id TEXT PRIMARY KEY,
      topic_id TEXT NOT NULL REFERENCES atelier_thread_topics(id) ON DELETE CASCADE
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS atelier_thread_topic_members_topic_idx
    ON atelier_thread_topic_members(topic_id)
  `;
});
