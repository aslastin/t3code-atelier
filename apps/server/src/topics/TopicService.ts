import {
  ProjectId,
  ThreadId,
  ThreadTopicError,
  ThreadTopicId,
  ThreadTopicMembership,
  type ThreadTopicMutation,
  type ThreadTopicsSnapshot,
  ThreadTopicTitle,
} from "@t3tools/contracts";
import { pinOrderKeyBetween } from "@t3tools/shared/pinOrderKey";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Stream from "effect/Stream";

import { ensureTopicTables } from "./TopicSchema.ts";

/** Atelier fork: named groups of a project's threads, kept beside the event-sourced state. */
export class TopicService extends Context.Service<
  TopicService,
  {
    readonly snapshot: Effect.Effect<ThreadTopicsSnapshot, ThreadTopicError>;
    readonly mutate: (mutation: ThreadTopicMutation) => Effect.Effect<void, ThreadTopicError>;
    /** The current snapshot, then a new one after every change. */
    readonly stream: Stream.Stream<ThreadTopicsSnapshot, ThreadTopicError>;
    /** Topic titles by thread, for agent-facing output. */
    readonly titlesByThread: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<ReadonlyMap<ThreadId, string>, ThreadTopicError>;
    /**
     * Files a thread under the topic of that title in its project, creating the topic when the
     * project has none by that name. Null takes the thread out of its topic.
     */
    readonly assignByTitle: (input: {
      readonly threadId: ThreadId;
      readonly title: string | null;
    }) => Effect.Effect<void, ThreadTopicError>;
    /**
     * Places a newly launched thread: a named topic wins, null keeps it out of topics, and
     * otherwise it joins its launching thread's topic when both share a project.
     */
    readonly placeLaunchedThread: (input: {
      readonly threadId: ThreadId;
      readonly topic?: string | null | undefined;
      readonly sourceThreadId?: ThreadId | null | undefined;
      /** A thread created before this ISO time is a replay of an earlier call, and stays put. */
      readonly createdSince?: string | undefined;
    }) => Effect.Effect<void, ThreadTopicError>;
  }
>()("t3/topics/TopicService") {}

const TopicRow = Schema.Struct({
  id: ThreadTopicId,
  projectId: ProjectId,
  title: Schema.String,
  orderKey: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const ThreadRow = Schema.Struct({ threadId: ThreadId, projectId: ProjectId });
const TitleRow = Schema.Struct({ threadId: ThreadId, title: Schema.String });

const decodeTitle = Schema.decodeUnknownEffect(ThreadTopicTitle);

const failed = (message: string) => (cause: unknown) => new ThreadTopicError({ message, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  yield* ensureTopicTables().pipe(Effect.mapError(failed("Could not create topic tables.")));
  // A deleted thread never returns, and a thread that left its topic's project no longer
  // belongs to it; reads skip both, and this drops what they left behind.
  // Only topics this emptied go too: one the user emptied may still name an open topic draft.
  const pruned = yield* sql<{ readonly topicId: string }>`
    DELETE FROM atelier_thread_topic_members
    WHERE thread_id NOT IN (
      SELECT member.thread_id
      FROM atelier_thread_topic_members AS member
      JOIN atelier_thread_topics AS topic ON topic.id = member.topic_id
      JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = member.thread_id
        AND thread.project_id = topic.project_id
        AND thread.deleted_at IS NULL
    )
    RETURNING topic_id AS "topicId"
  `.pipe(Effect.mapError(failed("Could not prune topic memberships.")));
  const emptiedTopicIds = [...new Set(pruned.map((row) => row.topicId))];
  if (emptiedTopicIds.length > 0) {
    yield* sql`
      DELETE FROM atelier_thread_topics
      WHERE ${sql.in("id", emptiedTopicIds)}
        AND id NOT IN (SELECT topic_id FROM atelier_thread_topic_members)
    `.pipe(Effect.mapError(failed("Could not prune empty topics.")));
  }

  const changes = yield* PubSub.unbounded<ThreadTopicsSnapshot>();
  const lock = yield* Semaphore.make(1);

  const listTopics = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TopicRow,
    execute: () => sql`
      SELECT id, project_id AS "projectId", title, order_key AS "orderKey",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM atelier_thread_topics
      ORDER BY project_id, order_key, id
    `,
  });

  const listMemberships = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadTopicMembership,
    execute: () => sql`
      SELECT member.thread_id AS "threadId", member.topic_id AS "topicId"
      FROM atelier_thread_topic_members AS member
      JOIN atelier_thread_topics AS topic ON topic.id = member.topic_id
      JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = member.thread_id
        AND thread.project_id = topic.project_id
        AND thread.deleted_at IS NULL
    `,
  });

  const findThreads = SqlSchema.findAll({
    Request: Schema.Array(ThreadId),
    Result: ThreadRow,
    execute: (threadIds) => sql`
      SELECT thread_id AS "threadId", project_id AS "projectId"
      FROM orchestration_v2_projection_threads
      WHERE ${sql.in("thread_id", threadIds)} AND deleted_at IS NULL
    `,
  });

  const findTopic = SqlSchema.findAll({
    Request: ThreadTopicId,
    Result: TopicRow,
    execute: (topicId) => sql`
      SELECT id, project_id AS "projectId", title, order_key AS "orderKey",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM atelier_thread_topics WHERE id = ${topicId}
    `,
  });

  const listProjectTopics = SqlSchema.findAll({
    Request: ProjectId,
    Result: TopicRow,
    execute: (projectId) => sql`
      SELECT id, project_id AS "projectId", title, order_key AS "orderKey",
        created_at AS "createdAt", updated_at AS "updatedAt"
      FROM atelier_thread_topics WHERE project_id = ${projectId}
      ORDER BY order_key, id
    `,
  });

  const listTitles = SqlSchema.findAll({
    Request: Schema.Array(ThreadId),
    Result: TitleRow,
    execute: (threadIds) => sql`
      SELECT member.thread_id AS "threadId", topic.title AS title
      FROM atelier_thread_topic_members AS member
      JOIN atelier_thread_topics AS topic ON topic.id = member.topic_id
      JOIN orchestration_v2_projection_threads AS thread
        ON thread.thread_id = member.thread_id
        AND thread.project_id = topic.project_id
        AND thread.deleted_at IS NULL
      WHERE ${sql.in("member.thread_id", threadIds)}
    `,
  });

  // One transaction, so a membership never names a topic the same snapshot lacks.
  const readSnapshot: Effect.Effect<ThreadTopicsSnapshot, ThreadTopicError> = sql
    .withTransaction(
      Effect.all({
        topics: listTopics(undefined),
        memberships: listMemberships(undefined),
      }),
    )
    .pipe(Effect.mapError(failed("Could not read topics.")));

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const requireTopic = Effect.fn("TopicService.requireTopic")(function* (topicId: ThreadTopicId) {
    const [topic] = yield* findTopic(topicId).pipe(
      Effect.mapError(failed("Could not read topic.")),
    );
    if (topic === undefined) {
      return yield* new ThreadTopicError({ message: "That topic no longer exists." });
    }
    return topic;
  });

  // Topics hold threads of their own project only.
  const requireProjectThreads = Effect.fn("TopicService.requireProjectThreads")(function* (
    threadIds: ReadonlyArray<ThreadId>,
    projectId: ProjectId,
  ) {
    if (threadIds.length === 0) return;
    const rows = yield* findThreads(threadIds).pipe(
      Effect.mapError(failed("Could not read threads.")),
    );
    const projectById = new Map(rows.map((row) => [row.threadId, row.projectId]));
    for (const threadId of threadIds) {
      const threadProject = projectById.get(threadId);
      if (threadProject === undefined) {
        return yield* new ThreadTopicError({ message: `Thread ${threadId} does not exist.` });
      }
      if (threadProject !== projectId) {
        return yield* new ThreadTopicError({
          message: "A topic holds threads of its own project only.",
        });
      }
    }
  });

  const addMembers = (topicId: ThreadTopicId, threadIds: ReadonlyArray<ThreadId>) =>
    Effect.forEach(
      threadIds,
      (threadId) => sql`
        INSERT INTO atelier_thread_topic_members (thread_id, topic_id)
        VALUES (${threadId}, ${topicId})
        ON CONFLICT (thread_id) DO UPDATE SET topic_id = excluded.topic_id
      `,
      { discard: true },
    );

  const lastOrderKey = (topics: ReadonlyArray<typeof TopicRow.Type>) =>
    pinOrderKeyBetween(topics.at(-1)?.orderKey ?? null, null) ?? `${topics.length + 1}`;

  // A key that leaves no room after it would push later topics before it.
  const isUsableOrderKey = (key: string) =>
    key.length > 0 && pinOrderKeyBetween(key, null) !== null;

  // Agents name topics by title, so a project never holds two topics of one name.
  const requireFreeTitle = Effect.fn("TopicService.requireFreeTitle")(function* (
    projectId: ProjectId,
    title: string,
    exceptTopicId: ThreadTopicId,
  ) {
    const topics = yield* listProjectTopics(projectId).pipe(
      Effect.mapError(failed("Could not read topics.")),
    );
    if (topics.some((topic) => topic.title === title && topic.id !== exceptTopicId)) {
      return yield* new ThreadTopicError({
        message: `This project already has a topic named "${title}".`,
      });
    }
    return topics;
  });

  const unfiledThreadIds = Effect.fn("TopicService.unfiledThreadIds")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    const filed = new Set(
      (yield* listTitles(threadIds).pipe(Effect.mapError(failed("Could not read topics.")))).map(
        (row) => row.threadId,
      ),
    );
    return threadIds.filter((threadId) => !filed.has(threadId));
  });

  // Threads deleted meanwhile drop out, as when Undo restores a disbanded topic.
  const existingThreadIds = Effect.fn("TopicService.existingThreadIds")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    if (threadIds.length === 0) return [];
    const rows = yield* findThreads(threadIds).pipe(
      Effect.mapError(failed("Could not read threads.")),
    );
    const existing = new Set(rows.map((row) => row.threadId));
    return threadIds.filter((threadId) => existing.has(threadId));
  });

  const createTopic = Effect.fn("TopicService.createTopic")(function* (input: {
    readonly topicId: ThreadTopicId;
    readonly projectId: ProjectId;
    readonly title: string;
    readonly threadIds: ReadonlyArray<ThreadId>;
    readonly orderKey?: string | undefined;
    readonly restore?: boolean | undefined;
  }) {
    const existingIds = yield* existingThreadIds(input.threadIds);
    // Decided here, not from the client's possibly older snapshot.
    const threadIds =
      input.restore === true && existingIds.length > 0
        ? yield* unfiledThreadIds(existingIds)
        : existingIds;
    if (threadIds.length === 0) {
      return yield* new ThreadTopicError({ message: "A topic needs at least one thread." });
    }
    yield* requireProjectThreads(threadIds, input.projectId);
    const [existing] = yield* findTopic(input.topicId).pipe(
      Effect.mapError(failed("Could not read topic.")),
    );
    if (existing !== undefined && existing.projectId !== input.projectId) {
      return yield* new ThreadTopicError({ message: "That topic belongs to another project." });
    }
    const now = yield* nowIso;
    if (existing === undefined) {
      const topics = yield* requireFreeTitle(input.projectId, input.title, input.topicId);
      const orderKey =
        input.orderKey !== undefined && isUsableOrderKey(input.orderKey)
          ? input.orderKey
          : lastOrderKey(topics);
      yield* sql`
        INSERT INTO atelier_thread_topics (id, project_id, title, order_key, created_at, updated_at)
        VALUES (${input.topicId}, ${input.projectId}, ${input.title}, ${orderKey}, ${now}, ${now})
      `;
    }
    yield* addMembers(input.topicId, threadIds);
  });

  const reorderTopic = Effect.fn("TopicService.reorderTopic")(function* (
    topicId: ThreadTopicId,
    afterTopicId: ThreadTopicId | null,
  ) {
    const topic = yield* requireTopic(topicId);
    if (afterTopicId === topicId) return;
    const others = (yield* listProjectTopics(topic.projectId).pipe(
      Effect.mapError(failed("Could not read topics.")),
    )).filter((candidate) => candidate.id !== topicId);
    const afterIndex =
      afterTopicId === null ? -1 : others.findIndex((candidate) => candidate.id === afterTopicId);
    if (afterTopicId !== null && afterIndex === -1) {
      return yield* new ThreadTopicError({ message: "That topic no longer exists." });
    }
    const now = yield* nowIso;
    const between = pinOrderKeyBetween(
      others[afterIndex]?.orderKey ?? null,
      others[afterIndex + 1]?.orderKey ?? null,
    );
    if (between !== null) {
      yield* sql`
        UPDATE atelier_thread_topics SET order_key = ${between}, updated_at = ${now}
        WHERE id = ${topicId}
      `;
      return;
    }
    // Keys that are corrupt or tied leave no room between them: rewrite the project's run.
    const ordered = [...others];
    ordered.splice(afterIndex + 1, 0, topic);
    let previous: string | null = null;
    for (const candidate of ordered) {
      const key: string = pinOrderKeyBetween(previous, null) ?? `${ordered.indexOf(candidate)}`;
      previous = key;
      yield* sql`
        UPDATE atelier_thread_topics SET order_key = ${key}, updated_at = ${now}
        WHERE id = ${candidate.id}
      `;
    }
  });

  const apply = Effect.fn("TopicService.apply")(function* (mutation: ThreadTopicMutation) {
    switch (mutation.type) {
      case "topic.create":
        return yield* createTopic(mutation);
      case "topic.rename": {
        const topic = yield* requireTopic(mutation.topicId);
        yield* requireFreeTitle(topic.projectId, mutation.title, topic.id);
        const now = yield* nowIso;
        yield* sql`
          UPDATE atelier_thread_topics SET title = ${mutation.title}, updated_at = ${now}
          WHERE id = ${mutation.topicId}
        `;
        return;
      }
      case "topic.reorder":
        return yield* reorderTopic(mutation.topicId, mutation.afterTopicId);
      case "topic.disband":
        yield* sql`DELETE FROM atelier_thread_topic_members WHERE topic_id = ${mutation.topicId}`;
        yield* sql`DELETE FROM atelier_thread_topics WHERE id = ${mutation.topicId}`;
        return;
      case "topic.assign": {
        if (mutation.topicId === null) {
          if (mutation.threadIds.length === 0) return;
          yield* sql`
            DELETE FROM atelier_thread_topic_members
            WHERE ${sql.in("thread_id", mutation.threadIds)}
          `;
          return;
        }
        const topic = yield* requireTopic(mutation.topicId);
        yield* requireProjectThreads(mutation.threadIds, topic.projectId);
        yield* addMembers(topic.id, mutation.threadIds);
        return;
      }
    }
  });

  const isTopicError = Schema.is(ThreadTopicError);
  // Uninterruptible: a caller that disconnects after the commit must not skip the publish.
  const commit = <A, E>(effect: Effect.Effect<A, E>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const result = yield* sql
          .withTransaction(effect)
          .pipe(
            Effect.mapError((cause) =>
              isTopicError(cause)
                ? cause
                : new ThreadTopicError({ message: "Could not save topics.", cause }),
            ),
          );
        yield* PubSub.publish(changes, yield* readSnapshot);
        return result;
      }).pipe(Effect.uninterruptible),
    );

  const mutate: TopicService["Service"]["mutate"] = Effect.fn("TopicService.mutate")(
    function* (mutation) {
      yield* commit(apply(mutation));
    },
  );

  const titlesByThread: TopicService["Service"]["titlesByThread"] = Effect.fn(
    "TopicService.titlesByThread",
  )(function* (threadIds) {
    if (threadIds.length === 0) return new Map();
    const rows = yield* listTitles(threadIds).pipe(
      Effect.mapError(failed("Could not read topics.")),
    );
    return new Map(rows.map((row) => [row.threadId, row.title]));
  });

  const assignInTransaction = Effect.fn("TopicService.assignInTransaction")(function* (
    threadId: ThreadId,
    rawTitle: string | null,
  ) {
    const [thread] = yield* findThreads([threadId]).pipe(
      Effect.mapError(failed("Could not read threads.")),
    );
    if (thread === undefined) {
      return yield* new ThreadTopicError({ message: `Thread ${threadId} does not exist.` });
    }
    if (rawTitle === null) {
      yield* sql`DELETE FROM atelier_thread_topic_members WHERE thread_id = ${threadId}`;
      return;
    }
    const title = yield* decodeTitle(rawTitle).pipe(
      Effect.mapError(
        () =>
          new ThreadTopicError({
            message: "A topic name must be one line of at most 64 characters.",
          }),
      ),
    );
    const topics = yield* listProjectTopics(thread.projectId).pipe(
      Effect.mapError(failed("Could not read topics.")),
    );
    const existing = topics.find((topic) => topic.title === title);
    if (existing !== undefined) {
      yield* addMembers(existing.id, [threadId]);
      return;
    }
    yield* createTopic({
      topicId: ThreadTopicId.make(
        yield* random.uuidV4().pipe(Effect.mapError(failed("Could not create a topic id."))),
      ),
      projectId: thread.projectId,
      title,
      threadIds: [threadId],
    });
  });

  const assignByTitle: TopicService["Service"]["assignByTitle"] = Effect.fn(
    "TopicService.assignByTitle",
  )(function* ({ threadId, title }) {
    yield* commit(assignInTransaction(threadId, title));
  });

  const placeLaunchedThread: TopicService["Service"]["placeLaunchedThread"] = Effect.fn(
    "TopicService.placeLaunchedThread",
  )(function* ({ threadId, topic, sourceThreadId, createdSince }) {
    if (topic === null) return;
    if (createdSince !== undefined) {
      const fresh = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId} AND julianday(created_at) >= julianday(${createdSince})
      `.pipe(Effect.mapError(failed("Could not read threads.")));
      if (fresh.length === 0) return;
    }
    // A retried launch replays a thread that may have moved since; its topic stays.
    const [current] = yield* listTitles([threadId]).pipe(
      Effect.mapError(failed("Could not read topics.")),
    );
    if (current !== undefined) return;
    if (topic !== undefined) return yield* assignByTitle({ threadId, title: topic });
    if (sourceThreadId == null || sourceThreadId === threadId) return;
    yield* commit(
      Effect.gen(function* () {
        // The launcher's topic counts only while the launcher is still in its project.
        const [sourceTopic] = yield* sql<{ readonly topicId: string; readonly projectId: string }>`
          SELECT member.topic_id AS "topicId", topic.project_id AS "projectId"
          FROM atelier_thread_topic_members AS member
          JOIN atelier_thread_topics AS topic ON topic.id = member.topic_id
          JOIN orchestration_v2_projection_threads AS thread
            ON thread.thread_id = member.thread_id
            AND thread.project_id = topic.project_id
            AND thread.deleted_at IS NULL
          WHERE member.thread_id = ${sourceThreadId}
        `;
        if (sourceTopic === undefined) return;
        const [thread] = yield* findThreads([threadId]).pipe(
          Effect.mapError(failed("Could not read threads.")),
        );
        if (thread?.projectId !== sourceTopic.projectId) return;
        yield* addMembers(ThreadTopicId.make(sourceTopic.topicId), [threadId]);
      }),
    );
  });

  const stream: TopicService["Service"]["stream"] = Stream.callback<
    ThreadTopicsSnapshot,
    ThreadTopicError
  >(
    (mailbox) =>
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        Queue.offerUnsafe(mailbox, yield* readSnapshot);
        yield* Stream.fromSubscription(subscription).pipe(
          Stream.runForEach((snapshot) => Effect.sync(() => Queue.offerUnsafe(mailbox, snapshot))),
          Effect.forkScoped,
        );
      }),
    { bufferSize: 1, strategy: "sliding" },
  );

  return TopicService.of({
    snapshot: readSnapshot,
    mutate,
    stream,
    titlesByThread,
    assignByTitle,
    placeLaunchedThread,
  });
});

export const layer = Layer.effect(TopicService, make);
