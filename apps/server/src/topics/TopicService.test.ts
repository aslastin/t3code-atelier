import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId, ThreadTopicId, type ThreadTopicsSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TopicService from "./TopicService.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const thread = (id: string) => ThreadId.make(id);
const topicId = (id: string) => ThreadTopicId.make(id);

const insertThread = Effect.fn("test.insertThread")(function* (id: string, projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  const createdAt = "2026-01-01T00:00:00.000Z";
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, payload_json
    ) VALUES (
      ${id}, ${projectId}, ${id}, 'codex', 'full-access', 'default',
      ${createdAt}, ${createdAt}, '{}'
    )
  `;
});

const deleteThread = Effect.fn("test.deleteThread")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE orchestration_v2_projection_threads
    SET deleted_at = '2026-01-02T00:00:00.000Z' WHERE thread_id = ${id}
  `;
});

const seed = Effect.gen(function* () {
  for (const id of ["a1", "a2", "a3"]) yield* insertThread(id, projectA);
  yield* insertThread("b1", projectB);
});

const membersOf = (snapshot: ThreadTopicsSnapshot, id: string) =>
  snapshot.memberships
    .filter((membership) => membership.topicId === id)
    .map((membership) => membership.threadId)
    .toSorted();

const titlesInOrder = (snapshot: ThreadTopicsSnapshot, projectId: ProjectId) =>
  snapshot.topics.filter((topic) => topic.projectId === projectId).map((topic) => topic.title);

const withService = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TopicService.layer));

// Each case gets its own in-memory database.
const withDatabase = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(Layer.merge(SqlitePersistence.layerMemory, NodeCrypto.layer)));

describe("TopicService", () => {
  it.effect("creates, renames, reorders, reassigns and disbands topics", () =>
    withDatabase(
      withService(
        Effect.gen(function* () {
          yield* seed;
          const topics = yield* TopicService.TopicService;

          yield* topics.mutate({
            type: "topic.create",
            topicId: topicId("t1"),
            projectId: projectA,
            title: "Auth",
            threadIds: [thread("a1"), thread("a2")],
          });
          yield* topics.mutate({
            type: "topic.create",
            topicId: topicId("t2"),
            projectId: projectA,
            title: "Billing",
            threadIds: [thread("a3")],
          });
          let snapshot = yield* topics.snapshot;
          assert.deepStrictEqual(titlesInOrder(snapshot, projectA), ["Auth", "Billing"]);
          assert.deepStrictEqual(membersOf(snapshot, "t1"), ["a1", "a2"]);

          yield* topics.mutate({ type: "topic.rename", topicId: topicId("t1"), title: "Login" });
          yield* topics.mutate({
            type: "topic.reorder",
            topicId: topicId("t2"),
            afterTopicId: null,
          });
          snapshot = yield* topics.snapshot;
          assert.deepStrictEqual(titlesInOrder(snapshot, projectA), ["Billing", "Login"]);
          // Agents find topics by name, so one project never has two of a name.
          const duplicate = yield* Effect.exit(
            topics.mutate({ type: "topic.rename", topicId: topicId("t2"), title: "Login" }),
          );
          assert.isTrue(Exit.isFailure(duplicate));

          yield* topics.mutate({
            type: "topic.assign",
            threadIds: [thread("a2")],
            topicId: topicId("t2"),
          });
          yield* topics.mutate({ type: "topic.assign", threadIds: [thread("a1")], topicId: null });
          snapshot = yield* topics.snapshot;
          assert.deepStrictEqual(membersOf(snapshot, "t1"), []);
          assert.deepStrictEqual(membersOf(snapshot, "t2"), ["a2", "a3"]);

          const disbanded = snapshot.topics.find((topic) => topic.id === "t2")!;
          yield* topics.mutate({ type: "topic.disband", topicId: topicId("t2") });
          snapshot = yield* topics.snapshot;
          assert.deepStrictEqual(titlesInOrder(snapshot, projectA), ["Login"]);
          assert.deepStrictEqual(snapshot.memberships, []);

          // Undo of a disband recreates the topic in its old place, without threads deleted since.
          yield* deleteThread("a3");
          yield* topics.mutate({
            type: "topic.create",
            topicId: topicId("t2"),
            projectId: projectA,
            title: "Billing",
            threadIds: [thread("a2"), thread("a3")],
            orderKey: disbanded.orderKey,
          });
          snapshot = yield* topics.snapshot;
          assert.deepStrictEqual(titlesInOrder(snapshot, projectA), ["Billing", "Login"]);
          assert.deepStrictEqual(membersOf(snapshot, "t2"), ["a2"]);

          // A key that leaves no room after it is not taken; the topic goes last.
          yield* topics.mutate({
            type: "topic.create",
            topicId: topicId("t3"),
            projectId: projectA,
            title: "Ops",
            threadIds: [thread("a1")],
            orderKey: "z!",
          });
          yield* topics.mutate({
            type: "topic.reorder",
            topicId: topicId("t2"),
            afterTopicId: topicId("t3"),
          });
          snapshot = yield* topics.snapshot;
          assert.deepStrictEqual(titlesInOrder(snapshot, projectA), ["Login", "Ops", "Billing"]);
        }),
      ),
    ),
  );

  it.effect("refuses threads of another project", () =>
    withDatabase(
      withService(
        Effect.gen(function* () {
          yield* seed;
          const topics = yield* TopicService.TopicService;
          const created = yield* Effect.exit(
            topics.mutate({
              type: "topic.create",
              topicId: topicId("t1"),
              projectId: projectA,
              title: "Auth",
              threadIds: [thread("a1"), thread("b1")],
            }),
          );
          assert.isTrue(Exit.isFailure(created));
          assert.deepStrictEqual((yield* topics.snapshot).topics, []);

          yield* topics.mutate({
            type: "topic.create",
            topicId: topicId("t1"),
            projectId: projectA,
            title: "Auth",
            threadIds: [thread("a1")],
          });
          const moved = yield* Effect.exit(
            topics.mutate({
              type: "topic.assign",
              threadIds: [thread("b1")],
              topicId: topicId("t1"),
            }),
          );
          assert.isTrue(Exit.isFailure(moved));
          assert.deepStrictEqual(membersOf(yield* topics.snapshot, "t1"), ["a1"]);

          const empty = yield* Effect.exit(
            topics.mutate({
              type: "topic.create",
              topicId: topicId("t2"),
              projectId: projectA,
              title: "Empty",
              threadIds: [],
            }),
          );
          assert.isTrue(Exit.isFailure(empty));
          const missing = yield* Effect.exit(
            topics.assignByTitle({ threadId: thread("nope"), title: null }),
          );
          assert.isTrue(Exit.isFailure(missing));
        }),
      ),
    ),
  );

  it.effect("drops memberships of deleted threads", () =>
    withDatabase(
      Effect.gen(function* () {
        yield* seed;
        yield* withService(
          Effect.gen(function* () {
            const topics = yield* TopicService.TopicService;
            yield* topics.mutate({
              type: "topic.create",
              topicId: topicId("t1"),
              projectId: projectA,
              title: "Auth",
              threadIds: [thread("a1"), thread("a2")],
            });
            yield* topics.mutate({
              type: "topic.create",
              topicId: topicId("t2"),
              projectId: projectA,
              title: "Gone",
              threadIds: [thread("a3")],
            });
            yield* insertThread("a4", projectA);
            yield* topics.mutate({
              type: "topic.create",
              topicId: topicId("t3"),
              projectId: projectA,
              title: "Emptied",
              threadIds: [thread("a4")],
            });
            yield* topics.mutate({
              type: "topic.assign",
              threadIds: [thread("a4")],
              topicId: null,
            });
            yield* deleteThread("a1");
            yield* deleteThread("a3");
            assert.deepStrictEqual(membersOf(yield* topics.snapshot, "t1"), ["a2"]);
          }),
        );
        // The next start removes the rows and the topic they emptied; a topic the user
        // emptied stays, since an open topic draft may still name it.
        yield* withService(Effect.void);
        const sql = yield* SqlClient.SqlClient;
        const members = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM atelier_thread_topic_members ORDER BY thread_id
      `;
        assert.deepStrictEqual(
          members.map((row) => row.threadId),
          ["a2"],
        );
        const topicRows = yield* sql<{ readonly id: string }>`SELECT id FROM atelier_thread_topics`;
        assert.deepStrictEqual(topicRows.map((row) => row.id).toSorted(), ["t1", "t3"]);
      }),
    ),
  );

  it.effect("files launched threads by title or by their launching thread", () =>
    withDatabase(
      withService(
        Effect.gen(function* () {
          yield* seed;
          const topics = yield* TopicService.TopicService;

          yield* topics.assignByTitle({ threadId: thread("a1"), title: "Auth" });
          yield* topics.placeLaunchedThread({
            threadId: thread("a2"),
            sourceThreadId: thread("a1"),
          });
          // Another project's thread does not follow its launcher into the topic.
          yield* topics.placeLaunchedThread({
            threadId: thread("b1"),
            sourceThreadId: thread("a1"),
          });
          // An explicit null keeps the thread out of topics.
          yield* topics.placeLaunchedThread({
            threadId: thread("a3"),
            sourceThreadId: thread("a1"),
            topic: null,
          });
          let snapshot = yield* topics.snapshot;
          assert.strictEqual(snapshot.topics.length, 1);
          const auth = snapshot.topics[0]!;
          assert.deepStrictEqual(membersOf(snapshot, auth.id), ["a1", "a2"]);

          yield* topics.placeLaunchedThread({
            threadId: thread("a3"),
            sourceThreadId: thread("a1"),
            topic: "Auth",
          });
          snapshot = yield* topics.snapshot;
          assert.strictEqual(snapshot.topics.length, 1);
          assert.deepStrictEqual(membersOf(snapshot, auth.id), ["a1", "a2", "a3"]);

          const titles = yield* topics.titlesByThread([thread("a1"), thread("b1")]);
          assert.deepStrictEqual([...titles], [[thread("a1"), "Auth"]]);

          // A replayed launch leaves a thread that was filed elsewhere since where it is.
          yield* topics.placeLaunchedThread({ threadId: thread("a3"), topic: "Billing" });
          assert.deepStrictEqual(
            (yield* topics.titlesByThread([thread("a3")])).get(thread("a3")),
            "Auth",
          );

          // A launcher that moved to another project no longer passes on its old topic.
          const sql = yield* SqlClient.SqlClient;
          yield* sql`
            UPDATE orchestration_v2_projection_threads SET project_id = ${projectB}
            WHERE thread_id = 'a1'
          `;
          yield* insertThread("a4", projectA);
          yield* topics.placeLaunchedThread({
            threadId: thread("a4"),
            sourceThreadId: thread("a1"),
          });
          assert.isFalse((yield* topics.titlesByThread([thread("a4")])).has(thread("a4")));
        }),
      ),
    ),
  );
});
