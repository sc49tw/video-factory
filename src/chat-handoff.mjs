export function buildChatPrompt({draftId, series, subtype, category}) {
  const shared = [
    "You are developing an approved production package for Video Factory.",
    "",
    `Draft ID: ${draftId}`,
    `Series: ${series}`,
    `Subtype: ${subtype}`,
    `Format: ${category.label}`,
    `Description: ${category.description}`,
    "",
    "Work with the user to explore and approve the concept before producing the final package.",
    "Do not claim completion until the user has approved the concept, English text, and scenes.",
    "",
    "Production rules:",
    "- Use clear English suitable for A2 learners unless the user requests otherwise.",
    "- Every sentence must be suitable for independent TTS and shadowing.",
    "- Keep character and visual descriptions consistent across scenes.",
    "- Image prompts must not request captions, subtitles, logos, or embedded text.",
    "- Do not add production notes, Markdown explanation, or rendering instructions.",
    "- The final response must contain exactly one JSON code block using the contract below.",
    "",
  ];

  const subtypeRules =
    subtype === "classic-twisted"
      ? [
          "Classic Twisted rules:",
          "- Begin from a recognizable public-domain fable or classic story.",
          "- Preserve recognizability while introducing one simple narrative twist.",
          "- Let the plot reveal the twist; do not explain the joke separately.",
        ]
      : subtype === "movie-explained-badly"
        ? [
            "Movie Explained Badly rules:",
            "- Describe the movie indirectly without quoting protected dialogue.",
            "- Each clue must be visually expressible.",
            "- Make reveal behavior explicit in the package.",
          ]
        : [
            "LLFC rules:",
            "- Define one clear learning objective.",
            "- Keep examples and lesson progression internally consistent.",
            "- Make every scene visually teachable.",
          ];

  const contract = [
    "",
    "Final JSON contract:",
    "{",
    `  \"draftId\": \"${draftId}\",`,
    `  \"series\": \"${series}\",`,
    `  \"subtype\": \"${subtype}\",`,
    "  \"title\": \"...\",",
    "  \"language\": \"en\",",
    "  \"level\": \"A2\",",
    "  \"summary\": \"...\",",
    "  \"characters\": [",
    "    {\"name\": \"...\", \"visualDescription\": \"...\"}",
    "  ],",
    "  \"scenes\": [",
    "    {",
    "      \"scene\": 1,",
    "      \"imageDescription\": \"...\",",
    "      \"imagePrompt\": \"...\",",
    "      \"sentences\": [\"...\"]",
    "    }",
    "  ]",
    "}",
  ];
  return [...shared, ...subtypeRules, ...contract].join("\n");
}

export function validateChatPackage(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Chat package must be a JSON object.");
  }
  for (const field of ["draftId", "series", "subtype", "title"]) {
    if (typeof value[field] !== "string" || !value[field].trim()) {
      throw new Error(`Chat package requires a non-empty "${field}".`);
    }
  }
  if (value.draftId !== expected.draftId) {
    throw new Error(`Chat package draftId must be "${expected.draftId}".`);
  }
  if (value.series !== expected.series || value.subtype !== expected.subtype) {
    throw new Error("Chat package series/subtype does not match the draft.");
  }
  if (!Array.isArray(value.scenes) || value.scenes.length === 0) {
    throw new Error("Chat package requires at least one scene.");
  }
  for (const [sceneIndex, scene] of value.scenes.entries()) {
    if (typeof scene.imagePrompt !== "string" || !scene.imagePrompt.trim()) {
      throw new Error(`Chat package scene ${sceneIndex + 1} requires imagePrompt.`);
    }
    if (!Array.isArray(scene.sentences) || scene.sentences.length === 0) {
      throw new Error(`Chat package scene ${sceneIndex + 1} requires sentences.`);
    }
    for (const [sentenceIndex, sentence] of scene.sentences.entries()) {
      if (typeof sentence !== "string" || !sentence.trim()) {
        throw new Error(
          `Chat package scene ${sceneIndex + 1}, sentence ${sentenceIndex + 1} is empty.`,
        );
      }
    }
  }
  return value;
}
