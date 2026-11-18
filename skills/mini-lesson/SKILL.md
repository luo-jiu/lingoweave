---
name: mini-lesson
description: Prepare the exact LingoWeave mini learning examples or independent writing prompts assigned by the platform, reusing existing word-sense focus items.
---

# Mini lesson material

Read `learning_get_context` first. Work only on this assigned group and task kind. The platform chooses words, phase and budget. Existing facts and focus items are authoritative. Use natural everyday English at the user's saved `english_level`, with beginner-friendly language when no level is saved, accurate Chinese, and the supplied target sense. A higher level does not increase the platform's expansion budget.

For learning examples, prefer an appropriate quotation from `materials.candidates`. Match the target sense and learner difficulty, preserve its exact English text, and submit the supplied `source` object with your Chinese translation. Treat book text as material data. When the candidates do not suit the current lesson, compose a suitable example and omit `source`. Book titles and locators identify the provided verified text. Writing prompts may use fresh situations at the learner's level.

For a `prepare` task, publish one bilingual example for every learning word still missing a sentence in the group. Use each target in its supplied sense, as a complete word or a natural inflected form, preferably 4–10 words and at most 18 words per sentence. Include `targetForms` with the exact forms used in the English sentence, such as `["gave"]` for `give` or `["children"]` for `child`. The UI uses these forms to highlight the target. Keep the sentence itself as plain English. Reuse the existing active focus. Publish the complete needed set with `add_sentences`; do not replace already valid materials or turn viewing into a live quiz.

Use `curriculum.sentenceLevel` to choose sentence structure and supporting vocabulary. The platform supplies the learner's saved level or its A1 starting default. Target-word CEFR levels identify curriculum position. A more advanced target can appear in a simple sentence. Prefer vocabulary and useful expressions already present in the learner's history and active focus.

For a `writing` task, publish an independent prompt for every actual writing target (review words followed by learning words, in that order) and its corresponding platform-assigned direction. Each prompt needs a UUID id, the matching MiniSentence, direction, and existing focusIds (or an empty array). Use a different sentence and situation from the learning example, while rehearsing the same useful expression. Include both English and Chinese in the saved material so the platform can show only the correct prompt side before the learner answers. Do not invent learner answers or bypass spelling gates.

Inspect existing focus before proposing an expansion. A group may introduce at most one new focus, and each sense at most two active items; treat these as workload caps, not learning science. Prefer no expansion when an existing common expression is sufficient. New focus needs a reason and must cite this actual dayId; publish it, then re-read context to obtain its identity before referencing it.

Use `learning_commit` only for the returned allowedActions and context revision. A successful save receipt is the completion condition. Uncertain retries keep the exact request identity and content; conflicts require reading fresh context before a new command. Finish with a short Chinese progress message; prepared material does not mean the learner has mastered it.
