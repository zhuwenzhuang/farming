# Responses empty-final guard

This optional loopback proxy is an instance-level mitigation for a model
Responses endpoint that occasionally emits `response.completed` with only a
reasoning item and no final answer or tool call. Codex otherwise treats that
event as a successful, silent turn.

The proxy forwards requests and streaming events unchanged except for such an
answerless completion. It closes that stream before forwarding the terminal
event; Codex's bounded stream retry then asks the model again. No tool call was
returned by the rejected response, so this does not replay a tool action.
If every Codex retry is answerless, the turn fails visibly. The proxy does not
repair the model endpoint or filter leaked thinking delimiters.

Run `python3 scripts/test-responses-empty-final-guard.py` before installation.
The host needs Python 3 and `requests`. Bind it to `127.0.0.1`, provide the
upstream URL *without* `/v1` in `RESPONSES_GUARD_UPSTREAM`, and set the client
provider's `base_url` to `http://127.0.0.1:<port>/v1`. The proxy forwards the
client's Authorization header; it never stores or logs credentials, prompts,
or response content. Use a process supervisor and start it before routing a
Codex Home through it. Restoring the prior `base_url` rolls back the routing.

An existing Codex app-server may retain its previous provider configuration
until that session's runtime is restarted. Verify routing with a new Codex
process and with an existing Agent after restarting its runtime.
