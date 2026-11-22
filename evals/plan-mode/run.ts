import * as NodeUtil from "node:util";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { CommandId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { rpcClient, runPromise } from "../../scripts/scenarios/t3.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    home: { type: "string" },
    project: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    out: { type: "string" },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
  },
});
const { home, project, provider, model, out } = values;
const samples = Number(values.samples);
const cases = [
  {
    id: "delegated-clock",
    mode: "plan",
    prompt: "Попроси агента напечатать текущее время, используя Python.",
  },
  {
    id: "missing-formats",
    mode: "plan",
    prompt:
      "Сделай конвертер между двумя форматами моей выгрузки. Названия обоих форматов пока знаю только я.",
  },
  { id: "build-answer", mode: "default", prompt: "What is two plus three? Reply with the number." },
] as const;
const selected = cases.filter((item) => !values.case || item.id === values.case);
if (
  !home ||
  !project ||
  !provider ||
  !model ||
  !out ||
  !selected.length ||
  !Number.isSafeInteger(samples) ||
  samples < 1
) {
  throw new Error(
    "Pass --home <dev T3 home> --project <scratch project id> --provider <instance> --model <slug> --out <dir>.",
  );
}
const decodeOrigin = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ origin: Schema.String })),
);
const encodeResult = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const uuid = Effect.flatMap(SecureRandom.SecureRandom, (random) => random.uuidV4()).pipe(
  Effect.provide(NodeCrypto.layer),
);
await runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const base = path.resolve(home);
      const { origin } = decodeOrigin(
        yield* fs.readFileString(path.join(base, "userdata/server-runtime.json")),
      );
      const rpc = yield* rpcClient(base, origin);
      yield* fs.makeDirectory(out, { recursive: true });
      for (const fixture of selected) {
        for (let sample = 1; sample <= samples; sample++) {
          const threadId = ThreadId.make(yield* uuid);
          yield* rpc["orchestration.launchThread"]({
            commandId: CommandId.make(yield* uuid),
            threadId,
            projectId: ProjectId.make(project),
            title: `Plan eval · ${fixture.id} · ${sample}`,
            modelSelection: { instanceId: ProviderInstanceId.make(provider), model },
            runtimeMode: "approval-required",
            interactionMode: fixture.mode,
            workspaceStrategy: { type: "root" },
            initialMessage: { text: fixture.prompt, attachments: [] },
          });
          const declined = new Set<string>();
          const ready = yield* rpc["orchestration.subscribeThread"]({ threadId }).pipe(
            Stream.filter(
              (item) =>
                item.kind === "snapshot" ||
                (item.kind === "event" &&
                  (item.event.type === "runtime-request.updated" ||
                    item.event.type === "run.updated" ||
                    (item.event.type === "turn-item.updated" &&
                      item.event.payload.type === "user_input_request"))),
            ),
            Stream.mapEffect(() => rpc["orchestration.getThreadProjection"]({ threadId })),
            Stream.tap((view) =>
              Effect.forEach(
                view.runtimeRequests.filter(
                  (request) =>
                    fixture.id === "missing-formats" &&
                    request.status === "pending" &&
                    request.kind === "command" &&
                    !declined.has(request.id),
                ),
                (request) => {
                  declined.add(request.id);
                  return rpc["orchestration.dispatchCommand"]({
                    type: "runtime-request.respond",
                    commandId: CommandId.make(`decline-${request.id}`),
                    threadId,
                    requestId: request.id,
                    decision: "decline",
                  });
                },
              ),
            ),
            Stream.filter(
              (view) =>
                view.runtimeRequests.some(
                  (request) =>
                    request.status === "pending" &&
                    !declined.has(request.id) &&
                    (request.kind !== "user_input" ||
                      view.turnItems.some(
                        (item) =>
                          item.type === "user_input_request" && item.requestId === request.id,
                      )),
                ) ||
                view.runs.some((run) =>
                  ["failed", "interrupted", "cancelled", "completed"].includes(run.status),
                ),
            ),
            Stream.runHead,
            Effect.timeout("3 minutes"),
          );
          const view = Option.getOrThrow(ready);
          const result = {
            provider,
            model,
            threadId,
            prompt: fixture.prompt,
            mode: view.thread.interactionMode,
            runs: view.runs.map((run) => run.status),
            plans: view.plans.flatMap((plan) =>
              plan.kind === "proposed_plan" && plan.status === "active" ? [plan.markdown] : [],
            ),
            requests: view.runtimeRequests.map((request) => ({
              kind: request.kind,
              status: request.status,
            })),
            questions: view.turnItems.flatMap((item) =>
              item.type === "user_input_request" ? item.questions : [],
            ),
            replies: view.messages
              .filter((message) => message.role === "assistant")
              .map((message) => message.text),
            activity: view.turnItems.map((item) => ({ type: item.type, title: item.title })),
          };
          const filename = `${fixture.id}-${sample}.json`;
          yield* fs.writeFileString(path.join(out, filename), yield* encodeResult(result));
          if (values.baseline) {
            const previous = yield* fs.readFileString(path.join(values.baseline, filename));
            yield* fs.writeFileString(path.join(out, `before-${filename}`), previous);
          }
        }
      }
    }),
  ),
);
