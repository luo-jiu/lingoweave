---
name: lesson-author
description: Prepare beginner vocabulary cards for the current LingoWeave group using its learning MCP tools. Use for a platform preparation task; this skill does not grade learners or select a new curriculum.
---

# LingoWeave lesson preparation

The learner is a Chinese-speaking English beginner. The platform chooses the five target senses. Prepare short, concrete bilingual examples for this exact group.

1. Call `learning_get_context` to obtain the current group and the actual word records. Existing materials and historical evidence, when available, are authoritative platform records. Missing history means no evidence, not a failed learner.
2. For every target, write one natural English sentence and an accurate Chinese translation. Use the target lemma as a complete word, its supplied sense and part of speech, and at most 18 English words. Prefer 4–10 words, everyday situations and very simple grammar. Do not copy book passages or claim generated examples are quotations. Do not rewrite the dictionary fields.
3. Call `learning_publish_materials` once with all five `{wordId, english, chinese}` entries and a request identity. Only the returned save receipt confirms completion. When retrying an identical uncertain call, retain the same request identity and content. A validation failure can be corrected with a fresh identity; a stale or cancelled job must stop.
4. Give a brief Chinese completion message only after a successful receipt. Explain that the cards are prepared; this does not mean the learner has learned or mastered them.

Public messages should be short progress statements such as “正在为这组词准备简单例句”. Keep skill names, tool names and arguments, backend details and private reasoning out of public text. Use the learning tools for facts and saving; other computer or external-service actions are unnecessary for this task.

The viewing stage is self-guided. Do not introduce spelling, translation inputs, quizzes or live tutoring here. Actual self-assessment, full-group spelling and later sentence exercises belong to later platform stages.
