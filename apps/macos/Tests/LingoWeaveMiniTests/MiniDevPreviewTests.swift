import Foundation

@main
struct MiniDevPreviewTests {
    private let now = Date(timeIntervalSince1970: 1_794_441_600)
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        return calendar
    }

    static func main() {
        let tests = MiniDevPreviewTests()
        tests.testEveryJumpHasAValidCohort()
        tests.testReviewJumpsPreserveRequiredEvidence()
        tests.testLearningJumpsKeepStudyAndSpellingSeparate()
        tests.testTranslationJumpsPreserveAnswersAndDirection()
        tests.testResetRecreatesTheStageAfterInteraction()
        tests.testV2PreviewRevealsWithoutInventingWindowProgress()
        print("6 development preview behavior tests passed.")
    }

    private func day(_ stage: MiniDevStage) -> MiniDailyDay {
        MiniDevPreview.makeLegacy(stage, now: now, calendar: calendar).day
    }

    private func testEveryJumpHasAValidCohort() {
        for stage in MiniDevStage.allCases {
            let preview = MiniDevPreview.makeLegacy(stage, now: now, calendar: calendar)
            precondition(preview.ledger.days.count == 2)
            precondition(preview.ledger.days[0].phase == .finished)
            precondition(preview.day.reviewWords.count == 3 && preview.day.learningWords.count == 3)
            precondition(preview.ledger.days.last == preview.day)
            precondition(preview.day.sentences.count == (stage == .learningPreparing || stage == .learningError ? 3 : 6))
        }
    }

    private func testReviewJumpsPreserveRequiredEvidence() {
        let judgment = day(.reviewJudgment)
        precondition(judgment.phase == .review && judgment.review?.currentJudgment == nil)
        let revealed = day(.reviewRevealed)
        precondition(revealed.review?.currentJudgment == .fuzzy)
        let spelling = day(.reviewSpelling)
        precondition(spelling.review?.phase == .spelling && spelling.review?.judgmentEvents.count == 3)
        let correction = day(.reviewCorrection)
        precondition(correction.review?.spellingState == .correcting)
        precondition(correction.review?.lastSpellingAttempt?.answer == "aple")
        precondition(correction.review?.lastSpellingAttempt?.revealedAnswerAt == now)
        var finished = day(.reviewFinished)
        precondition(finished.review?.phase == .finished && finished.phase == .review)
        precondition(finished.completeReview(at: now, calendar: calendar) && finished.phase == .learning)
    }

    private func testLearningJumpsKeepStudyAndSpellingSeparate() {
        let learning = day(.learning)
        precondition(learning.phase == .learning && learning.studiedWords.isEmpty)
        let spelling = day(.learningSpelling)
        precondition(spelling.nextUnstudiedWord == nil && spelling.studiedWords.count == 3)
        precondition(spelling.learning?.phase == .spelling && spelling.learning?.spellingAttempts.isEmpty == true)
        let correction = day(.learningCorrection)
        precondition(correction.learning?.spellingState == .correcting)
        precondition(correction.learning?.lastSpellingAttempt?.kind == .first)
        var finished = day(.learningFinished)
        precondition(finished.phase == .learning && finished.learning?.phase == .finished)
        precondition(finished.completeLearning(at: now, calendar: calendar) && finished.phase == .translation)
    }

    private func testTranslationJumpsPreserveAnswersAndDirection() {
        let english = day(.englishToChinese)
        precondition(english.phase == .translation && english.currentTranslation?.direction == .englishToChinese)
        precondition(english.currentAttempt == nil)
        let chinese = day(.chineseToEnglish)
        precondition(chinese.currentTranslation?.direction == .chineseToEnglish)
        precondition(chinese.translation.count == 1 && chinese.translation[0].feedback != nil)
        for stage in [MiniDevStage.translationGrading, .translationError] {
            let pending = day(stage)
            precondition(pending.currentAttempt?.answer == "她在午饭后吃了一个苹果。")
            precondition(pending.currentAttempt?.feedback == nil)
        }
        precondition(day(.translationFeedback).currentAttempt?.feedback == MiniDevPreview.sampleFeedback)
        let finished = day(.finished)
        precondition(finished.phase == .finished && finished.translation.count == 6)
        precondition(finished.translation.allSatisfy { $0.feedback != nil })
    }

    private func testV2PreviewRevealsWithoutInventingWindowProgress() {
        for stage in [MiniDevStage.learning, .learningContext, .learningMeaning] {
            let fixture = MiniDevPreview.make(stage, now: now, calendar: calendar)
            precondition(MiniTodayActivity(ledger: fixture.ledger, now: now, calendar: calendar).completedNewWords == 0)
            var preview = fixture.day
            guard let visit = preview.memoryWindow?.visit else { preconditionFailure("Missing v2 preview visit") }
            precondition(preview.flow?.version == "sliding-window-v2" && preview.memory == nil)
            precondition(MiniDevPreview.editVisit(&preview, choice: true, now: now))
            precondition(preview.memoryWindow?.visit?.id == visit.id && preview.memoryWindow?.visit?.stage == visit.stage)
            precondition(preview.memoryWindow?.visit?.showsFullCard == true)
            precondition(MiniDevPreview.editVisit(&preview, corrected: true, now: now))
            precondition(preview.memoryWindow?.visit?.willRemember == false && preview.flow?.window.events.isEmpty == true)
            precondition(MiniDevPreview.make(stage, now: now, calendar: calendar).day.memoryWindow?.visit?.initial == nil)
        }
        let correction = MiniDevPreview.make(.learningCorrection, now: now, calendar: calendar).day.learning
        precondition(correction?.spellingState == .correcting && correction?.usesWindowFlow == true)
    }

    private func testResetRecreatesTheStageAfterInteraction() {
        var preview = day(.learning)
        guard let word = preview.nextUnstudiedWord else { preconditionFailure("Missing new word") }
        precondition(preview.markStudied(word, at: now))
        precondition(day(.learning).studiedWords.isEmpty)
        var paused = day(.paused)
        precondition(paused.paused && paused.setPaused(false, at: now))
        precondition(day(.paused).paused)
    }
}
