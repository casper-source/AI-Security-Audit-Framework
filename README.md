# audit-framework

Local audit harness for a system you are allowed to test. One profile is one engagement. The engine schedules behaviors, sends scripted turns through a dialect, and judges them with deterministic oracles. A later process replays candidates and promotes the ones that reproduce.

This is not a general-purpose attack tool. The engine never contains a product name, a secret, a seed sentence, or an oracle string. Those live only in a target pack under `targets/<id>/`.

## Run the demo

Install once, then start the in-repo mock. It listens on `127.0.0.1:8787`.

```
npm install
node targets/demo/mock-server.js
```

In a second terminal, copy the example env and run the audit. Shell variables win over `.env`.

```
copy .env.example .env
node engine/run.js
node engine/verify.js
```

`node engine/run.js` writes claimed findings under `campaigns/demo/<hash>/`. `node engine/verify.js` replays them and writes `regression/<behaviorId>.json` for each confirmed behavior. A second run against the same reported model skips behaviors that are already candidate, confirmed, or exhausted. Delete that hash directory to start that model over.

`npm test` runs `node --test test/*.test.js`. Node treats a bare `test/` argument as the directory entry, not as the files inside it, so the glob is the command that runs this suite.

## Point TARGET at another folder

`TARGET` defaults to `demo` and selects `targets/<TARGET>/profile.yaml`. A new pack is a folder that contains only that file:

```
targets/my-target/profile.yaml
```

```
set TARGET=my-target
node engine/run.js
```

v1 speaks `chat-session` and `chat-history`. Add `targets/<id>/adapter.js` when neither dialect matches, exporting `send`, `health`, and `reset` with the same signatures. If that file exists, `run`, `verify`, and preflight use it instead of the dialect. `targets/mercibank/` is the local lab on `http://localhost:8080`: set `TARGET=mercibank` in `.env`. The campaign hash still uses the model id from `GET /health`, which is the upstream model, not `TARGET_MODEL`.

## Three endpoints

Keep these distinct:

- `TARGET_URL` is the system under test. The campaign hash uses the model id that `GET /health` reports, not this name.
- `TARGET_MODEL` is the optional model name sent to that system on each chat request.
- `AUDITOR_MODEL` is the optional model that drafts a follow-up and writes a rubric rationale. It is not the target, and it never decides a hit.

`ASSERT`, if used, is an external way to draft behaviors and seeds that a person pastes into the profile. The engine never calls it.

A later exporter can wrap `regression/*.json` as a Promptfoo config. v1 does not emit one.

## What one run does

The engine validates the profile, health-checks the target, and hashes the profile plus the reported model id. It then walks behaviors in file order. A hit becomes a claimed finding. A miss becomes exhausted. A transport failure stays open, is journaled, and shows up in the summary as `still open`. It does not write `transport/<id>.json`.

`node engine/verify.js` is a separate process. It replays each candidate on a fresh session, one saved user turn per request. Stateful behaviors reset between repetitions: replay, reset, replay, reset, replay. Confirmation requires `reproMin` hits and no transport failure. The rubric, when it runs, only stores a rationale. It does not promote or reject.

The host allowlist is `localhost` and `127.0.0.1`. A profile may only narrow that set. `::1` is rejected. The auditor URL, when `auditor.remote` is false, must use one of those two hostnames.

## Profile fields

Each field below is accepted by the loader.

- `id`: campaign directory name and regression profile id.
- `dialect`: `chat-session` or `chat-history`.
- `session`: `server-session` with `chat-session`, or `resend-history` with `chat-history`.
- `allowHosts`: non-empty subset of `localhost` and `127.0.0.1`.
- `auditor.remote`: when false, a set auditor URL must stay on localhost or `127.0.0.1`.
- `env.targetUrl`: environment variable that holds the target origin.
- `env.targetKey`: environment variable that holds the optional target bearer token.
- `env.targetModel`: environment variable that holds the optional target model name.
- `env.auditorUrl`: environment variable that holds the optional auditor base URL.
- `env.auditorKey`: environment variable that holds the optional auditor bearer token.
- `env.auditorModel`: environment variable that holds the optional auditor model name.
- `limits.maxTurns`: maximum user messages in one episode.
- `limits.minTurns`: minimum user messages before a hit can stop the episode.
- `limits.delayMs`: pause between user turns.
- `limits.reproRuns`: verification repetitions for one candidate.
- `limits.reproMin`: hits required to confirm.
- `limits.maxConcurrency`: parallel repetitions for one read-only candidate.
- `redact`: strings masked before any auditor call.
- `oracles`: goal checks the judge can evaluate.
- `oracles[].id`: oracle id referenced by `behavior.goal`.
- `oracles[].kind`: `text` or `flag`.
- `oracles[].strings`: substrings for a text oracle; any one can hit.
- `oracles[].path`: dotted path for a flag oracle, read on the response body.
- `oracles[].equals`: value that must `Object.is` the flag path.
- `behaviors`: coverage schedule, in file order.
- `behaviors[].id`: finding file name and register key.
- `behaviors[].family`: short grouping label stored on the behavior.
- `behaviors[].title`: one-line label for a person reading the profile.
- `behaviors[].goal`: oracle id this behavior is trying to hit.
- `behaviors[].impact`: `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`.
- `behaviors[].stateful`: when true, verify resets between repetitions.
- `behaviors[].benignOf`: `null` for a benign behavior, or the id of a benign partner.
- `behaviors[].reset`: required only when `stateful` is true.
- `behaviors[].reset.method`: `POST` in v1.
- `behaviors[].reset.path`: absolute path on the target origin, such as `/reset`.
- `behaviors[].seeds`: scripted openings. The demo uses one seed object.
- `behaviors[].seeds[].opening`: first user message.
- `behaviors[].seeds[].followups`: later user messages, in order.
- `behaviors[].seeds[].hint`: short behavior description sent to the drafter. It must not contain an oracle string or a redact needle.

## Dialects

Both dialects return `{ user, reply, toolCalls, oracle, sessionId }`. `oracle` is the JSON response body. The rest of the engine does not read HTTP.

`chat-session` posts `{ message, session_id? }` to `/chat` and sends `session_id` after the first response. `chat-history` posts `{ messages: [{ role, content }] }` and ignores `session_id`. Either body includes `model` only when `TARGET_MODEL` is set. `GET /health` must return `{ ok: true, model: string }`. `reset` posts an empty body to the behavior's reset path.

A 429, a timeout, or a connection failure is retried up to five times. Any other HTTP error, including a 200 with a broken envelope, stops on that attempt. Redirects are not followed.

## Campaign files

`campaigns/<profile.id>/<hash>/` holds `register.json`, `journal.md`, `lessons.jsonl`, and `summary.md`. The hash is the first 12 hex characters of SHA-256 over the canonical profile JSON, a newline, and the model id from health. A different model id is a different directory.

`findings/<behaviorId>.json` is `claimed`, then `verified`. `rejected/` and `transport/` replace that file. `disagreements/` is an extra copy written only when the rubric boolean disagrees with a deterministic hit. It may name a claimed finding and, after verify, the same finding once it is confirmed. It does not name a rejected or transport file.

`summary.md` has five sections, in order: claimed, confirmed, rejected, transport, disagreement.

The regression JSON key order is `comment`, `profileId`, `hash`, `model`, `session`, `turns`, `oracle`. `turns` is an ordered array of user strings. Replay them with the dialect's session mode and assert the oracle. Do not join them into one prompt.
