import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

// Atelier fork: topics group a project's threads in the boring sidebar.

export const ThreadTopicId = TrimmedNonEmptyString.pipe(Schema.brand("ThreadTopicId"));
export type ThreadTopicId = typeof ThreadTopicId.Type;

export const THREAD_TOPIC_TITLE_MAX_LENGTH = 64;

export const ThreadTopicTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(THREAD_TOPIC_TITLE_MAX_LENGTH),
  Schema.makeFilter((value) =>
    /[\p{Cc}]/u.test(value) ? "A topic name must be a single line of text." : true,
  ),
);
export type ThreadTopicTitle = typeof ThreadTopicTitle.Type;

/** An agent names a topic by its exact title in the thread's project. */
export const ThreadTopicMcpInput = Schema.NullOr(ThreadTopicTitle).annotate({
  description:
    "Sidebar topic in the project, by exact name; created if missing. Default: your thread's topic. null: none.",
});

export const ThreadTopic = Schema.Struct({
  id: ThreadTopicId,
  projectId: ProjectId,
  title: Schema.String,
  orderKey: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadTopic = typeof ThreadTopic.Type;

export const ThreadTopicMembership = Schema.Struct({
  threadId: ThreadId,
  topicId: ThreadTopicId,
});
export type ThreadTopicMembership = typeof ThreadTopicMembership.Type;

export const ThreadTopicsSnapshot = Schema.Struct({
  topics: Schema.Array(ThreadTopic),
  memberships: Schema.Array(ThreadTopicMembership),
});
export type ThreadTopicsSnapshot = typeof ThreadTopicsSnapshot.Type;

export const ThreadTopicsSubscribeInput = Schema.Struct({});
export type ThreadTopicsSubscribeInput = typeof ThreadTopicsSubscribeInput.Type;

export const ThreadTopicMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("topic.create"),
    topicId: ThreadTopicId,
    projectId: ProjectId,
    title: ThreadTopicTitle,
    threadIds: Schema.Array(ThreadId),
    /** Restores a disbanded topic in its old place; new topics go last. */
    orderKey: Schema.optional(Schema.String),
    /** Undo of a disband: threads filed under another topic since stay there. */
    restore: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    type: Schema.Literal("topic.rename"),
    topicId: ThreadTopicId,
    title: ThreadTopicTitle,
  }),
  Schema.Struct({
    type: Schema.Literal("topic.reorder"),
    topicId: ThreadTopicId,
    /** The project's topic it should follow; null puts it first. */
    afterTopicId: Schema.NullOr(ThreadTopicId),
  }),
  Schema.Struct({
    type: Schema.Literal("topic.disband"),
    topicId: ThreadTopicId,
  }),
  Schema.Struct({
    type: Schema.Literal("topic.assign"),
    threadIds: Schema.Array(ThreadId),
    topicId: Schema.NullOr(ThreadTopicId),
  }),
]);
export type ThreadTopicMutation = typeof ThreadTopicMutation.Type;

export class ThreadTopicError extends Schema.TaggedError<ThreadTopicError>()("ThreadTopicError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}
