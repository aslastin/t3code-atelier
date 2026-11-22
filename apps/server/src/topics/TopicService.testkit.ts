import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { TopicService } from "./TopicService.ts";

const EMPTY = { topics: [], memberships: [] };

/** Atelier fork: a TopicService with no topics, for tests of tools that read or place them. */
export const layerNoTopics = Layer.succeed(
  TopicService,
  TopicService.of({
    snapshot: Effect.succeed(EMPTY),
    mutate: () => Effect.void,
    stream: Stream.make(EMPTY),
    titlesByThread: () => Effect.succeed(new Map()),
    assignByTitle: () => Effect.void,
    placeLaunchedThread: () => Effect.void,
  }),
);
