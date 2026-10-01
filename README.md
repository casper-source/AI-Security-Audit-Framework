# AI Security Audit framework

Local audit harness for a system you are allowed to test. One profile is one engagement. The engine schedules behaviors, sends scripted turns through that target's adapter, and judges them with deterministic oracles. A later process replays candidates and promotes the ones that reproduce.

This is not a general-purpose attack tool. The engine never contains a product name, a secret, a seed sentence, or an oracle string. Those live only in a target pack under `targets/<id>/`.

## Install the audit command

From the repo root, once per machine:

```
npm install
npm link
```

`npm link` puts `audit` on your PATH. Open a new terminal if the current one does not see it yet. Every command reads `.env`, `targets/`, and `campaigns/` from the directory you are in, so run them from this repo. `TARGET` in `.env` picks the profile. Shell variables win over `.env`.

If needed, one can remove the command later with `npm unlink -g audit-framework`.

Without `npm link`, the same words work as `.\audit.cmd` on Windows and `./audit` elsewhere. The npm scripts are aliases. A flag passed through npm needs an extra `--`, as in `npm run audit -- --fresh`.

## Commands

```
audit                               Prints the list below.
audit check                         Profile and health check. Sends no turns.
audit run                           Coverage pass. Resumes the active campaign.
audit run --fresh                   Archive the active campaign and start a new folder.
audit clean                         Delete this target's campaign folders. Does not run.
audit verify [id ...]               Replay the active campaign. Optional ids limit behaviors.
audit verify --campaign <folder>    Replay that folder, including an archived one.
audit status [--campaign <folder>]  Register. Sends no turns.
audit summary [--campaign <folder>] Open summary.html.
audit logs [--campaign <folder>]    Open the turn-log folder.
```

- `audit` with no arguments prints this list.
- `audit run` resumes the active campaign and never deletes. `--fresh` keeps the old folder and starts another in active campaign.
- `audit clean` deletes `campaigns/<profile.id>/` for the current target and stops. It leaves other targets' campaigns in place.
- `audit check` prints the profile id, the model id from health, the campaign hash, and the campaign directory.
- `audit verify` replays the active campaign and writes `regression/<behaviorId>.json` for each confirmed behavior.
- `audit verify <behavior_id_1> <behavior_id_2>` replays only those behaviors, in profile order, and leaves the others untouched.
- `audit verify --campaign <folder> <behavior_id>` replays that behavior from the named folder, including an archived audit. An unknown id stops before any turn.
- `audit summary` opens whichever `summary.html` was updated most recently for this target.
- `audit status` prints each behavior's status, pulls, and wins.
- `audit logs` opens the active campaign for the live health model. If the target is down and no folder is named, `audit logs` uses the newest local campaign and says so. `--campaign <folder>` selects one folder, including an archived audit.

## Run the demo

Install once, then start the in-repo mock. It listens on `127.0.0.1:8787`.

```
npm install
npm run mock
```

In a second terminal, copy the example env and run the audit. `.env.example` already sets `TARGET=demo`.

```
copy .env.example .env
audit run
audit verify
audit summary
```

`npm test` runs `node --test test/*.test.js`. Node treats a bare `test/` argument as the directory entry, not as the files inside it, so the glob is the command that runs this suite.

## Point TARGET at another folder

`TARGET` defaults to `demo` and selects `targets/<TARGET>/profile.yaml`. A pack is that file plus `adapter.js`:

```
targets/my-target/profile.yaml
targets/my-target/adapter.js
```

```
set TARGET=my-target
audit check
audit run
```

`adapter.js` exports `health`, `send`, and `reset`. Preflight, audit, and verify load it. The campaign hash still uses the model id from `GET /health`, which is the upstream model, not `TARGET_MODEL`. The folder name is the local date and time the audit started.

## Three endpoints

Keep these distinct:

- `TARGET_URL` is the system under test. The campaign hash uses the model id that `GET /health` reports, not this name.
- `TARGET_MODEL` is the optional model name sent to that system on each chat request.
- `AUDITOR_MODEL` is the optional model that drafts a follow-up and writes a rubric rationale. It is not the target, and it never decides a hit.

A later exporter can wrap `regression/*.json` as a Promptfoo config. v1 does not emit one.

## What one run does

The engine validates the profile, health-checks the target, and hashes the profile plus the reported model id. That hash is stored in the campaign folder. The engine then walks behaviors in file order. A hit becomes a claimed finding. A miss becomes exhausted. A transport failure stays open, is journaled, and shows up in the summary as `still open`. It does not write `transport/<id>.json`.

`audit verify` is a separate process. It replays each candidate on a fresh session, one saved user turn per request. Stateful behaviors reset between repetitions: replay, reset, replay, reset, replay. Confirmation requires `reproMin` hits and no transport failure. The console verify log has one row per finished repetition, with columns index, behavior, result, hits, ms, and tokens. `hits` is the running total for that behavior. A horizontal rule separates behaviors. A transport retry stays on the same index. Every turn is still written to the behavior log. The rubric, when it runs, only stores a rationale. It does not promote or reject.

The host allowlist is `localhost` and `127.0.0.1`. A profile may only narrow that set. `::1` is rejected. The auditor URL, when `auditor.remote` is false, must use one of those two hostnames.

## Profile fields

Each field below is accepted by the loader.

- `id`: campaign directory name and regression profile id.
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

## Adapters

Every adapter returns `{ user, reply, toolCalls, oracle, sessionId }`. `oracle` is the JSON response body. The rest of the engine does not read HTTP. The demo adapter posts `{ message, session_id? }` to `/chat` and sends `session_id` after the first response. `GET /health` must return `{ ok: true, model: string }`. `reset` posts an empty body to the behavior's reset path. The MerciBank adapter speaks that lab's own paths and leaves `reset` empty.

Host check, redirect refusal, and retry live in `engine/transport.js`. An adapter passes its timeout. A 429, a 502, a timeout, or a connection failure is retried up to five times. Any other HTTP error, including a 200 with a broken envelope, stops on that attempt. Redirects are not followed.

## Campaign files

`campaigns/<profile.id>/<YYYY-MM-DD-HHMMSS>/` holds `campaign.json`, `register.json`, `journal.md`, `lessons.jsonl`, `summary.html`, and `logs/<behaviorId>.md`. The folder name is the local time the audit started. `campaign.json` stores the hash, the health model id, and `archived` after `run --fresh`. The hash is the first 12 hex characters of SHA-256 over the canonical profile JSON, a newline, and the model id from health. `reproRuns`, `reproMin`, and `maxConcurrency` are left out of that hash. The same hash reopens the active folder. Archived folders stay put until `--campaign` names one. A different model id starts a new folder. One older active folder for the same model keeps its name and stores the new hash. A folder whose name is still a 12-hex hash is renamed to a timestamp when it is opened.

`logs/<behaviorId>.md` is an append-only turn log. Each sent turn records the time, source (`opening`, `follow-up`, or `draft`), duration, token total, the question, the answer, tool calls, and the judge result. A flag whose path is missing is logged as `oracle path missing` and is still a non-hit. The file is not read back to make decisions. `verify.js` appends a replay block for each repetition: the repetition number, the new session id, hit or miss or transport, and whether the transport retry was used.

`findings/<behaviorId>.json` is `claimed`, then `verified`. `rejected/` and `transport/` replace that file. `disagreements/` is an extra copy written only when the rubric boolean disagrees with a deterministic hit. It may name a claimed finding and, after verify, the same finding once it is confirmed. It does not name a rejected or transport file. A hit also stores `matched`, `ms`, and `tokens` from the hitting turn.

`summary.html` has five sections, in order: claimed, confirmed, rejected, transport, disagreement. Each table has columns index, behavior, goal, impact, evidence, benign, turn, source, matched, ms, tokens, hits, and asr. `hits` is `<reproMin>/<reproRuns>` after verify, and `asr` is that ratio as a rounded percent. A row that has not been verified uses `-`. The index column is the original row order in that section. Click the index or impact header to sort that table; impact orders `CRITICAL`, `HIGH`, `MEDIUM`, then `LOW`, and a second click reverses it. The audit console results table has the same columns except index. Turn, source, matched, ms, and tokens come from the hitting turn. A row with no hit uses `-`. `verify.js` overwrites `summary.html`.

The regression JSON key order is `comment`, `profileId`, `hash`, `model`, `turns`, `oracle`. `turns` is an ordered array of user strings. Replay them on a fresh session and assert the oracle. Do not join them into one prompt.
