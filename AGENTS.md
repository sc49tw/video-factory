# Video Factory

This repository renders production videos from approved episode assets.

## Workflow

When the user says `開始影片`, `繼續影片`, or asks for production status:

1. Run `pnpm video:workflow discover` when existing inbox episodes have not
   been registered.
2. Run `pnpm video:workflow start`, `continue`, or `status` to identify the
   exact current stage and next gate.
3. Ask only for the decision or asset required by the current gate.
4. Save checkpoints in `projects/<ID>/workflow.json`; never skip a failed or
   waiting gate.
5. For a new creative project, create a draft and give the generated Chat
   handoff prompt to the user. Resume from the same draft when its JSON package
   returns.
6. Treat `inbox/<EPISODE>/` as read-only during rendering.
7. Preserve approved text and images exactly.
8. Run `pnpm video:render <EPISODE>` only after content and image gates pass.
9. Keep production files in `projects/<EPISODE>/` and final MP4 files in
   `output/<EPISODE>/`.
10. After render, review QA and record approval with
    `pnpm video:workflow approve <EPISODE> qa`.

Never modify story, English, or images during rendering.

If required assets are missing, stop and ask for them.

The output must be a production-ready MP4.
