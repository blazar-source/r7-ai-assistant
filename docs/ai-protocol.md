# AI protocol

## strict-bank

POST to configured HTTPS endpoint ending in `/v1/chat/completions`; settings must define unambiguous full completion URL. Headers: Authorization Bearer session key, Content-Type application/json, X-Session-ID random UUID stable per chat and rotated for new chat. Test connection uses a newly generated temporary UUID isolated from the current chat/session and does not append to its conversation.

Request fields only: `model`, `messages`, `max_tokens`, `temperature`. Default bank model setting `qwen`. No tools, tool_choice, streaming, response_format/structured output API or native tool_calls processing. Read only `choices[].message.content`; require text. OpenRouter is a development transport, not a production dependency.

## Model targets

Explicit external development targets supplied by the user:

- Main strict-bank acceptance: `qwen/qwen3.8-27b:free`.
- Additional compatibility: `qwen/qwen3.8-max-0902`.

The bank targets the Qwen 3.8 family, most likely Qwen3.8-27B; its exact checkpoint/served identifier is not yet confirmed. Do not hardcode a checkpoint or OpenRouter hostname into agent logic. Model is a user setting. Do not silently substitute another model if a configured ID is unavailable; classify/report the failure. Both exact external IDs were found in the public [OpenRouter model catalog](https://openrouter.ai/api/v1/models); this verifies catalog presence only. Authenticated successful calls and strict-bank acceptance are not yet verified.

After bank access, run the same acceptance suite against its served checkpoint, calibrating the system prompt/JSON protocol only where evidence shows a need. No Hub changes required.

## Model text protocol

One JSON object per response:

```json
{"type":"tool","tool":"r7_replace_selection","arguments":{"text":"replacement"}}
```

```json
{"type":"final","message":"Готово"}
```

Schemas use closed properties. Parse entire object, optionally strip one complete outer JSON fence; do not extract arbitrary substrings, execute JS or accept unknown fields/tools. Enforce input size before parsing. One controlled repair request for malformed JSON; second failure terminates. Ordinary text is invalid protocol, not an executable fallback.

B is a one-shot compatibility slice: malformed JSON is a safe error and repair is deliberately not claimed. D must implement the single controlled repair and multi-step loop specified above. This scope distinction does not relax strict-bank request fields or mutation policy.

Tool results are bounded JSON sent in compatible conversation messages, not native function messages. System rules/catalog are trusted; document context and tool-derived content are explicitly untrusted data. Model instructions cannot override ASK, consent, limits or schemas.

Limits required for steps, argument bytes, result bytes, context budget, request/operation time and repair count. Values selected and regression-tested before runtime implementation. Stop cancels network and prevents future mutations; completed editor mutations are not falsely reported as rolled back.
