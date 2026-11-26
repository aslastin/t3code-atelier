import { describe, expect, it } from "vite-plus/test";

import { normalizeComposerLinkHref } from "./composer-link";

describe("normalizeComposerLinkHref", () => {
  it.each([
    ["t3.codes", "https://t3.codes"],
    ["  https://t3.codes/a  ", "https://t3.codes/a"],
    ["http://t3.codes", "http://t3.codes"],
    ["t3.codes:8080/x", "https://t3.codes:8080/x"],
    ["localhost:3000", "http://localhost:3000"],
    ["127.0.0.1:8080/api", "http://127.0.0.1:8080/api"],
    ["192.168.1.20", "http://192.168.1.20"],
    ["app.localhost:5173", "http://app.localhost:5173"],
    ["box.tail1234.ts.net", "https://box.tail1234.ts.net"],
    ["en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)"],
    ["t3.codes/a(b", "https://t3.codes/a%28b"],
    ["t3.codes/<a>", "https://t3.codes/%3Ca%3E"],
  ])("links %s to %s", (input, href) => {
    expect(normalizeComposerLinkHref(input)).toBe(href);
  });

  it.each(["", "path:fool", "mailto:a@b.c", "ftp://t3.codes", "t3 codes", "https://"])(
    "refuses %j",
    (input) => {
      expect(normalizeComposerLinkHref(input)).toBeNull();
    },
  );
});
