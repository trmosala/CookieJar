# Pending work integration

This branch combines `main` at `d653d4c` with all remote feature branches fetched on 14 September 2026 and the local deployment work.

| Source | Included work |
| --- | --- |
| `main` | Internal plugin installation instructions and exact saved-project-folder workspace defaults |
| `codex/reliability` | Conversation history, panel redesign, composer capture and references, render dashboard, preferences, edit/retry, skills and attachments |
| `codex/chat-checkpoint-restore` | Restore work, also carried by the feature branch history |
| `docs/ae-ui-redesign-reference` | Approved design reference |
| `codex/deployment-hardening` at `19476b0` | Persistent session retirement, uncertain delivery, request deadlines, render gates, checkpoint protection and client packaging |
| Deployment worktree follow-up | Recovery metadata publication fix and its seven regressions, signing output staging, and existing investigation notes |

`codex/ae-panel-redesign`, `codex/composer-capture`, the local `codex/project-conversations` branch, and `refactor/simplify` are ancestors of the combined branch. They do not need separate pull requests. PR #28 merged the redesign into the composer branch, not into `main`.

## Conflict decisions

- Workspace defaults use the exact saved project parent for chat, models and skills. Explicit choices and existing conversation workspaces remain authoritative.
- Retired conversations cannot execute tools. Explicit reopening validates the saved project/workspace scope and CM session before restoring access. Deletion retains a visible missing conversation and a persistent retirement marker; the user must choose another conversation or create one.
- In-flight chat operations check their captured conversation identity after asynchronous work. Reopening another conversation does not admit stale responses.
- Restore checkpoints use operation-owned protection. Expanded chat attachment limits remain separate from host command limits, while request body reception stays outside the bridge transition queue.
- Recovery metadata retries repeat only local file publication. Failed publication retains uncertainty and cannot cause a repeated AE command.

## Validation and release boundary

Local validation on 14 September 2026:

- Full Windows suite on Node 26.8.2: 429/429 passed, zero failures, 403.96 seconds. Log: `integration-final.log` in the integration worktree.
- Six focused integration regressions also passed on Node 24.19.0, including workspace selection, conversation reopening and retirement, build publication and a real Windows recovery file lock.
- All eight browser verification scripts passed: redesign, conversations, skills, retry, render, preferences, targets and skill management. These use browser fixtures rather than an installed CEP/CM pair.
- Syntax checks parsed 61 scripts. Development and client builds each verified all 16 artifact hashes and reproducibility.
- A Windows staging-directory `EPERM` also reproduced in the build regression. Bounded publication retries resolved it; persistent failures still stop the build.

GitHub reports the integration branch as mergeable. Its Windows/macOS Node 22/24 matrix did not start because of failed account payments or the account spending limit. Resolve that account setting, rerun the checks, then take PR #29 out of draft and merge it. A merge commit retains the ancestry of the integrated feature branches.

Existing native validation reports describe earlier candidates and do not certify this combined commit.

The original worktrees and their uncommitted files remain intact. Local AE projects, debug scripts, signing scratch files, credentials, builds and test logs are excluded from the integration commit.

Merging source does not approve client deployment. Qualify the exact installed panel/plugin pair and retain the existing signing and release gates in `DEPLOYMENT_READINESS.md`.
