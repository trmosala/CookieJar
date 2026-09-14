import test from "node:test"
import assert from "node:assert/strict"
import { markdown } from "../src/markdown.mjs"

test("Markdown preserves formatted blocks and renders unsafe input as inert text", () => {
  const tree = markdown("# Heading\n\n**Bold** and *italic*\n\n- one\n- two\n\n```js\nalert(1)\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n<script>bad()</script>\n\n[x](javascript:bad())\n\n![secret](https://example.com/tracker)")
  const tags = []
  const visit = nodes => nodes.forEach(n => { if (n.tag) tags.push(n.tag); visit(n.children || []) })
  visit(tree)
  for (const tag of ["h1", "strong", "em", "ul", "li", "pre", "code", "table", "td"]) assert.ok(tags.includes(tag), tag)
  assert.ok(!tags.includes("script") && !tags.includes("img") && !tags.includes("a"))
  assert.match(JSON.stringify(tree), /bad\(\)/)
  assert.ok(!JSON.stringify(tree).includes('"href"'))
})
