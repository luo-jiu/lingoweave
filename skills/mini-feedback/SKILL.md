---
name: mini-feedback
description: Explain a saved LingoWeave mini writing answer, or assess frozen word-level writing evidence for background review scheduling. The task tools distinguish teaching feedback from assessment; neither mode changes learner answers or due dates directly.
---

# Mini writing feedback

## Background assessment

If the task provides `learning_get_assessment`, read its frozen source and `inputHash`. Evaluate the original submitted answer, not a better version produced during later discussion. The source's learning evidence records memory-stage regressions, spelling first answers and corrections, self-ratings and help; preserve those distinctions. Discussion marked `after_answer` may guide explanations but cannot make the original answer correct.

Assess the assigned word sense in three dimensions: meaning, spelling and use. Return `correct`, `incorrect`, `not_tested` or `uncertain` for each, with a short Chinese explanation and evidence identifiers from the supplied source. A valid synonym can leave the assigned word untested; unrelated grammar or stylistic improvements do not establish that the learner forgot the target word. Record a misspelled target even when the sentence is understandable. For English-to-Chinese answers, do not claim English spelling was tested merely because the English word was visible in the question. Unsupported semantic conclusions remain uncertain.

Judge the observable original answer separately from independence or lasting mastery. Recent study, an earlier correction, hints and `eligibility: false` affect the program's scheduling qualification; they do not make a plainly right meaning or visibly wrong spelling semantically uncertain. Do not add uncertainty merely because a supported answer does not prove long-term retention. An English-to-Chinese answer normally leaves English spelling and English production usage `not_tested`, not `uncertain`; its translation of the target meaning can still be clearly correct or incorrect.

Keep `uncertainties` empty when the target judgments are clear. Use this field only for actual missing information, contradictory question evidence or ambiguity that prevents a sound target judgment. Ordinary teaching caveats, lack of independent-recall eligibility, untested dimensions and alternative acceptable phrasings are not uncertainty entries. If a question or evidence is genuinely defective, state the concrete defect and mark the affected observations `uncertain`; do not invent confidence to obtain an adoption receipt.

Use `learning_submit_assessment` with the exact `sourceId` and `inputHash`, preserving request identity and content on uncertain retries. Give helpful strengths, improvements and one reference translation; it is not the sole acceptable wording. The program decides which evidence can affect scheduling. Do not submit a numeric grade, Good/Again, mastery, a due date, an answer edit or a completion event. Save concise reasons and references, not private reasoning. Finish after the saved receipt; background output is not a message to the learner's current translation page.

## Teaching feedback

If the task instead provides `learning_get_context` and `learning_commit`, follow this teaching mode. It does not itself submit a background scheduling assessment.

Read `learning_get_context` and its saved attempt before commenting. Preserve the original answer and task identity. If no original answer exists, stop; do not invent or submit it. Query relevant history or focus only when it changes the teaching.

Give concise Chinese feedback: what the learner expressed well, one or two useful improvements, the main reusable expression, and an accurate reference translation. Accept meaningful alternative wording. Publish `qualitative_feedback` with comment, tip, usefulPhrase, strengths, improvements, keyPoints, and referenceTranslation. The arrays can be empty where there is nothing sound to praise or add. Do not include outcome, a numeric score, correctness grade, Good/Again, mastery or a new due date.

Adapt explanations and reference wording to the saved `english_level`; if absent, keep them beginner-friendly. This preference affects teaching difficulty, not the record of what the learner actually wrote.

Prefer rehearsing the word's existing active focus. Create another only when the evidence and remaining platform budget justify it; a rare variant does not justify extra workload. Tie a new focus to the real dayId and sourceAttemptId. Feedback and correction are supported teaching, not an independent recall result.

Use `learning_commit` for the assigned attempt only. The original answer is already saved; a network failure cannot justify changing it. Reuse the same command identity and content on an uncertain retry, and read context after conflicts. End after the save receipt with a short Chinese message; the app displays the detailed saved feedback. Public text should not mention internal tools or private reasoning.
