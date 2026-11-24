import { describe, expect, it } from "vitest";
import {
  evaluateLiteral,
  findReferences,
  locateObjectKey,
  parseHcl,
  type HclBlock,
  type HclBody,
} from "../../src/lineage/hcl.js";

const block = (body: HclBody, type: string, ...labels: string[]): HclBlock => {
  const b = body.blocks.find((x) => x.type === type && labels.every((l, i) => x.labels[i] === l));
  if (!b) throw new Error(`no block ${type} ${labels.join(" ")}`);
  return b;
};
const attr = (body: HclBody, name: string) => {
  const a = body.attributes.find((x) => x.name === name);
  if (!a) throw new Error(`no attribute ${name}`);
  return a;
};
const spans = (body: HclBody) => body.attributes.map((a) => [a.name, a.startLine, a.endLine]);

describe("parseHcl: structure", () => {
  it("parses blocks with labels, attributes and 1-based line spans", () => {
    const body = parseHcl(
      [
        'resource "aws_db_instance" "this" {', // 1
        "  identifier        = local.identifier", // 2
        "  storage_encrypted = var.encrypted", // 3
        "}", // 4
        "", // 5
        'variable "encrypted" {', // 6
        "  type    = bool", // 7
        "  default = true", // 8
        "}", // 9
      ].join("\n"),
    );
    const r = block(body, "resource", "aws_db_instance", "this");
    expect([r.startLine, r.endLine]).toEqual([1, 4]);
    expect(spans(r.body)).toEqual([
      ["identifier", 2, 2],
      ["storage_encrypted", 3, 3],
    ]);
    expect(attr(r.body, "storage_encrypted").exprText).toBe("var.encrypted");
    const v = block(body, "variable", "encrypted");
    expect([v.startLine, v.endLine]).toEqual([6, 9]);
    expect(attr(v.body, "default")).toEqual({ name: "default", startLine: 8, endLine: 8, exprText: "true" });
  });

  it("handles one-line blocks and blocks without labels", () => {
    const body = parseHcl('variable "x" { default = 1 }\nlocals { a = { b = 2 } }\nterraform {}\n');
    const v = block(body, "variable", "x");
    expect([v.startLine, v.endLine]).toEqual([1, 1]);
    expect(attr(v.body, "default").exprText).toBe("1");
    expect(attr(block(body, "locals").body, "a").exprText).toBe("{ b = 2 }");
    expect(block(body, "terraform").body).toEqual({ attributes: [], blocks: [] });
  });

  it("parses nested and dynamic blocks", () => {
    const body = parseHcl(
      [
        'resource "aws_security_group" "db" {',
        "  ingress {",
        "    cidr_blocks = var.office",
        "  }",
        '  dynamic "ingress" {',
        "    for_each = var.rules",
        "    iterator = rule",
        "    content {",
        "      cidr_blocks = rule.value.cidrs",
        "    }",
        "  }",
        "}",
      ].join("\n"),
    );
    const sg = block(body, "resource", "aws_security_group", "db");
    expect(sg.body.blocks.map((b) => [b.type, b.labels, b.startLine, b.endLine])).toEqual([
      ["ingress", [], 2, 4],
      ["dynamic", ["ingress"], 5, 11],
    ]);
    const dyn = block(sg.body, "dynamic", "ingress");
    expect(spans(dyn.body)).toEqual([
      ["for_each", 6, 6],
      ["iterator", 7, 7],
    ]);
    expect(attr(block(dyn.body, "content").body, "cidr_blocks")).toMatchObject({
      startLine: 9,
      exprText: "rule.value.cidrs",
    });
  });

  it("accepts identifier labels and identifiers with dashes", () => {
    const body = parseHcl("resource aws_s3_bucket logs {\n  my-attr = 1\n}\n");
    const b = block(body, "resource", "aws_s3_bucket", "logs");
    expect(attr(b.body, "my-attr").exprText).toBe("1");
  });

  it("decodes escapes in quoted labels", () => {
    const body = parseHcl('provider "a\\"b" {\n}\nmodule "x\\u00e9" {}\n');
    expect(body.blocks.map((b) => b.labels[0])).toEqual(['a"b', "xé"]);
  });

  it("parses top-level attributes (tfvars)", () => {
    const body = parseHcl('environment = "prod"\nbuckets     = ["a", "b"]\n\nretention = 14\n');
    expect(spans(body)).toEqual([
      ["environment", 1, 1],
      ["buckets", 2, 2],
      ["retention", 4, 4],
    ]);
  });

  it("returns an empty body for empty or blank input", () => {
    expect(parseHcl("")).toEqual({ attributes: [], blocks: [] });
    expect(parseHcl("\n\n  \n# only a comment\n")).toEqual({ attributes: [], blocks: [] });
  });
});

describe("parseHcl: strings and templates", () => {
  it("does not close blocks on braces inside strings or templates", () => {
    const body = parseHcl(
      [
        "locals {",
        '  a = "not { a block } # not a comment // either"',
        '  b = "${jsonencode({ k = "}" })}-x"',
        '  c = "%{ if var.on }{%{ endif }"',
        "  d = 1",
        "}",
        'variable "after" {}',
      ].join("\n"),
    );
    const l = block(body, "locals");
    expect(spans(l.body)).toEqual([
      ["a", 2, 2],
      ["b", 3, 3],
      ["c", 4, 4],
      ["d", 5, 5],
    ]);
    expect(attr(l.body, "a").exprText).toBe('"not { a block } # not a comment // either"');
    expect(attr(l.body, "b").exprText).toBe('"${jsonencode({ k = "}" })}-x"');
    expect([l.startLine, l.endLine]).toEqual([1, 6]);
    expect(block(body, "variable", "after").startLine).toBe(7);
  });

  it("treats $${ and %%{ as literal text, and escaped quotes as part of the string", () => {
    const body = parseHcl('a = "$${not} %%{ also } \\" } {"\nb = 2\n');
    expect(attr(body, "a").exprText).toBe('"$${not} %%{ also } \\" } {"');
    expect(attr(body, "b").startLine).toBe(2);
  });

  it("allows interpolations to span lines", () => {
    const body = parseHcl('a = "${join(",", [\n  "x",\n  "y",\n])}"\nb = 1\n');
    expect(spans(body)).toEqual([
      ["a", 1, 4],
      ["b", 5, 5],
    ]);
  });

  it("ends an unterminated string at the end of its line", () => {
    const body = parseHcl('a = "never closed\nb = 2\n');
    expect(spans(body)).toEqual([
      ["a", 1, 1],
      ["b", 2, 2],
    ]);
  });
});

describe("parseHcl: heredocs", () => {
  it("skips braces, quotes and comment markers in a heredoc body", () => {
    const body = parseHcl(
      [
        'resource "aws_iam_policy" "p" {', // 1
        "  policy = <<EOF", // 2
        "{", // 3
        '  "Statement": [{ "Resource": "${aws_s3_bucket.b.arn}/*" }], # x', // 4
        "  } // not a comment", // 5
        "EOF", // 6
        '  name = "p"', // 7
        "}", // 8
      ].join("\n"),
    );
    const p = block(body, "resource", "aws_iam_policy", "p");
    expect([p.startLine, p.endLine]).toEqual([1, 8]);
    expect(spans(p.body)).toEqual([
      ["policy", 2, 6],
      ["name", 7, 7],
    ]);
    expect(attr(p.body, "policy").exprText.startsWith("<<EOF\n{")).toBe(true);
  });

  it("supports <<- with an indented terminator and any identifier", () => {
    const body = parseHcl("locals {\n  script = <<-SCRIPT_1\n    echo }\n    SCRIPT_1\n  x = 2\n}\n");
    const l = block(body, "locals");
    expect(spans(l.body)).toEqual([
      ["script", 2, 4],
      ["x", 5, 5],
    ]);
  });

  it("tolerates an indented terminator for <<EOF and does not end on a longer word", () => {
    const body = parseHcl("a = <<EOF\nEOFX\n  EOF\nb = 1\n");
    expect(spans(body)).toEqual([
      ["a", 1, 3],
      ["b", 4, 4],
    ]);
  });

  it("swallows the rest of the file for an unterminated heredoc without throwing", () => {
    const body = parseHcl("a = <<EOF\nline\n}\nb = 2\n");
    expect(spans(body)).toEqual([["a", 1, 5]]);
  });

  it("does not treat << without an identifier and newline as a heredoc", () => {
    const body = parseHcl("a = 1 << 2\nb = 3\n");
    expect(spans(body)).toEqual([
      ["a", 1, 1],
      ["b", 2, 2],
    ]);
  });
});

describe("parseHcl: comments", () => {
  it("ignores #, // and /* */ comments, keeping line numbers", () => {
    const body = parseHcl(
      [
        "# header { comment", // 1
        "// another } comment", // 2
        "/* block {", // 3
        "   } comment */", // 4
        'variable "x" { # trailing {', // 5
        "  default = 1 // trailing }", // 6
        "  /* inline */ type = number", // 7
        "}", // 8
      ].join("\n"),
    );
    const v = block(body, "variable", "x");
    expect([v.startLine, v.endLine]).toEqual([5, 8]);
    expect(spans(v.body)).toEqual([
      ["default", 6, 6],
      ["type", 7, 7],
    ]);
    expect(attr(v.body, "default").exprText).toBe("1");
  });

  it("survives an unterminated block comment", () => {
    expect(parseHcl('a = 1\n/* open {\nb = "x"\n')).toEqual({
      attributes: [{ name: "a", startLine: 1, endLine: 1, exprText: "1" }],
      blocks: [],
    });
  });
});

describe("parseHcl: multi-line expressions", () => {
  it("spans objects, lists, calls and for-expressions", () => {
    const body = parseHcl(
      [
        "locals {", // 1
        "  tags = {", // 2
        '    Name = "x"', // 3
        "  }", // 4
        "  list = [", // 5
        '    "a",', // 6
        "  ]", // 7
        "  merged = merge(", // 8
        "    local.tags,", // 9
        "  )", // 10
        "  ids = {", // 11
        "    for k, v in var.m :", // 12
        "    k => v.id", // 13
        "  }", // 14
        "  pick = (", // 15
        "    var.a ? 1 : 2", // 16
        "  )", // 17
        "}", // 18
      ].join("\n"),
    );
    expect(spans(block(body, "locals").body)).toEqual([
      ["tags", 2, 4],
      ["list", 5, 7],
      ["merged", 8, 10],
      ["ids", 11, 14],
      ["pick", 15, 17],
    ]);
  });

  it("continues a conditional across lines after a trailing or before a leading operator", () => {
    const body = parseHcl(
      ["a = var.x ?", '  "y" :', '  "z"', "b = var.p", "  ? 1", "  : 2", "c = 3"].join("\n"),
    );
    expect(spans(body)).toEqual([
      ["a", 1, 3],
      ["b", 4, 6],
      ["c", 7, 7],
    ]);
    expect(attr(body, "a").exprText).toBe('var.x ?\n  "y" :\n  "z"');
  });

  it("distinguishes = from ==, >=, <=, != and =>", () => {
    const body = parseHcl(
      [
        "a = b == c",
        "d = e >= 1 && f <= 2 && g != 3",
        "h = { for k, v in m : k => v }",
        "i == j",
        "k = 1",
      ].join("\n"),
    );
    expect(spans(body)).toEqual([
      ["a", 1, 1],
      ["d", 2, 2],
      ["h", 3, 3],
      ["k", 5, 5],
    ]);
    expect(attr(body, "a").exprText).toBe("b == c");
  });

  it("records an empty expression for `name =` at the end of a line", () => {
    const body = parseHcl("a =\nb = 2\n");
    expect(body.attributes).toEqual([
      { name: "a", startLine: 1, endLine: 1, exprText: "" },
      { name: "b", startLine: 2, endLine: 2, exprText: "2" },
    ]);
  });
});

describe("parseHcl: line endings and malformed input", () => {
  it("handles CRLF line endings and a BOM", () => {
    const body = parseHcl('﻿variable "x" {\r\n  default = "a"\r\n}\r\nb = 1\r\n');
    const v = block(body, "variable", "x");
    expect([v.startLine, v.endLine]).toEqual([1, 3]);
    expect(attr(v.body, "default").exprText).toBe('"a"');
    expect(attr(body, "b").startLine).toBe(4);
  });

  it("closes an unterminated block at the last line with content", () => {
    const body = parseHcl('resource "a_b" "c" {\n  x = 1\n  nested {\n    y = 2\n\n');
    const r = block(body, "resource", "a_b", "c");
    expect([r.startLine, r.endLine]).toEqual([1, 4]);
    expect(block(r.body, "nested").endLine).toBe(4);
  });

  it("skips stray closing braces and garbage lines, keeping later blocks", () => {
    const body = parseHcl('}\n)))\n@@ weird !!\nresource "a_b" "c" {\n  = nonsense\n  x = 1\n}\n}\n');
    const r = block(body, "resource", "a_b", "c");
    expect([r.startLine, r.endLine]).toEqual([4, 7]);
    expect(spans(r.body)).toEqual([["x", 6, 6]]);
  });

  it("never throws on pathological input", () => {
    const inputs = [
      "a {".repeat(5000),
      "x = " + "(".repeat(5000),
      '"'.repeat(1000),
      "${".repeat(2000),
      'a = "' + "${".repeat(200) + "x",
      "<<EOF",
      "<<-",
      "/*",
      "\u0000\u0001￿\uD800",
      Array.from({ length: 500 }, (_, i) => String.fromCharCode(i)).join(""),
    ];
    for (const input of inputs) expect(() => parseHcl(input)).not.toThrow();
  });
});

describe("findReferences", () => {
  it("keeps a resource's [count.index] / [each.key] so the tracer can pick the same instance", () => {
    expect(findReferences("aws_s3_bucket.data[count.index].bucket")).toEqual([
      "aws_s3_bucket.data[count.index].bucket",
      "aws_s3_bucket.data[count.index]",
      "aws_s3_bucket.data",
      "count.index",
    ]);
    expect(findReferences("module.m[each.key].out")).toEqual(["module.m", "each.key"]);
  });

  it("lists references like terraform show -json (full traversal, prefixes, keyless subject)", () => {
    // Verified against terraform 1.10.5 plan JSON for the same expressions.
    expect(
      findReferences('"${each.value.cidr}-${terraform_data.one[0].output}-${local.a["k"]}-${local.b}"'),
    ).toEqual([
      "each.value.cidr",
      "each.value",
      "terraform_data.one[0].output",
      "terraform_data.one[0]",
      "terraform_data.one",
      'local.a["k"]',
      "local.a",
      "local.b",
    ]);
    expect(
      findReferences(
        '{ obj = terraform_data.two["x"].id, m = module.m.out, mm = module.m, p = path.module, w = terraform.workspace, nested = { k = var.obj["x"].cidr } }',
      ),
    ).toEqual([
      'terraform_data.two["x"].id',
      'terraform_data.two["x"]',
      "terraform_data.two",
      "module.m.out",
      "module.m",
      "path.module",
      "terraform.workspace",
      'var.obj["x"].cidr',
      'var.obj["x"]',
      "var.obj",
    ]);
    expect(findReferences("var.list[count.index]")).toEqual(["var.list", "count.index"]);
  });

  it("finds every reference kind", () => {
    expect(findReferences("var.x")).toEqual(["var.x"]);
    expect(findReferences("local.y")).toEqual(["local.y"]);
    expect(findReferences('module.m["a"].out.x')).toEqual([
      'module.m["a"].out.x',
      'module.m["a"].out',
      "module.m",
    ]);
    expect(findReferences("data.aws_iam_policy_document.p.json")).toEqual([
      "data.aws_iam_policy_document.p.json",
      "data.aws_iam_policy_document.p",
    ]);
    expect(findReferences("data.aws_ami.a[0].id")).toEqual([
      "data.aws_ami.a[0].id",
      "data.aws_ami.a[0]",
      "data.aws_ami.a",
    ]);
    expect(findReferences("each.key")).toEqual(["each.key"]);
    expect(findReferences("count.index + 1")).toEqual(["count.index"]);
    expect(findReferences("self.private_ip")).toEqual(["self.private_ip", "self"]);
    expect(findReferences("aws_subnet.private.id")).toEqual(["aws_subnet.private.id", "aws_subnet.private"]);
    expect(findReferences("aws_vpc.main")).toEqual(["aws_vpc.main"]);
  });

  it("ignores string literal text but reads interpolations and directives", () => {
    expect(findReferences('"var.not_a_ref local.nope ${var.yes}"')).toEqual(["var.yes"]);
    expect(findReferences('"%{ if var.on }x%{ endif }"')).toEqual(["var.on"]);
    expect(findReferences('"$${var.escaped}"')).toEqual([]);
  });

  it("reads references inside heredocs", () => {
    expect(findReferences('<<EOF\n{"Resource": "${aws_s3_bucket.b.arn}/*"}\nvar.text\nEOF')).toEqual([
      "aws_s3_bucket.b.arn",
      "aws_s3_bucket.b",
    ]);
  });

  it("ignores object keys, function names and provider functions", () => {
    expect(findReferences('{ var = 1, aws_thing = 2, "local" = 3, name = var.n }')).toEqual(["var.n"]);
    expect(findReferences('lookup(var.m, "k", local.d)')).toEqual(["var.m", "local.d"]);
    expect(findReferences("provider::aws::arn_parse(var.arn).region")).toEqual(["var.arn"]);
    expect(findReferences("upper(trimspace(var.a))")).toEqual(["var.a"]);
  });

  it("keeps traversals followed by ':' in conditionals (not object keys)", () => {
    expect(findReferences("{ a = var.x ? local.b : local.c }")).toEqual(["var.x", "local.b", "local.c"]);
    expect(findReferences("{\n  a = var.x ?\n  local.b_c : local.d\n}")).toEqual([
      "var.x",
      "local.b_c",
      "local.d",
    ]);
  });

  it("excludes for-expression iterators, also when they look like resource references", () => {
    expect(findReferences('[for s in var.list : upper(s) if s != "x"]')).toEqual(["var.list"]);
    expect(findReferences("{ for k, my_item in var.m : k => my_item.name_x if my_item.enabled }")).toEqual([
      "var.m",
    ]);
    expect(findReferences("[for az, s in aws_subnet.private : s.id]")).toEqual(["aws_subnet.private"]);
    // The iterator only shadows inside its own brackets.
    expect(findReferences("[for my_x in var.l : my_x.id] ++ my_x.other")).toEqual(["var.l", "my_x.other"]);
  });

  it("excludes template for-directive iterators", () => {
    expect(findReferences('"%{ for my_item in var.items }${my_item.name}${local.sep}%{ endfor }"')).toEqual([
      "var.items",
      "local.sep",
    ]);
  });

  it("stops at splats and dynamic indexes but scans the index expression", () => {
    expect(findReferences("aws_instance.web[*].id")).toEqual(["aws_instance.web"]);
    expect(findReferences("aws_instance.web.*.id")).toEqual(["aws_instance.web"]);
    expect(findReferences("module.vpc.private_subnet_ids[each.value]")).toEqual([
      "module.vpc.private_subnet_ids",
      "module.vpc",
      "each.value",
    ]);
    expect(findReferences("var.m[local.k].attr")).toEqual(["var.m", "local.k"]);
  });

  it("does not report attribute access on non-traversals or roots without an underscore", () => {
    expect(findReferences("f(var.x).aws_thing.name")).toEqual(["var.x"]);
    expect(findReferences("ingress.value.cidrs")).toEqual([]);
    expect(findReferences("each.other")).toEqual([]);
    expect(findReferences("var")).toEqual([]);
    expect(findReferences("true && null == false")).toEqual([]);
  });

  it("treats extra iterator roots like var (dynamic blocks)", () => {
    expect(findReferences("ingress.value.cidrs", ["ingress"])).toEqual([
      "ingress.value.cidrs",
      "ingress.value",
    ]);
    expect(findReferences("ip_rule.key", ["ip_rule"])).toEqual(["ip_rule.key"]);
  });

  it("dedupes, keeps order, ignores comments, and never throws", () => {
    expect(findReferences("var.a + var.a # var.b\n// local.c\n/* local.d */ + local.e")).toEqual([
      "var.a",
      "local.e",
    ]);
    expect(findReferences("")).toEqual([]);
    expect(() => findReferences("${".repeat(5000))).not.toThrow();
    expect(() => findReferences("[".repeat(5000) + "var.x")).not.toThrow();
  });
});

describe("evaluateLiteral", () => {
  it("evaluates tfvars-style literals", () => {
    expect(evaluateLiteral('"prod"')).toEqual({ ok: true, value: "prod" });
    expect(evaluateLiteral("14")).toEqual({ ok: true, value: 14 });
    expect(evaluateLiteral("-1.5e2")).toEqual({ ok: true, value: -150 });
    expect(evaluateLiteral("true")).toEqual({ ok: true, value: true });
    expect(evaluateLiteral("null")).toEqual({ ok: true, value: null });
    expect(evaluateLiteral('["a", "b",]')).toEqual({ ok: true, value: ["a", "b"] });
    expect(evaluateLiteral('{\n  a = 1\n  "b-c" : { d = [true] },\n}')).toEqual({
      ok: true,
      value: { a: 1, "b-c": { d: [true] } },
    });
    expect(evaluateLiteral('"tab\\tquote\\" \\u00e9"')).toEqual({ ok: true, value: 'tab\tquote" é' });
  });

  it("evaluates heredocs without interpolation, trimming <<- indentation", () => {
    expect(evaluateLiteral("<<EOF\n  a\nb\nEOF")).toEqual({ ok: true, value: "  a\nb\n" });
    expect(evaluateLiteral("<<-EOF\n    a\n      b\n    EOF")).toEqual({ ok: true, value: "a\n  b\n" });
  });

  it("rejects anything that is not a literal", () => {
    for (const expr of ["var.x", '"${var.x}"', 'upper("a")', "1 + 2", "[1 2]", "{ a = var.b }", "", "a"]) {
      expect(evaluateLiteral(expr)).toEqual({ ok: false });
    }
  });
});

describe("locateObjectKey", () => {
  const tags = [
    "{",
    '  Project     = "orders"',
    '  "Cost-Center" = "cc"',
    "  Nested = {",
    "    Project = 1",
    "  }",
    "}",
  ].join("\n");

  it("finds a key's relative lines in the top-level object", () => {
    expect(locateObjectKey(tags, "Project")).toEqual({ startLine: 2, endLine: 2 });
    expect(locateObjectKey(tags, "Cost-Center")).toEqual({ startLine: 3, endLine: 3 });
    expect(locateObjectKey(tags, "Nested")).toEqual({ startLine: 4, endLine: 6 });
    expect(locateObjectKey('{ a = 1, b = "x" }', "b")).toEqual({ startLine: 1, endLine: 1 });
  });

  it("returns null for missing keys, nested-only keys and non-objects", () => {
    expect(locateObjectKey(tags, "Missing")).toBeNull();
    expect(locateObjectKey("{ outer = { inner = 1 } }", "inner")).toBeNull();
    expect(locateObjectKey("var.tags", "Project")).toBeNull();
    expect(locateObjectKey('merge(var.t, { Project = "x" })', "Project")).toBeNull();
  });
});
