# Legacy external-Chat workflow archive

This directory preserves the pre-Codex workflow for history and migration
reference only. It is not called by `package.json`.

Archived components:

- `scripts/video-workflow.mjs`: combined Chat handoff and episode CLI.
- `scripts/video-workflow-v2.mjs`: temporary compatibility wrapper.
- `src/chat-handoff.mjs`: all-in-one Chat prompt and package validator.
- `drafts/DRAFT-20260726-001/`: the legacy `workflow.json` and Chat prompt.

Do not resume production from these files. Active creative drafts use
`projects/_drafts/<ID>/state.yaml`; renderer episodes continue to use
`projects/<EPISODE>/workflow.json`.
