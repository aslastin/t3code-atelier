// @effect-diagnostics nodeBuiltinImport:off - A dev helper that writes folders and prints paths.
/**
 * Writes the Kite test plugin and a Kite repository for trying VCS plugins in a dev app:
 * `vp run --filter t3 kite-plugin <folder>`, then import `<folder>/plugin` in Settings → Source
 * control and add `<folder>/repo` as a project. Kite keeps everything in plain files, so each
 * feature can be tried without a real VCS.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { makeFakeRepository, writeFakeVcsPlugin } from "../src/plugins/testing/fakeVcsPlugin.ts";

const target = process.argv[2];
if (target === undefined || target.trim() === "") {
  process.stderr.write("Usage: kite-plugin <folder>\n");
  process.exit(1);
}
const folder = NodePath.resolve(target);
const plugin = NodePath.join(folder, "plugin");
const repo = NodePath.join(folder, "repo");
for (const path of [plugin, repo]) {
  if (NodeFS.existsSync(path) && NodeFS.readdirSync(path).length > 0) {
    process.stderr.write(`${path} already holds files; choose an empty folder.\n`);
    process.exit(1);
  }
}
writeFakeVcsPlugin(plugin);
makeFakeRepository(repo, {
  "README.md": "# Kite demo\n",
  "src/index.ts": 'export const greeting = "hello";\n',
});
process.stdout.write(
  [
    `Plugin:     ${plugin}`,
    `Repository: ${repo}`,
    "Import the plugin in Settings → Source control, then add the repository as a project.",
    "",
  ].join("\n"),
);
