import { PLAN_QUESTIONS_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function planQuestionsInput(driver?: string): OrchestratorFixtureInput {
  return {
    // Only the Codex recording entered native Plan. Grok and OpenCode v1 asked in Build.
    interactionMode: driver === "codex" ? "plan" : "default",
    steps: [
      { type: "message", text: PLAN_QUESTIONS_PROMPT },
      {
        type: "answer_next_user_input_request",
        answers: {
          schema_vs_ui_flexibility: "Strict schemas (Recommended)",
          schema_preference: "Strict schemas (Recommended)",
          "question-0-schema-vs-flexibility": "Strict schemas",
        },
      },
    ],
  };
}
