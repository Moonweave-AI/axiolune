function CodeBlock(block)
  if block.classes:includes("mermaid") then
    local escaped = block.text
      :gsub("&", "&amp;")
      :gsub("<", "&lt;")
      :gsub(">", "&gt;")
    return pandoc.RawBlock("html", '<pre class="mermaid">' .. escaped .. "</pre>")
  end
end

