# Plan mode

This eval sends tasks through a running development server and saves the plans, questions, replies and tool activity a T3 client receives. Use a scratch project and a local development T3 home. Each sample creates a thread there and costs one provider turn. A question stays open for inspection.

From `evals/`, run this on the original server and again on the changed server with the same model. Use separate output directories. Pass the original output directory to `--baseline` to put both responses side by side. `--case` selects one case and `--samples` defaults to three.

```sh
pnpm plan-mode --home /path/to/dev-home --project <scratch-project-id> --provider codex --model <model-id> --out runs/plan-codex
```

Review the JSON for each sample. A case passes when a majority of its samples satisfy the following criteria. In the missing-formats case the fixture declines shell approval requests because the scratch project has no export samples.

| Case              | Expected behavior                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `delegated-clock` | Regression from the Atelier Plan mode report. A clear one-step task produces an actionable proposal to have an agent print the time with Python after approval. Providing only the command, running it, or starting a child fails. |
| `missing-formats` | The agent asks which formats to support. A plain question or a native input request is valid. Inventing either format fails.                                                                                                       |
| `build-answer`    | An ordinary Build turn answers 5 directly.                                                                                                                                                                                         |
