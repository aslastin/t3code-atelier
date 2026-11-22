import { EventId, OrchestrationV2PlanArtifact } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as OrchestrationEventStore from "./OrchestrationEventStore.ts";

const previewMigrations = new Map([
  [106, "ProposedPlanImplementations"],
  [107, "RevertedPlanImplementations"],
  [108, "ReplayRevertedPlans"],
]);
export const isAtelierPreviewMigration = (row: { readonly id: number; readonly name: string }) =>
  previewMigrations.get(row.id) === row.name;

const repair = "plan-history-v2";
const createLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS atelier_migrations (name TEXT PRIMARY KEY)`;
});

export const hasPendingPlanHistory = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const table =
    yield* sql`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'atelier_migrations'`;
  if (table.length === 0) return true;
  return (yield* sql`SELECT 1 FROM atelier_migrations WHERE name = ${repair}`).length === 0;
});

// Move only this fork's exact preview receipts before upstream validates or advances its ledger.
export const adoptPlanPreviewMigrations = Effect.fn("Atelier.adoptPlanPreviewMigrations")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    if (
      !(yield* sql`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'effect_sql_migrations'`)
        .length
    )
      return;
    const rows = yield* sql<{
      id: number;
      name: string;
    }>`SELECT migration_id AS id, name FROM effect_sql_migrations WHERE migration_id BETWEEN 106 AND 108`;
    const legacy = rows.filter(isAtelierPreviewMigration);
    if (!legacy.length) return;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* createLedger;
        for (const { id, name } of legacy) {
          yield* sql`INSERT OR IGNORE INTO atelier_migrations (name) VALUES (${name})`;
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = ${id} AND name = ${name}`;
        }
      }),
    );
  },
);

const decodePlan = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2PlanArtifact));

export const repairAtelierPlanHistory = Effect.fn("Atelier.repairPlanHistory")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const events = yield* OrchestrationEventStore.OrchestrationEventStore;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* createLedger;
      const done = new Set(
        (yield* sql<{ name: string }>`SELECT name FROM atelier_migrations`).map((row) => row.name),
      );
      if (done.has(repair)) return;
      const changed = new Set<string>();
      const collect = (rows: ReadonlyArray<{ plan_id: string }>) => {
        for (const row of rows) changed.add(row.plan_id);
      };
      yield* sql`CREATE INDEX IF NOT EXISTS atelier_plan_implementation_thread_idx
      ON orchestration_v2_projection_runs(thread_id)
      WHERE json_valid(payload_json) AND json_extract(payload_json, '$.sourcePlanRef') IS NOT NULL`;
      const previousRepair = done.has("plan-history-v1");
      if (!previousRepair && !done.has("ProposedPlanImplementations")) {
        collect(
          yield* sql<{ plan_id: string }>`
    UPDATE orchestration_v2_projection_plans AS plan
    SET payload_json = json_set(plan.payload_json, '$.implementationThreadId', run.thread_id)
    FROM orchestration_v2_projection_runs AS run
    WHERE plan.kind = 'proposed_plan' AND plan.status = 'completed'
      AND json_valid(run.payload_json) AND json_valid(plan.payload_json)
      AND json_extract(plan.payload_json, '$.implementationThreadId') IS NULL
      AND plan.plan_id = json_extract(run.payload_json, '$.sourcePlanRef.planId')
      AND plan.thread_id = json_extract(run.payload_json, '$.sourcePlanRef.threadId')
    RETURNING plan_id
  `,
        );
        // ACP marked its captured text complete before the user chose an implementation.
        collect(
          yield* sql<{ plan_id: string }>`
    UPDATE orchestration_v2_projection_plans AS plan
    SET (status, payload_json) = (
      SELECT new_status, json_set(plan.payload_json, '$.status', new_status) FROM (
        SELECT CASE WHEN EXISTS (
          SELECT 1 FROM orchestration_v2_projection_plans AS newer
          LEFT JOIN orchestration_v2_projection_runs AS owner ON owner.run_id = newer.run_id
          WHERE newer.thread_id = plan.thread_id AND newer.kind = 'proposed_plan'
            AND newer.rowid > plan.rowid AND newer.status <> 'draft' AND owner.status IS NOT 'rolled_back'
        ) THEN 'superseded' ELSE 'active' END AS new_status
      )
    )
    WHERE kind = 'proposed_plan' AND status = 'completed' AND json_valid(payload_json)
      AND json_extract(payload_json, '$.implementationThreadId') IS NULL
      AND EXISTS (
        SELECT 1 FROM orchestration_v2_projection_turn_items AS item
        WHERE item.node_id = plan.node_id AND item.thread_id = plan.thread_id
          AND item.type = 'proposed_plan' AND json_valid(item.payload_json)
          AND json_extract(item.payload_json, '$.planId') = plan.plan_id
          AND json_extract(item.payload_json, '$.nativeItemRef.nativeId') GLOB '*:proposed-plan'
      )
    RETURNING plan_id
  `,
        );
        // Earlier adapters could supersede a complete plan with a partial or later rolled-back turn.
        collect(
          yield* sql<{ plan_id: string }>`
    WITH discarded AS MATERIALIZED (
      SELECT plan.plan_id, plan.thread_id,
        CASE WHEN run.status = 'rolled_back' THEN 'superseded' ELSE 'draft' END AS replacement
      FROM orchestration_v2_projection_plans AS plan
      JOIN orchestration_v2_projection_runs AS run ON run.run_id = plan.run_id
      WHERE plan.kind = 'proposed_plan' AND plan.status IN ('active','superseded') AND json_valid(plan.payload_json)
        AND (run.status = 'rolled_back' OR (
          run.provider = 'codex' AND run.status IN ('cancelled','interrupted','failed') AND EXISTS (
            SELECT 1 FROM orchestration_v2_projection_turn_items AS item
            WHERE item.run_id = run.run_id AND item.type = 'proposed_plan' AND json_valid(item.payload_json)
              AND json_extract(item.payload_json, '$.planId') = plan.plan_id
              AND json_extract(item.payload_json, '$.streaming') = 1
          )
        ))
    ), surviving AS (
      SELECT plan.plan_id, plan.status,
        ROW_NUMBER() OVER (PARTITION BY plan.thread_id ORDER BY plan.rowid DESC) AS position
      FROM orchestration_v2_projection_plans AS plan
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = plan.run_id
      WHERE plan.thread_id IN (SELECT thread_id FROM discarded) AND plan.kind = 'proposed_plan'
        AND plan.status IN ('active','completed','superseded') AND run.status IS NOT 'rolled_back'
        AND plan.plan_id NOT IN (SELECT plan_id FROM discarded) AND json_valid(plan.payload_json)
    ), changes AS MATERIALIZED (
      SELECT plan_id, replacement FROM discarded
      UNION ALL SELECT plan_id, 'active' FROM surviving WHERE position = 1 AND status = 'superseded'
    )
    UPDATE orchestration_v2_projection_plans AS plan
    SET status = changes.replacement, payload_json = json_set(plan.payload_json, '$.status', changes.replacement)
    FROM changes WHERE changes.plan_id = plan.plan_id AND changes.replacement <> plan.status
    RETURNING plan_id
  `,
        );
        collect(
          yield* sql<{ plan_id: string }>`
    WITH versions AS MATERIALIZED (
      SELECT plan.plan_id, plan.status,
        ROW_NUMBER() OVER (PARTITION BY plan.thread_id ORDER BY plan.rowid DESC) AS position
      FROM orchestration_v2_projection_plans AS plan
      LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = plan.run_id
      WHERE plan.kind = 'proposed_plan' AND plan.status IN ('active','completed') AND run.status IS NOT 'rolled_back'
    )
    UPDATE orchestration_v2_projection_plans
    SET status = 'superseded', payload_json = json_set(payload_json, '$.status', 'superseded')
    WHERE plan_id IN (SELECT plan_id FROM versions WHERE position > 1 AND status = 'active') AND json_valid(payload_json)
    RETURNING plan_id
  `,
        );
        collect(
          yield* sql<{ plan_id: string }>`
    UPDATE orchestration_v2_projection_plans AS plan
    SET payload_json = json_remove(plan.payload_json, '$.implementationThreadId')
    FROM orchestration_v2_projection_threads AS destination
    WHERE plan.kind = 'proposed_plan' AND plan.status = 'completed' AND json_valid(plan.payload_json)
      AND destination.thread_id = json_extract(plan.payload_json, '$.implementationThreadId')
      AND (destination.archived_at IS NOT NULL OR destination.deleted_at IS NOT NULL)
    RETURNING plan_id
  `,
        );
      } else if (!previousRepair) {
        yield* sql`DROP INDEX IF EXISTS orchestration_v2_plan_implementation_thread_idx`;
      }
      if (!previousRepair && !done.has("RevertedPlanImplementations")) {
        collect(
          yield* sql<{ plan_id: string }>`
    WITH implementations AS (
      SELECT run_id, thread_id, json_extract(payload_json, '$.sourcePlanRef.planId') AS plan_id,
        ROW_NUMBER() OVER (attempts ORDER BY ordinal DESC) AS position,
        MAX(status <> 'rolled_back') OVER attempts AS retained
      FROM orchestration_v2_projection_runs
      WHERE json_valid(payload_json) AND json_extract(payload_json, '$.sourcePlanRef') IS NOT NULL
        AND json_extract(payload_json, '$.sourcePlanRef.threadId') = thread_id
      WINDOW attempts AS (PARTITION BY thread_id, json_extract(payload_json, '$.sourcePlanRef.planId'))
    ), reopened AS MATERIALIZED (
      SELECT plan.plan_id, impl.run_id,
        CASE WHEN owner.status = 'rolled_back' OR EXISTS (
          SELECT 1 FROM orchestration_v2_projection_plans AS newer
          LEFT JOIN orchestration_v2_projection_runs AS run ON run.run_id = newer.run_id
          WHERE newer.thread_id = plan.thread_id AND newer.kind = 'proposed_plan'
            AND newer.status <> 'draft' AND run.status IS NOT 'rolled_back' AND newer.rowid > plan.rowid
        ) THEN 'superseded' ELSE 'active' END AS next_status
      FROM implementations AS impl
      JOIN orchestration_v2_projection_plans AS plan ON plan.plan_id = impl.plan_id AND plan.thread_id = impl.thread_id
      LEFT JOIN orchestration_v2_projection_runs AS owner ON owner.run_id = plan.run_id
      WHERE impl.position = 1 AND impl.retained = 0 AND plan.kind = 'proposed_plan' AND plan.status = 'completed'
        AND json_valid(plan.payload_json) AND json_extract(plan.payload_json, '$.implementationThreadId') = plan.thread_id
    )
    UPDATE orchestration_v2_projection_plans AS plan
    SET status = reopened.next_status, payload_json = json_set(
      json_remove(plan.payload_json, '$.implementationThreadId'), '$.status', reopened.next_status,
      '$.lastRevertedImplementationRunId', reopened.run_id)
    FROM reopened WHERE plan.plan_id = reopened.plan_id
    RETURNING plan_id
  `,
        );
      }
      if (previousRepair || done.has("ProposedPlanImplementations")) {
        // Preview repairs treated an unfinished revision as a replacement for the last ready ACP plan.
        collect(
          yield* sql<{ plan_id: string }>`
          UPDATE orchestration_v2_projection_plans AS plan
          SET status = 'active', payload_json = json_set(payload_json, '$.status', 'active')
          WHERE plan.kind = 'proposed_plan' AND plan.status = 'superseded' AND json_valid(plan.payload_json)
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS owner WHERE owner.run_id = plan.run_id AND owner.status = 'rolled_back')
            AND EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items AS item
              WHERE item.thread_id=plan.thread_id AND item.node_id=plan.node_id AND item.type='proposed_plan'
                AND json_valid(item.payload_json) AND json_extract(item.payload_json,'$.planId')=plan.plan_id
                AND json_extract(item.payload_json,'$.nativeItemRef.nativeId') GLOB '*:proposed-plan')
            AND EXISTS (SELECT 1 FROM orchestration_v2_projection_plans AS newer
              WHERE newer.thread_id=plan.thread_id AND newer.kind='proposed_plan' AND newer.rowid>plan.rowid)
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_plans AS newer
              LEFT JOIN orchestration_v2_projection_runs AS owner ON owner.run_id=newer.run_id
              WHERE newer.thread_id=plan.thread_id AND newer.kind='proposed_plan' AND newer.rowid>plan.rowid
                AND newer.status <> 'draft' AND owner.status IS NOT 'rolled_back')
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs AS impl
              WHERE json_valid(impl.payload_json) AND json_extract(impl.payload_json,'$.sourcePlanRef') IS NOT NULL
                AND json_extract(impl.payload_json,'$.sourcePlanRef.threadId')=plan.thread_id
                AND json_extract(impl.payload_json,'$.sourcePlanRef.planId')=plan.plan_id)
          RETURNING plan_id`,
        );
      }
      if (!previousRepair && done.has("ProposedPlanImplementations")) {
        // Preview builds repaired projection rows in place. Publish any state missing from the event stream.
        collect(
          yield* sql<{ plan_id: string }>`
        WITH latest AS (
          SELECT json_extract(payload_json, '$.id') AS plan_id, MAX(sequence) AS sequence
          FROM orchestration_events WHERE application_event_version = 2 AND event_type = 'plan.updated'
          GROUP BY json_extract(payload_json, '$.id')
        )
        SELECT plan.plan_id FROM orchestration_v2_projection_plans AS plan
        LEFT JOIN latest USING (plan_id) LEFT JOIN orchestration_events AS event ON event.sequence = latest.sequence
        WHERE plan.kind = 'proposed_plan' AND json_valid(plan.payload_json) AND (
          event.sequence IS NULL OR plan.status IS NOT json_extract(event.payload_json, '$.status') OR
          json_extract(plan.payload_json, '$.implementationThreadId') IS NOT json_extract(event.payload_json, '$.implementationThreadId') OR
          json_extract(plan.payload_json, '$.lastRevertedImplementationRunId') IS NOT json_extract(event.payload_json, '$.lastRevertedImplementationRunId')
        )`,
        );
      }
      const occurredAt = yield* DateTime.now;
      for (const id of changed) {
        const [row] = yield* sql<{
          payload_json: string;
        }>`SELECT payload_json FROM orchestration_v2_projection_plans WHERE plan_id = ${id}`;
        const plan = yield* decodePlan(row!.payload_json);
        yield* events.appendAgentEvents({
          events: [
            {
              id: EventId.make(`atelier:${repair}:${id}`),
              type: "plan.updated",
              threadId: plan.threadId,
              nodeId: plan.nodeId,
              ...(plan.runId === null ? {} : { runId: plan.runId }),
              occurredAt,
              payload: plan,
            },
          ],
        });
      }
      yield* sql`INSERT INTO atelier_migrations (name) VALUES (${repair})`;
    }),
  );
}, Effect.provide(OrchestrationEventStore.layer));
