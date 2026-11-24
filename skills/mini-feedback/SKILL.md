---
name: mini-feedback
description: Explain a saved LingoWeave mini writing answer, or assess frozen word-level writing evidence for background review scheduling. The task tools distinguish teaching feedback from assessment; neither mode changes learner answers or due dates directly.
---

# Mini writing feedback

## Expression grade

Grade the whole submitted translation in its assigned direction. Later discussion, hints and scheduling evidence are separate from this learner-facing judgement.

- **English to Chinese tests comprehension.** Use `natural` (翻译正确) when an ordinary listener in the scene would understand the original message. Everyday family speech, implied subjects or objects, synonyms, word order and punctuation are acceptable when the meaning is clear. Use `off_meaning` (偏离原意) only when a material part of the message is lost, reversed, invented or unintelligible. Check who did what to whom, when, and whether it happened. For “Goodbye, Dad! I’ll call you tonight,” both “再见爸爸，我今晚给你打电话” and “爸，拜拜，晚上给你打电话” are correct. “爸，你今晚给我打电话” reverses the caller. For a correct answer, briefly confirm what the learner understood, leave `improvements` empty and keep their own wording in the reference. For a mismatch, identify the changed detail and give a natural correction. Skip copyediting and optional polished rewrites in this direction.
- **Chinese to English also tests expression.** Use `natural` for faithful, idiomatic English, `understandable` when the message comes through and a concrete issue merits improvement, and `off_meaning` when an essential idea is missing or changed. Accept natural alternatives to the reference.

When given `learning_get_translations`, compare each assigned original answer to its question yourself. Submit one `expressionGrade` per assigned `attemptId` with `learning_submit_expression_grades`. For English to Chinese, include a brief Chinese `meaningComment` saying what was understood or which material detail changed. For Chinese to English, omit `meaningComment`. Finish after the receipt.

## Background assessment

If the task provides `learning_get_assessment`, read its frozen source and `inputHash`. Evaluate the original submitted answer, not a better version produced during later discussion. The source's learning evidence records memory-stage regressions, spelling first answers and corrections, self-ratings and help; preserve those distinctions. Discussion marked `after_answer` may guide explanations but cannot make the original answer correct.

Assess the assigned word sense in three dimensions: meaning, spelling and use. Return `correct`, `incorrect`, `not_tested` or `uncertain` for each, with a short Chinese explanation and evidence identifiers from the supplied source. A valid synonym can leave the assigned word untested; unrelated grammar or stylistic improvements do not establish that the learner forgot the target word. Record a misspelled target even when the sentence is understandable. For English-to-Chinese answers, do not claim English spelling was tested merely because the English word was visible in the question. Unsupported semantic conclusions remain uncertain.

Judge the observable original answer separately from independence or lasting mastery. Recent study, an earlier correction, hints and `eligibility: false` affect the program's scheduling qualification; they do not make a plainly right meaning or visibly wrong spelling semantically uncertain. Do not add uncertainty merely because a supported answer does not prove long-term retention. An English-to-Chinese answer normally leaves English spelling and English production usage `not_tested`, not `uncertain`; its translation of the target meaning can still be clearly correct or incorrect.

Keep `uncertainties` empty when the target judgments are clear. Use this field only for actual missing information, contradictory question evidence or ambiguity that prevents a sound target judgment. Ordinary teaching caveats, lack of independent-recall eligibility, untested dimensions and alternative acceptable phrasings are not uncertainty entries. If a question or evidence is genuinely defective, state the concrete defect and mark the affected observations `uncertain`; do not invent confidence to obtain an adoption receipt.

Use `learning_submit_assessment` with the exact `sourceId` and `inputHash`, preserving request identity and content on uncertain retries. Include the whole-answer `expressionGrade` above. Its `summary`, `strengths`, `improvements` and `referenceTranslation` are shown later in the learner's translation review. Address the learner in plain Chinese. Identify which meaning their wording conveyed or missed. Anchor feedback in a short phrase from their actual answer. Where a change helps, show the revised phrase and explain why it works here. Distinguish a correction from an optional alternative for an already acceptable translation. Either list may be empty. Give one complete, natural reference in Chinese for English-to-Chinese and in English for Chinese-to-English. Keep the learner's wording when it already expresses the idea well.

Keep memory evidence and scheduling qualifications in the internal observations. The program decides how to schedule the next review. Do not submit a numeric grade, Good/Again, mastery, a due date, an answer edit or a completion event. Finish after the saved receipt.

## Teaching feedback

If the task instead provides `learning_get_context` and `learning_commit`, follow this teaching mode. It does not itself submit a background scheduling assessment.

Read `learning_get_context` and its saved attempt before commenting. Preserve the original answer and task identity. If no original answer exists, stop; do not invent or submit it. Query relevant history or focus only when it changes the teaching.

Give concise Chinese feedback following the direction-specific rubric. Point to a useful expression when the sentence illustrates one. For English-to-Chinese, leave the tip and improvement list empty when the meaning is correct. Publish `qualitative_feedback` with expressionGrade, comment, tip, usefulPhrase, strengths, improvements, keyPoints, and referenceTranslation. The arrays can be empty where there is nothing sound to praise or add. Do not include outcome, a numeric score, Good/Again, mastery or a new due date.

Adapt explanations and reference wording to the saved `english_level`; if absent, keep them beginner-friendly. This preference affects teaching difficulty, not the record of what the learner actually wrote.

Prefer rehearsing the word's existing active focus. Create another only when the evidence and remaining platform budget justify it; a rare variant does not justify extra workload. Tie a new focus to the real dayId and sourceAttemptId. Feedback and correction are supported teaching, not an independent recall result.

Use `learning_commit` for the assigned attempt only. The original answer is already saved; a network failure cannot justify changing it. Reuse the same command identity and content on an uncertain retry, and read context after conflicts. End after the save receipt with a short Chinese message; the app displays the detailed saved feedback. Public text should not mention internal tools or private reasoning.
