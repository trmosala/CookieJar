# Product goal: chat inside After Effects

Agreed September 10, 2026. The destination is a chat panel inside After Effects, backed by CookieMonster's existing conversation and model runtime.

Opening the panel is the connection. Discover and authenticate to the local CookieMonster plugin automatically, reuse local identity, and reconnect when CookieMonster returns. Profiles and pairing codes belong in recovery settings rather than the normal workflow. Multiple AE instances require a target choice; another conversation's ownership requires explicit takeover.

The conversation belongs to the project and can work across its compositions. Show the current project and active composition in the header. Follow the active composition by default; resolve “this comp” when a message is sent and retain that target throughout the request. Named compositions and @mentions target other comps without changing the viewer. Allow pinning a composition. Resolve duplicate names explicitly.

Project changes switch project conversations and pause outstanding work. They must never redirect an in-flight edit. Read-only inspection is automatic; edits retain exact-target approval and verified checkpoints. Display responses, captured frames, progress, errors and approvals in the AE chat itself. CookieMonster remains responsible for conversations, model access and tool execution policy.

## Current implementation — 0.2.2

Completed edits show a **Before this edit** checkpoint card. Restore reviews the exact saved project state, preserves current unsaved work first, and records the outcome in the conversation. Earlier messages remain history and cannot replay edits automatically. The panel reconnects the existing conversation when reviewing a checkpoint.

Model and reasoning controls sit above the composer. The plugin reads CM's connected provider catalog and persists changes through CM's existing session model endpoint. Reopening AE restores the session selection; new messages explicitly carry that choice. Busy conversations and uncertain delivery block changes, and unavailable models or reasoning levels are rejected before dispatch. Providers that encode reasoning in separate model presets retain those names; separate reasoning options appear only when CM advertises variants.

The CEP panel now contains project chat backed by the CM plugin's authenticated SDK client. It creates and resumes CM conversations per project, displays incremental replies and captured frames, and offers inline approve-once/reject controls. A composition picker follows the active viewer by default; selecting an explicit composition pins it. The mention button inserts its name and persistent ID. Duplicate names remain distinguishable by ID. Each submitted message carries a fixed target that is validated against AE before submission.

Changing projects stops the previous conversation, clears its draft and switches history. New chat starts a fresh CM conversation. Old and replaced conversations cannot silently bind to a new project. Stop cancels both active work and a submission whose acknowledgement arrives late. Ambiguous delivery is reported without automatic resubmission.

The CM workspace/model configuration remains authoritative. The panel selects a matching or sole CM workspace; multiple unmatched workspaces require a choice once. Connection recovery, checkpoints and render services remain in a collapsed section. Capture indicators stay visible in the chat.

## First-version boundaries

Replies update through one-second snapshots of CM's messages rather than a separate model runtime. The panel shows the most recent 60 messages and a bounded set of captured images; full history stays in CM. Pin preferences retain the most recent 20 projects. Clarifying questions arrive as normal chat replies. Very large approval details require review in CM rather than approval from a truncated preview. The extension remains a development build pending native CEP/browser qualification across supported AE versions.

The AE composer now supports image and brief references: browse, drop or paste, review/remove before sending, and carry the files through CM’s normal model-capability handling. Limits are four files and 2 MiB combined; supported formats are PNG, JPEG, WebP, PDF, TXT and Markdown. Drafts clear on project changes, and attachment bytes are included in delivery deduplication.
