# AGENTS.md — instructions for AI agents working on THIS repository

## Project

Loom is an agent harness: small privileged core + plugin shell, append-only
event log as the single source of truth, client-enforced permissions.

## Commands

- `npm run build` — compile to dist/ (tsc)
- `npm test` — vitest, all 68 tests must pass
- `npx tsc --noEmit` — type check only
- `node dist/cli.js --help` — CLI smoke

## Architecture invariants (do not break)

1. **Model-visible means logged.** Everything the model sees must be derivable
   from the event log by the pure `project()` function. Never build model
   context outside the projector. This includes subagent sessions — they get
   their own append-only logs under the parent's `subagents/` dir.
2. **The projector is pure.** Same log in, byte-identical projection out.
   Compaction resets only messages derived from events <= `upToSeq`
   (each projected message tracks its source seq).
3. **Compaction is recallable.** Compacted history must always be spilled to an
   artifact with a locator the model can `recall`. Never drop information.
4. **Permissions are client-enforced.** Rules live in `src/perm/engine.ts`;
   non-interactive sessions fail closed (ask => deny). Never rely on model
   self-restraint for safety.
5. **Read-before-edit is mechanical.** `ReadState` (mtime+size) gates edit and
   overwrite. Keep the checks in the tools, not in the prompt.
6. **Keys only from env.** No API key may ever be written to a config file.
7. **Tool results are pruned before the log.** Oversized outputs spill to the
   artifact store with a locator (default 30KB). MCP tool results follow the
   same path — no exceptions.
8. **Plugins fail closed without trust.** A plugin loads only when its
   sha256 fingerprint matches the trust store; any change disables it.
   Never load plugin hooks bypassing `plugins/trust.ts`.
9. **Sandbox is OS-enforced or refuses.** When sandboxWrap is set and wrapping
   fails, bash must refuse the command (fail-closed), never run unsandboxed.
10. **Eval isolation.** `runEval` gives each task its own temp workspace and
    session, and must never write to the user's cross-session memory.

## Style

- TypeScript strict, ESM, NodeNext imports with `.js` extensions.
- Zero runtime dependencies — prefer node: built-ins. Dev deps only
  (typescript, tsx, vitest, @types/node).
- New event types go into `src/log/eventlog.ts` union + projector handling +
  a projector test proving determinism.
- When touching providers, keep both adapters behaviorally identical; tests
  use the scripted adapter, never the network.
- spawnSync does NOT throw on ENOENT — it sets `r.error`. Always check
  `r.error` before trusting a spawn result (the grep/hasRg bug, once bitten).
