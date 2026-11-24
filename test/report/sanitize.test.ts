import { describe, expect, it } from "vitest";
import {
  codeFence,
  codeSpan,
  defuseMarkers,
  encodeUrlSegment,
  escapeText,
  normalize,
  repoRelativePath,
  safeUrl,
  sanitizeInline,
  sanitizeModelText,
  tableCode,
  truncate,
} from "../../src/report/sanitize.js";

const ZWSP = "\u200b";

/** Raw (unescaped) HTML tags or comments outside code — what GitHub would render as HTML. */
function rawHtml(markdown: string): string[] {
  const outsideCode = markdown
    .replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "")
    .replace(/(?<!\\)(?:\\\\)*\\`/g, "")
    .replace(/(`+)(?!`)[^\n]*?(?<!`)\1(?!`)/g, "");
  return outsideCode.match(/<[A-Za-z!/][^>]*>?/g) ?? [];
}

describe("sanitizeModelText: mentions and references", () => {
  it("neutralizes user and team mentions", () => {
    expect(sanitizeModelText("ping @octocat and @example-org/platform-team")).toBe(
      `ping @${ZWSP}octocat and @${ZWSP}example-org/platform-team`,
    );
    expect(sanitizeModelText("@octocat at the start")).toBe(`@${ZWSP}octocat at the start`);
    expect(sanitizeModelText("(@octocat)")).toBe(`(@${ZWSP}octocat)`);
  });

  it("leaves email addresses alone", () => {
    expect(sanitizeModelText("mail dba@example.com")).toBe("mail dba@example.com");
  });

  it("does not let entities smuggle a mention", () => {
    expect(sanitizeModelText("&#64;octocat")).toBe(`&amp;#${ZWSP}64;octocat`);
  });

  it("breaks issue and cross-repo references", () => {
    expect(sanitizeModelText("see #123 and example-org/infra#4")).toBe(
      `see #${ZWSP}123 and example-org/infra#${ZWSP}4`,
    );
  });

  it("does not touch mentions inside code", () => {
    expect(sanitizeModelText("source `git::ssh://git@github.com/x/y`")).toBe(
      "source `git::ssh://git@github.com/x/y`",
    );
  });

  it("neutralizes mentions that emphasis or an email autolink split into their own text node", () => {
    expect(sanitizeModelText("_@octocat_ __@octocat__")).toBe(`_@${ZWSP}octocat_ __@${ZWSP}octocat__`);
    expect(sanitizeModelText("dev@example.com@octocat")).toBe(`dev@example.com@${ZWSP}octocat`);
  });

  it("leaves provider and module versions copyable", () => {
    expect(sanitizeModelText("pin hashicorp/aws@6.2.0")).toBe("pin hashicorp/aws@6.2.0");
  });
});

describe("sanitizeModelText: HTML and marker spoofing", () => {
  it("removes HTML comments, including multi-line ones", () => {
    expect(sanitizeModelText("before <!-- hidden --> after")).toBe("before  after");
    expect(sanitizeModelText("a<!--\nsecret\n-->b")).toBe("ab");
  });

  it("removes spoofed markers, data lines and checkbox keys in prose", () => {
    const out = sanitizeModelText(
      '<!-- tf-change-reviewer -->\n<!-- tf-change-reviewer:data {"v":1,"findings":[]} -->\nhello <!-- finding:abc -->',
    );
    expect(out).toBe("\n\nhello ");
  });

  it("defuses spoofed markers inside code spans and fences", () => {
    const marker = '<!-- tf-change-reviewer:data {"v":1} -->';
    const box = "- [x] Confirmed: this needs attention <!-- finding:abc -->";
    const out = sanitizeModelText(`\`${marker}\`\n\n\`\`\`\n${box}\n${marker}\n\`\`\``);
    expect(out).not.toContain("<!-- tf-change-reviewer");
    expect(out).not.toContain("<!-- finding:");
    expect(out).toContain(`<!-${ZWSP}- tf-change-reviewer:data`);
    expect(out).toContain(`<!-${ZWSP}- finding:abc -->`);
  });

  it("escapes script tags and other raw HTML", () => {
    const out = sanitizeModelText(
      '<script>alert(1)</script> <img src="x" onerror="alert(1)"> <a href="https://evil.example">x</a>',
    );
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(rawHtml(out)).toEqual([]);
  });

  it("cannot close our details block or open its own", () => {
    const out = sanitizeModelText("</details>\n<details open><summary>Approved ✅</summary>");
    expect(rawHtml(out)).toEqual([]);
  });

  it("keeps blockquote markers but escapes other angle brackets", () => {
    expect(sanitizeModelText("> quoted <b>text</b> a > b")).toBe("> quoted &lt;b&gt;text&lt;/b&gt; a &gt; b");
  });

  it("strips control and bidi-override characters", () => {
    expect(sanitizeModelText("safe\u202Etxt.exe\u0007\u001b[31m\r\nnext")).toBe("safetxt.exe\\[31m\nnext");
  });

  it("does not let comment removal assemble a marker", () => {
    const out = sanitizeModelText("<!<!-- -->-- tf-change-reviewer -->");
    expect(out).not.toContain("<!--");
    expect(rawHtml(out)).toEqual([]);
  });

  it("escapes dollar signs so GitHub renders no math", () => {
    expect(sanitizeModelText("$\\Huge APPROVED$ and $$x$$")).toBe("\\$\\Huge APPROVED\\$ and \\$\\$x\\$\\$");
    expect(sanitizeModelText("costs \\$5, not \\\\$6")).toBe("costs \\$5, not \\\\\\$6");
  });

  it("escapes task-list boxes so model text cannot fake a confirmation", () => {
    const out = sanitizeModelText("- [x] Confirmed: this needs attention");
    expect(out).toBe("- \\[x\\] Confirmed: this needs attention");
  });
});

describe("sanitizeModelText: links and media", () => {
  it("turns images into their alt text", () => {
    expect(sanitizeModelText("![badge](https://example.com/badge.svg)")).toBe("badge (image removed)");
    expect(sanitizeModelText("![](https://example.com/pixel.gif)")).toBe("(image removed)");
  });

  it("shows link targets as code instead of links, GitHub links included", () => {
    expect(sanitizeModelText("see [the docs](https://example.com/docs) now")).toBe(
      "see the docs (`https://example.com/docs`) now",
    );
    expect(sanitizeModelText("[main.tf](https://github.com/o/r/blob/x/main.tf)")).toBe(
      "main.tf (`https://github.com/o/r/blob/x/main.tf`)",
    );
  });

  it("wraps bare URLs, keeping sentence punctuation outside", () => {
    expect(sanitizeModelText("see https://example.com/a/b.")).toBe("see `https://example.com/a/b`.");
    expect(sanitizeModelText("(https://example.com/x)")).toBe("(`https://example.com/x`)");
    expect(sanitizeModelText("go to www.example.com")).toBe("go to `www.example.com`");
  });

  it("leaves no clickable markdown link behind, whatever the nesting", () => {
    for (const input of [
      "[a [b] c](//evil.example)",
      "[x](https://evil.example/((nested)))",
      "\\[a\\](//evil.example)",
      "[ref]\n\n[ref]: //evil.example",
      "[^1]\n\n[^1]: footnote",
      "<https://evil.example>",
    ]) {
      const out = sanitizeModelText(input);
      expect(out, input).not.toMatch(/(?<!\\)(?:\\\\)*\[/);
      expect(out, input).not.toMatch(/(?<!\\)(?:\\\\)*\]/);
      expect(rawHtml(out), input).toEqual([]);
    }
  });
});

describe("sanitizeModelText: code", () => {
  it("keeps inline code verbatim, Terraform addresses included", () => {
    const text = 'replace `module.db["orders"].aws_db_instance.this[0]` and `encrypted = var.x`';
    expect(sanitizeModelText(text)).toBe(text);
  });

  it("keeps fenced code verbatim", () => {
    const text = "Fix:\n\n```hcl\nencrypted = true # @octocat <b>\n```\n\nDone.";
    expect(sanitizeModelText(text)).toBe(text);
  });

  it("escapes unpaired backticks so GitHub cannot pair them differently", () => {
    expect(sanitizeModelText("a ` b <i>")).toBe("a \\` b &lt;i&gt;");
    const out = sanitizeModelText("a `b\nc` <img src=x> `d`");
    expect(out).toBe("a \\`b\nc` <img src=x> `d\\`");
    expect(rawHtml(out)).toEqual([]);
  });

  it("closes an unclosed fence so it cannot swallow what follows", () => {
    expect(sanitizeModelText("```hcl\nencrypted = false")).toBe("```hcl\nencrypted = false\n```");
  });

  it("re-emits nested fences at column 0", () => {
    const text = "1. Revert:\n   ```hcl\n   encrypted = true\n   ```\n2. Re-plan.";
    expect(sanitizeModelText(text)).toBe("1. Revert:\n```hcl\nencrypted = true\n```\n2. Re-plan.");
  });

  it("renders diagram fences as plain text", () => {
    expect(sanitizeModelText("```mermaid\ngraph TD; A-->B\n```")).toMatch(/^```text\n/);
  });

  it("breaks table delimiter rows", () => {
    expect(sanitizeModelText("| a | b |\n|---|---|").split("\n")).toEqual(["| a | b |", "\\|---|---|"]);
  });

  it("keeps a line that starts a tilde fence only after comment removal as prose", () => {
    const out = sanitizeModelText("<!---->~~~\nfoo\n~~~\n<img src=x> @octocat\n~~~");
    expect(out.split("\n")[0]).toBe("\\~~~");
    expect(rawHtml(out)).toEqual([]);
  });

  it("leaves thematic breaks and list items alone", () => {
    expect(sanitizeModelText("a\n\n---\n\n- b")).toBe("a\n\n---\n\n- b");
  });
});

describe("sanitizeInline", () => {
  it("collapses whitespace and keeps no block structure", () => {
    expect(sanitizeInline("  Orders DB\n\n# replaced  ")).toBe("Orders DB # replaced");
  });

  it("caps before sanitizing so no escape is cut in half", () => {
    const out = sanitizeInline("<".repeat(50), 10);
    expect(out).toBe(`${"&lt;".repeat(9)}…`);
  });
});

describe("escapeText", () => {
  it("escapes markdown, HTML, mentions, references and autolinks", () => {
    expect(escapeText("*a* _b_ `c` [d](e) | ~f~ $g$ <h> @i #1 https://x www.y")).toBe(
      `\\*a\\* \\_b\\_ \\\`c\\\` \\[d\\](e) \\| \\~f\\~ \\$g\\$ &lt;h&gt; @${ZWSP}i #${ZWSP}1 https:${ZWSP}//x www${ZWSP}.y`,
    );
  });

  it("collapses newlines and caps", () => {
    expect(escapeText("a\nb\n\nc", 4)).toBe("a b…");
  });
});

describe("codeSpan", () => {
  it("shows addresses with quotes and brackets verbatim", () => {
    expect(codeSpan('module.svc["a.b"].aws_s3_bucket.this[0]')).toBe(
      '`module.svc["a.b"].aws_s3_bucket.this[0]`',
    );
  });

  it("uses a longer delimiter than any backtick run and pads edge backticks", () => {
    expect(codeSpan("a`b")).toBe("``a`b``");
    expect(codeSpan("`x``")).toBe("``` `x`` ```");
    expect(codeSpan(" x")).toBe("`  x `");
  });

  it("joins lines, strips control characters and defuses markers", () => {
    expect(codeSpan("a\nb\u0007")).toBe("`a b`");
    expect(codeSpan("<!-- finding:x -->")).toBe(`\`<!-${ZWSP}- finding:x -->\``);
  });

  it("returns empty for empty input and caps long values", () => {
    expect(codeSpan("")).toBe("");
    expect(codeSpan("abcdef", 4)).toBe("`abc…`");
  });

  it("tableCode escapes pipes and shows a dash for empty", () => {
    expect(tableCode("a|b")).toBe("`a\\|b`");
    expect(tableCode("")).toBe("—");
  });
});

describe("helpers", () => {
  it("codeFence is longer than any backtick run", () => {
    expect(codeFence("x")).toBe("```");
    expect(codeFence("````")).toBe("`````");
  });

  it("defuseMarkers only touches our markers", () => {
    expect(defuseMarkers("<!-- other -->")).toBe("<!-- other -->");
    expect(defuseMarkers("<!--tf-change-reviewer")).toBe(`<!-${ZWSP}-tf-change-reviewer`);
  });

  it("truncate never splits a surrogate pair", () => {
    expect(truncate("ab😀cd", 4)).toBe("ab…");
    expect(truncate("abc", 3)).toBe("abc");
  });

  it("normalize converts CRLF and strips controls", () => {
    expect(normalize("a\r\nb\rc\u0000\u009b")).toBe("a\nb\nc");
  });

  it("safeUrl accepts plain https only", () => {
    expect(safeUrl("https://github.com/o/r/actions/runs/1")).toBe("https://github.com/o/r/actions/runs/1");
    for (const bad of [
      "http://x",
      "javascript:alert(1)",
      "https://x/a b",
      "https://x/(y)",
      "",
      undefined,
      null,
    ]) {
      expect(safeUrl(bad), String(bad)).toBeNull();
    }
  });

  it("encodeUrlSegment encodes parentheses and reserved characters", () => {
    expect(encodeUrlSegment("a (b)#?.tf")).toBe("a%20%28b%29%23%3F.tf");
  });

  it("repoRelativePath rejects traversal, absolute paths and schemes", () => {
    expect(repoRelativePath("./modules/db/main.tf")).toBe("modules/db/main.tf");
    for (const bad of [
      "",
      "../x",
      "a/../b",
      "/etc/passwd",
      "C:\\x",
      "https://x",
      "a//b",
      "a/./b",
      "a\u0000b",
    ]) {
      expect(repoRelativePath(bad), bad).toBeNull();
    }
    expect(repoRelativePath("a".repeat(600))).toBeNull();
  });
});
