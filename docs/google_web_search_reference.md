# Google Web Search — Client Integration Reference

The Gemini CLI has a built-in `google_web_search` tool that is handled
transparently by Ionosphere. Clients do **not** need to list it in the
`tools` array — the model already has access to it. The only requirement
is that the client's system prompt / custom instructions tell the agent
the tool exists and how to invoke it.

---

## Option 1: System Prompt Injection (Recommended)

Add a section like the one below to whatever system prompt or custom
instructions your client program sends.

```text
## Web Search

You have access to a built-in tool called `google_web_search`.
When you need up-to-date information, current events, recent releases,
live data, or anything your training data may not cover, call this tool.

Usage — include a function call in your response exactly like this:

    google_web_search({ "query": "<your search query>" })

The search will be executed automatically and the results (with source
citations) will be incorporated into your response. You do not need to
wait for the user to provide results — the system handles execution
transparently.

Guidelines:
- Use specific, well-formed search queries (e.g. "Node.js latest LTS
  version 2026" rather than "node version").
- Cite sources when presenting search-derived information.
- Do not fabricate URLs — only reference sources returned by the search.
```

---

## Option 2: OpenAI Tool Array Format (For Reference Only)

If you ever need to describe the tool in the standard OpenAI schema
(e.g. for documentation, or if a future change makes it client-visible),
this is the equivalent definition:

```json
{
  "type": "function",
  "function": {
    "name": "google_web_search",
    "description": "Searches the web using Google Search and returns results with source citations. Use this when you need current or real-time information that may not be in your training data.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "The search query to find information on the web."
        }
      },
      "required": ["query"]
    }
  }
}
```

> **Note:** You do NOT need to include this in the `tools` array of your
> API request. The Gemini CLI already registers `google_web_search`
> internally. Listing it in `tools` would cause it to be routed through
> the ToolBridge MCP layer instead of the CLI's native (faster) path.

---

## How It Works Under the Hood

```
Client sends prompt → Ionosphere → Gemini CLI
                                        │
                                  Model decides to search
                                        │
                                  CLI calls WebSearchTool
                                        │
                                  Separate Gemini API call
                                  with { googleSearch: {} }
                                        │
                                  Results + citations returned
                                        │
                                  Fed back to model as context
                                        │
                                  Model writes final response
                                        │
                              Streamed to client as normal text
                                  (with citations baked in)
```

The client receives a standard assistant `content` response. No tool
call is visible in the SSE stream. The search results are synthesised
into the model's answer with inline citations like `[1]`, `[2]` and a
`Sources:` block.
