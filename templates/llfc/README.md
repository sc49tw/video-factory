# LLFC default template

Every LLFC project is merged with `defaults.json` before TTS and rendering.
Values explicitly present in a project's `project.json` override these defaults.

Default production choices:

- older American male voice: `en-US-ChristopherNeural`
- speech rate: `-15%`
- pitch: `-10Hz`
- phrase subtitles, maximum two lines
- approximately 34 characters per line
- no word-by-word highlighting
- shared opening and closing cards
- subtle projector gate weave and light flicker on opening and closing only

The subtitle engine also treats sentence endings as hard boundaries and
rebalances short fragments only within the same sentence.
