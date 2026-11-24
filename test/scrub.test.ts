import { describe, expect, it } from "vitest";
import { createFormMatcher, createScrubber, encodedForms, isSecretLine, NO_SCRUB } from "../src/scrub.js";

const S = "(sensitive)";

describe("createScrubber", () => {
  it("replaces long values anywhere, longest first", () => {
    const s = createScrubber(["secret-part-1", "secret-part-1-and-more"]);
    expect(s.text("dsn=secret-part-1-and-more; other=secret-part-1")).toBe(`dsn=${S}; other=${S}`);
  });

  it("replaces short values only whole or quoted, and ignores values under 4 characters", () => {
    const s = createScrubber(["4711", "ab"]);
    expect(s.text("4711")).toBe(S);
    expect(s.text('pin = "4711"')).toBe(`pin = "${S}"`);
    expect(s.text("room 4711 ab")).toBe("room 4711 ab");
    expect(s.size).toBe(1);
  });

  it("keeps line numbers: a multi-line value leaves its line breaks", () => {
    const pem = "-----BEGIN KEY-----\nAAAABBBBCCCC\n-----END KEY-----";
    const s = createScrubber([pem]);
    const text = `a\nkey = <<EOF\n${pem}\nEOF\nb`;
    const out = s.text(text);
    expect(out.split("\n")).toHaveLength(text.split("\n").length);
    expect(out).not.toContain("AAAABBBBCCCC");
  });

  it("treats regex metacharacters literally and is a no-op without values", () => {
    const s = createScrubber(["a.b*c+(d)?"]);
    expect(s.text("x a.b*c+(d)? y aXbbc")).toBe(`x ${S} y aXbbc`);
    expect(NO_SCRUB.text("anything")).toBe("anything");
    expect(NO_SCRUB.size).toBe(0);
  });

  it("matches a value in its HCL-quoted form (backslash and template escapes)", () => {
    const s = createScrubber([
      'Mod"Const-Pw-77',
      "back\\slash-Pw-91",
      "pre${x}-Tmpl-Pw-3",
      "pct%{y}-Tmpl-Pw-4",
    ]);
    expect(s.text('db_pass = "Mod\\"Const-Pw-77"')).toBe(`db_pass = "${S}"`);
    expect(s.text('k = "back\\\\slash-Pw-91"')).toBe(`k = "${S}"`);
    expect(s.text('t = "pre$${x}-Tmpl-Pw-3" u = "pct%%{y}-Tmpl-Pw-4"')).toBe(`t = "${S}" u = "${S}"`);
  });

  it("matches a value in its JSON-encoded forms, Go's HTML-safe escapes included", () => {
    const s = createScrubber(['Def&Pass<w>"q1', "Sig-Heredoc-Value-9z\n"]);
    // terraform show -json writes & < > as unicode escapes; JSON.stringify does not.
    expect(s.text('{"db_password":{"value":"Def\\u0026Pass\\u003cw\\u003e\\"q1"}}')).toBe(
      `{"db_password":{"value":"${S}"}}`,
    );
    expect(s.text('{"v":"Def&Pass<w>\\"q1"}')).toBe(`{"v":"${S}"}`);
    expect(s.text('{"signing_secret":{"value":"Sig-Heredoc-Value-9z\\n"}}')).toBe(
      `{"signing_secret":{"value":"${S}"}}`,
    );
  });

  it("matches a short value's escaped form when quoted", () => {
    const s = createScrubber(['a"bc']);
    expect(s.text('pin = "a\\"bc"')).toBe(`pin = "${S}"`);
    expect(s.text('{"pin":"a\\"bc"}')).toBe(`{"pin":"${S}"}`);
  });

  it("matches a multi-line value line by line: indented heredocs and partial diff hunks", () => {
    // The plan holds the dedented value of a <<-EOT heredoc; the source keeps the indentation.
    const s = createScrubber(["host=db.internal\nkey=Zq81-Indent-Secret\n"]);
    const source = [
      'variable "svc_config" {',
      "  sensitive = true",
      "  default   = <<-EOT",
      "    host=db.internal",
      "    key=Zq81-Indent-Secret",
      "  EOT",
      "}",
    ].join("\n");
    const out = s.text(source);
    expect(out).not.toContain("Zq81-Indent-Secret");
    expect(out).not.toContain("host=db.internal");
    expect(out.split("\n")).toHaveLength(7);
    expect(out.split("\n")[5]).toBe("  EOT");
    expect(s.text("@@ -8 +8 @@\n-    key=old\n+    key=Zq81-Indent-Secret")).not.toContain("Zq81");
  });

  it("lists each encoded form of the whole value once", () => {
    expect(encodedForms("plainvalue")).toEqual(["plainvalue"]);
    const forms = encodedForms("ab\ncdefghij\nk");
    expect(forms).toEqual(expect.arrayContaining(["ab\ncdefghij\nk", "ab\\ncdefghij\\nk"]));
    // Lines are createLineMatcher's: a lone line is not a form of the value.
    expect(forms).not.toContain("cdefghij");
    expect(new Set(forms).size).toBe(forms.length);
  });

  it("keeps the lines a multi-line secret shares with ordinary text: only distinctive lines alone", () => {
    const script = [
      "#!/bin/bash",
      "set -euo pipefail",
      "export DB_PASS='Qp7-Real-Db-Pass'",
      "systemctl restart worker-service",
      "",
    ].join("\n");
    const s = createScrubber([script]);
    const other = [
      'resource "terraform_data" "web" {',
      "  input = <<-EOT",
      "    #!/bin/bash",
      "    set -euo pipefail",
      "    systemctl restart worker-service",
      "    curl -fsS http://localhost/health",
      "  EOT",
      "}",
    ].join("\n");
    expect(s.text(other)).toBe(other);
    expect(s.text("+    set -euo pipefail\n+    export DB_PASS='Qp7-Real-Db-Pass'")).toBe(
      `+    set -euo pipefail\n+    ${S}`,
    );
  });

  it("keeps ordinary lines a secret script shares with source, even when they mix character classes", () => {
    const worker = [
      "#!/bin/bash",
      "export AWS_DEFAULT_REGION=us-east-1",
      'echo "Installing Docker 24"',
      "export DB_PASS='Qp7-Real-Db-Pass'",
      "",
    ].join("\n");
    const s = createScrubber([worker]);
    const source = [
      'resource "aws_instance" "web" {',
      "  user_data = <<-EOT",
      "    #!/bin/bash",
      "    export AWS_DEFAULT_REGION=us-west-2",
      "    export AWS_DEFAULT_REGION=us-east-1",
      '    echo "Installing Docker 24"',
      "  EOT",
      "}",
    ].join("\n");
    expect(s.text(source)).toBe(source);
    expect(s.text("-    export AWS_DEFAULT_REGION=us-east-1\n+    export AWS_DEFAULT_REGION=us-west-2")).toBe(
      "-    export AWS_DEFAULT_REGION=us-east-1\n+    export AWS_DEFAULT_REGION=us-west-2",
    );
    // The secret line alone is hidden, in a partial hunk and inside a longer line.
    expect(s.text("+    export DB_PASS='Qp7-Real-Db-Pass'")).toBe(`+    ${S}`);
    expect(s.text("# was: export DB_PASS='Qp7-Real-Db-Pass' # old")).toBe(`# was: ${S} # old`);
  });

  it("hides a secret line embedded in a longer line, in its template-escaped form too", () => {
    const s = createScrubber(["host=db.internal\r\nkey=Tm${x}-Crlf-Secret-7\r\n"]);
    expect(s.text("key=Tm${x}-Crlf-Secret-7 only")).toBe(`${S} only`);
    expect(s.text('  a = "key=Tm$${x}-Crlf-Secret-7 only"')).toBe(`  a = "${S} only"`);
    expect(s.text("host=db.internal is the host")).toBe("host=db.internal is the host");
  });

  it.each([
    ["key=Zq81-Indent-Secret", true],
    ["export DB_PASS='Qp7-Real-Db-Pass'", true],
    ['"password": "hunter2hunter",', true],
    ["  client_secret: plainwordsecret", true],
    ["MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun", true],
    ["MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0g==", true],
    ["export AWS_DEFAULT_REGION=us-east-1", false],
    ['echo "Installing Docker 24"', false],
    ["-----BEGIN RSA PRIVATE KEY-----", false],
    ["#!/bin/bash", false],
    ["set -euo pipefail", false],
    ["host=db.internal", false],
    ["AMI=ami-0123456789abcdef0", false],
    ["url=https://User1:Pw@example.com/x", false],
    ["/opt/App2/bin/StartService", false],
  ])("isSecretLine(%j) is %s", (line, expected) => {
    expect(isSecretLine(line)).toBe(expected);
  });

  it("form matcher: the prefix prefilter finds every form, at any position", () => {
    const m = createFormMatcher(["abcdefghij", "zzzzzzzzzzzzzz", 'a\\"bcdefgh'], 1);
    const r = (t: string) => m.replace(t, () => "#");
    expect(r("abcdefghij")).toBe("#");
    expect(r("xxabcdefghijxxzzzzzzzzzzzzzzz")).toBe("xx#xx#z");
    expect(r('q a\\"bcdefgh q')).toBe("q # q");
    expect(r("abcdefgh ij")).toBe("abcdefgh ij");
    expect(createFormMatcher([]).replace("anything", () => "#")).toBe("anything");
  });

  it("hides every line of a multi-line value when all of them appear in a row, keeping diff markers", () => {
    const s = createScrubber(["host=db.internal\nport=5432\n"]);
    expect(s.text("@@ -1,3 +1,3 @@\n-    old=1\n+    host=db.internal\n+    port=5432\n     EOT")).toBe(
      `@@ -1,3 +1,3 @@\n-    old=1\n+    ${S}\n+    ${S}\n     EOT`,
    );
    // Neither line looks like a secret, so one of them alone is kept.
    expect(s.text("+    host=db.internal\n+    other=1")).toBe("+    host=db.internal\n+    other=1");
  });

  it("matches escaped forms only in texts that can hold them, with the same result", () => {
    const s = createScrubber(['Def&Pass<w>"q1', "Long-Value-9z"]);
    expect(s.text("a Long-Value-9z b")).toBe(`a ${S} b`);
    expect(s.text('x = "Def&Pass<w>\\"q1" y Long-Value-9z')).toBe(`x = "${S}" y ${S}`);
  });
});
