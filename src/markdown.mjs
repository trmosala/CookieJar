import { marked } from "marked"

// Convert Markdown to a bounded, inert display tree. Raw HTML and images never
// become executable markup or remote requests in the CEP panel.
export function markdown(text) {
  let budget = 6000
  const nodes = (tokens, depth = 0) => (tokens || []).flatMap(t => {
    if (--budget < 0 || depth > 16) return []
    const children = () => nodes(t.tokens, depth + 1)
    switch (t.type) {
      case "space": return []
      case "heading": return [{ tag: "h" + Math.min(6, Math.max(1, t.depth)), children: children() }]
      case "paragraph": return [{ tag: "p", children: children() }]
      case "text": return t.tokens ? children() : [{ text: t.text }]
      case "strong": case "em": case "del": return [{ tag: t.type, children: children() }]
      case "codespan": return [{ tag: "code", text: t.text }]
      case "code": return [{ tag: "pre", children: [{ tag: "code", text: t.text }] }]
      case "blockquote": return [{ tag: "blockquote", children: children() }]
      case "list": return [{ tag: t.ordered ? "ol" : "ul", children: t.items.map(item => ({ tag: "li", children: nodes(item.tokens, depth + 1) })) }]
      case "br": case "hr": return [{ tag: t.type }]
      case "link": return [{ tag: "span", children: [...children(), { text: " (" + t.href + ")" }] }]
      case "image": return [{ text: "[Image: " + (t.text || "image") + "]" }]
      case "table": return [{ tag: "table", children: [
        { tag: "thead", children: [{ tag: "tr", children: t.header.map(c => ({ tag: "th", children: nodes(c.tokens, depth + 1) })) }] },
        { tag: "tbody", children: t.rows.map(row => ({ tag: "tr", children: row.map(c => ({ tag: "td", children: nodes(c.tokens, depth + 1) })) })) },
      ] }]
      default: return [{ text: t.raw || t.text || "" }]
    }
  })
  try { return nodes(marked.lexer(text)) } catch { return [{ text }] }
}
