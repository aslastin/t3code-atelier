import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("legacy ACP proposals", (it) => {
  it.effect("restores a captured proposal and keeps an implemented one closed", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 105 });
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id,thread_id,node_id,kind,status,payload_json)
        VALUES ('stale','implemented','old-node','proposed_plan','active','{"status":"active"}')`;
      for (const id of ["older", "waiting", "implemented", "archived", "other"]) {
        yield* sql`INSERT INTO orchestration_v2_projection_plans
          (plan_id,thread_id,node_id,kind,status,payload_json)
          VALUES (${id}, ${id === "older" ? "waiting" : id}, ${id}, 'proposed_plan', 'completed', '{"status":"completed"}')`;
        const item = {
          planId: id,
          nativeItemRef: { nativeId: id === "other" ? "other" : id + ":proposed-plan" },
        };
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id,thread_id,node_id,ordinal,type,status,updated_at,payload_json)
          VALUES (${id}, ${id === "older" ? "waiting" : id}, ${id}, 0, 'proposed_plan', 'completed', '2026-11-01', ${JSON.stringify(item)})`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
        VALUES ('run','destination',1,'grok','completed','2026-11-01',
          '{"sourcePlanRef":{"threadId":"implemented","planId":"implemented"}}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads
        (thread_id,project_id,title,default_provider,runtime_mode,interaction_mode,created_at,updated_at,archived_at,payload_json)
        VALUES ('archived-destination','project','Archived','grok','auto','default','2026-11-01','2026-11-01','2026-11-02','{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_runs
        (run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
        VALUES ('archived-run','archived-destination',1,'grok','completed','2026-11-01',
          '{"sourcePlanRef":{"threadId":"archived","planId":"archived"}}')`;
      for (const stopped of ["rolled_back", "interrupted"]) {
        for (const [index, runStatus, planStatus] of [
          [1, "completed", "superseded"],
          [2, stopped, "active"],
        ] as const) {
          const id = stopped + index;
          yield* sql`INSERT INTO orchestration_v2_projection_runs
            (run_id,thread_id,ordinal,provider,status,requested_at,payload_json)
            VALUES (${id}, ${stopped}, ${index}, 'codex', ${runStatus}, '2026-11-01', '{}')`;
          yield* sql`INSERT INTO orchestration_v2_projection_plans
            (plan_id,thread_id,run_id,node_id,kind,status,payload_json)
            VALUES (${id}, ${stopped}, ${id}, ${id}, 'proposed_plan', ${planStatus}, ${JSON.stringify({ status: planStatus })})`;
          if (runStatus === "interrupted") {
            yield* sql`INSERT INTO orchestration_v2_projection_turn_items
              (turn_item_id,thread_id,run_id,node_id,ordinal,type,status,updated_at,payload_json)
              VALUES (${id}, ${stopped}, ${id}, ${id}, 1, 'proposed_plan', 'running', '2026-11-01',
                ${JSON.stringify({ planId: id, streaming: true })})`;
          }
        }
      }
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id,thread_id,node_id,kind,status,payload_json) VALUES ('unfinished','waiting','next','proposed_plan','draft','{"status":"draft"}')`;
      yield* sql`UPDATE orchestration_v2_projection_plans SET payload_json = json_set(payload_json,
        '$.id', plan_id, '$.threadId', thread_id, '$.nodeId', node_id, '$.runId', run_id, '$.kind', kind, '$.markdown', '# Plan')`;
      yield* runMigrations();
      const stoppedPlans =
        yield* sql`SELECT status, json_extract(payload_json, '$.status') AS payload_status
        FROM orchestration_v2_projection_plans WHERE thread_id IN ('rolled_back', 'interrupted') ORDER BY plan_id`;
      assert.deepEqual(
        stoppedPlans.map((p) => [p.status, p.payload_status]),
        [
          ["active", "active"],
          ["draft", "draft"],
          ["active", "active"],
          ["superseded", "superseded"],
        ],
      );
      const rows =
        yield* sql`SELECT status, json_extract(payload_json,'$.status') AS payload_status,
        json_extract(payload_json,'$.implementationThreadId') AS destination
        FROM orchestration_v2_projection_plans WHERE thread_id NOT IN ('rolled_back', 'interrupted') ORDER BY plan_id`;
      assert.deepEqual(rows, [
        { status: "completed", payload_status: "completed", destination: null },
        { status: "completed", payload_status: "completed", destination: "destination" },
        { status: "superseded", payload_status: "superseded", destination: null },
        { status: "completed", payload_status: "completed", destination: null },
        { status: "superseded", payload_status: "superseded", destination: null },
        { status: "draft", payload_status: "draft", destination: null },
        { status: "active", payload_status: "active", destination: null },
      ]);
    }),
  );
});

it.effect("reopens a ready ACP proposal hidden by a draft in a previously repaired database", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 105 });
    yield* sql`CREATE TABLE atelier_migrations (name TEXT PRIMARY KEY)`;
    yield* sql`INSERT INTO atelier_migrations VALUES ('plan-history-v1')`;
    for (const [id, status] of [
      ["ready", "superseded"],
      ["unfinished", "draft"],
    ] as const) {
      yield* sql`INSERT INTO orchestration_v2_projection_plans(plan_id,thread_id,node_id,kind,status,payload_json)
        VALUES (${id},'source',${id},'proposed_plan',${status},${JSON.stringify({ id, threadId: "source", nodeId: id, runId: null, kind: "proposed_plan", status, markdown: id })})`;
    }
    yield* sql`INSERT INTO orchestration_v2_projection_turn_items(turn_item_id,thread_id,node_id,ordinal,type,status,updated_at,payload_json)
      VALUES ('item','source','ready',0,'proposed_plan','completed','2026-11-01','{"planId":"ready","nativeItemRef":{"nativeId":"old:proposed-plan"}}')`;
    yield* runMigrations();
    yield* runMigrations();
    assert.deepEqual(
      yield* sql`SELECT status FROM orchestration_v2_projection_plans ORDER BY rowid`,
      [{ status: "active" }, { status: "draft" }],
    );
    assert.deepEqual(
      yield* sql`SELECT json_extract(payload_json,'$.id') AS id FROM orchestration_events WHERE event_type='plan.updated'`,
      [{ id: "ready" }],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
