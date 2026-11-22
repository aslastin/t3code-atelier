import { assert, it } from "@effect/vitest";
import { EventId, NodeId, PlanId, RunId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";
import * as OrchestrationEventStore from "./OrchestrationEventStore.ts";

it.effect.each([false, true])(
  "recovers a reverted launch and resumes the cached plan after preview repairs: %s",
  (preview) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      yield* runMigrations({ toMigrationInclusive: 105 });
      const capturedPlan = (thread: string, destination: string) =>
        ({
          id: PlanId.make(thread),
          threadId: ThreadId.make(thread),
          runId: null,
          nodeId: NodeId.make(thread),
          kind: "proposed_plan",
          status: "completed",
          markdown: "# Full plan",
          implementationThreadId: ThreadId.make(destination),
        }) as const;
      for (const thread of ["reverted", "retained", "refined", "external"]) {
        const destination = thread === "external" ? "other" : thread;
        yield* sql`INSERT INTO orchestration_v2_projection_plans
          (plan_id,thread_id,node_id,kind,status,payload_json) VALUES
          (${thread},${thread},${thread},'proposed_plan','completed',
            ${JSON.stringify(capturedPlan(thread, destination))})`;
        for (const [ordinal, status] of (thread === "retained"
          ? ["completed", "rolled_back"]
          : ["rolled_back"]
        ).entries()) {
          yield* sql`INSERT INTO orchestration_v2_projection_runs
            (run_id,thread_id,ordinal,provider,status,requested_at,payload_json) VALUES
            (${destination + ordinal},${destination},${ordinal + 1},'codex',${status},'2026-11-22',
              ${JSON.stringify({ sourcePlanRef: { threadId: thread, planId: thread } })})`;
        }
      }
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id,thread_id,node_id,kind,status,payload_json) VALUES
        ('revision','refined','revision','proposed_plan','active',${JSON.stringify({
          ...capturedPlan("refined", "refined"),
          id: "revision",
          nodeId: "revision",
          status: "active",
          implementationThreadId: undefined,
        })})`;
      const cached = capturedPlan("reverted", "reverted");
      const [cursor] = yield* events.appendAgentEvents({
        events: [
          {
            id: EventId.make("implemented"),
            type: "plan.updated",
            threadId: cached.threadId,
            occurredAt: yield* DateTime.now,
            payload: cached,
          },
        ],
      });
      if (preview) {
        yield* sql`INSERT INTO effect_sql_migrations(migration_id,name) VALUES
            (106,'ProposedPlanImplementations'),(107,'RevertedPlanImplementations')`;
        yield* sql`UPDATE orchestration_v2_projection_plans SET
            status = CASE WHEN plan_id='reverted' THEN 'active' ELSE 'superseded' END,
            payload_json = json_set(json_remove(payload_json,'$.implementationThreadId'), '$.status',
              CASE WHEN plan_id='reverted' THEN 'active' ELSE 'superseded' END,
              '$.lastRevertedImplementationRunId', plan_id || '0') WHERE plan_id IN ('reverted','refined')`;
      }
      yield* runMigrations();
      yield* runMigrations();
      const replay = yield* events
        .readAgentEvents({ threadId: cached.threadId, afterSequence: cursor!.sequence })
        .pipe(Stream.runCollect);
      assert.deepEqual(
        replay.map(({ event }) => event.type === "plan.updated" && event.payload),
        [
          {
            id: cached.id,
            threadId: cached.threadId,
            runId: null,
            nodeId: cached.nodeId,
            kind: "proposed_plan",
            status: "active",
            markdown: cached.markdown,
            lastRevertedImplementationRunId: RunId.make("reverted0"),
          },
        ],
      );
      const retainedEvents = yield* events
        .readAgentEvents({ threadId: ThreadId.make("retained") })
        .pipe(Stream.runCollect);
      assert.lengthOf(retainedEvents, preview ? 1 : 0);
      const rows =
        yield* sql`SELECT plan_id, status, json_extract(payload_json,'$.status') AS payload_status,
        json_extract(payload_json,'$.lastRevertedImplementationRunId') AS reverted,
        json_extract(payload_json,'$.implementationThreadId') AS destination
        FROM orchestration_v2_projection_plans ORDER BY plan_id`;
      assert.deepEqual(
        rows.map((p) => [p.plan_id, p.status, p.payload_status, p.reverted, p.destination]),
        [
          ["external", "completed", "completed", null, "other"],
          ["refined", "superseded", "superseded", "refined0", null],
          ["retained", "completed", "completed", null, "retained"],
          ["reverted", "active", "active", "reverted0", null],
          ["revision", "active", "active", null, null],
        ],
      );
    }).pipe(
      Effect.provide(
        OrchestrationEventStore.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
        ),
      ),
    ),
);
