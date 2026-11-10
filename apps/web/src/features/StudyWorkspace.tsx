import { useEffect, useReducer, useRef, useState } from 'react';
import { WeaveMark } from '../components/WeaveMark';
import { AppearanceSettings } from '../components/AppearanceSettings';
import { StudyCompanion } from './StudyCompanion';
import { StudyWordCard, type CardPractice } from './StudyWordCard';
import {
  canStartNextRound,
  canStartSpelling,
  canSubmitRound,
  createReviewState,
  demoLearningWords,
  getSessionStages,
  reviewRatingOptions,
  reviewReducer,
  type DemoWord,
} from './study-demo';
import './StudyWorkspace.css';

type Stage = 'review' | 'learn' | 'practice' | 'summary';

function Arrow() {
  return <span aria-hidden="true">↗</span>;
}

function WordNumber({ index }: { index: number }) {
  return <span className="study-word-number">{String(index + 1).padStart(2, '0')}</span>;
}

export function StudyWorkspace() {
  const hasReview = new URLSearchParams(window.location.search).get('review') !== 'none';
  const [review, dispatch] = useReducer(reviewReducer, undefined, () => createReviewState());
  const [stage, setStage] = useState<Stage>(hasReview ? 'review' : 'learn');
  const [visitedStages, setVisitedStages] = useState<Stage[]>([hasReview ? 'review' : 'learn']);
  const [mobilePanel, setMobilePanel] = useState<'learning' | 'chat'>('learning');
  const [seenWords, setSeenWords] = useState<string[]>([]);
  const [cardPractice, setCardPractice] = useState<Record<string, CardPractice | undefined>>({});
  const [translation, setTranslation] = useState('');
  const [showExample, setShowExample] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const stages = getSessionStages(hasReview);
  const activeWords = review.activeIds.flatMap((id) => {
    const word = review.words.find((item) => item.id === id);
    return word ? [word] : [];
  });
  const lastRound = review.rounds.at(-1);
  const ratingCount = Object.keys(review.ratings).length;
  const answeredCount = activeWords.filter(
    (word) => review.inputs[word.id]?.trim() || review.unknownIds.includes(word.id),
  ).length;
  const reviewTitles = {
    recall: '这些单词，还记得吗？',
    spelling: '试着把它们写下来。',
    correction: '再给这些单词一点时间。',
    complete: '这一轮复习，告一段落。',
  };
  const title =
    stage === 'review'
      ? reviewTitles[review.phase]
      : stage === 'learn'
        ? '从五个新词，慢慢开始。'
        : stage === 'practice'
          ? '把单词放进一句话里。'
          : '每一次回忆，都有迹可循。';

  useEffect(() => {
    const target = document.documentElement.dataset.compact === 'true' ? mainRef : titleRef;
    target.current?.focus({ preventScroll: true });
  }, [stage, review.phase]);

  function learnWord(word: DemoWord) {
    setSeenWords((current) =>
      current.includes(word.id) ? current.filter((id) => id !== word.id) : [...current, word.id],
    );
  }

  function goToStage(next: Stage) {
    setVisitedStages((current) => (current.includes(next) ? current : [...current, next]));
    setStage(next);
  }

  return (
    <div className="study-shell">
      <a className="skip-link" href="#study-main">
        跳转到学习内容
      </a>
      <header className="study-header">
        <a className="study-brand" href="/" aria-label="LingoWeave 首页，离开后演示进度清空">
          <span className="study-brand-symbol" aria-hidden="true">
            <WeaveMark />
          </span>
          <span>
            LingoWeave <small>语织</small>
          </span>
        </a>
        <nav className="study-stages" aria-label="学习阶段">
          <ol>
            {stages.map((item, index) => (
              <li
                key={item.id}
                className={
                  item.id === stage
                    ? 'is-current'
                    : item.id === 'review' && review.phase === 'complete'
                      ? 'is-done'
                      : visitedStages.includes(item.id)
                        ? 'is-visited'
                        : ''
                }
                aria-current={item.id === stage ? 'step' : undefined}
                aria-label={`${item.label}${item.id === stage ? '，当前阶段' : item.id === 'review' && review.phase === 'complete' ? '，本轮练习结束' : visitedStages.includes(item.id) ? '，已浏览预览' : '，未开始'}`}
              >
                <span className="study-stage-dot" aria-hidden="true">
                  {item.id !== stage && item.id === 'review' && review.phase === 'complete'
                    ? '✓'
                    : index + 1}
                </span>
                <span>{item.label}</span>
              </li>
            ))}
          </ol>
        </nav>
        <div className="study-header-links">
          <AppearanceSettings />
          <span className="study-demo-badge">
            <span />
            交互原型
          </span>
          <a href={hasReview ? '/study?review=none' : '/study'}>
            {hasReview ? '试试无复习流程' : '试试有复习流程'}
          </a>
          <a href="/" className="study-home-link">
            返回首页 <Arrow />
          </a>
        </div>
      </header>

      <div className="study-mobile-tabs" role="group" aria-label="工作区面板">
        <button
          type="button"
          aria-pressed={mobilePanel === 'learning'}
          aria-controls="study-main"
          onClick={() => setMobilePanel('learning')}
        >
          学习
        </button>
        <button
          type="button"
          aria-pressed={mobilePanel === 'chat'}
          aria-controls="study-chat"
          onClick={() => setMobilePanel('chat')}
        >
          陪伴聊天
        </button>
      </div>

      <div className="study-layout" data-panel={mobilePanel}>
        <main
          id="study-main"
          className="study-main"
          ref={mainRef}
          tabIndex={-1}
          aria-label="学习工作区"
        >
          <div className="study-intro" data-compact-hide>
            <h1 ref={titleRef} tabIndex={-1}>
              {title}
            </h1>
            <p>
              {stage === 'review' &&
                review.phase === 'recall' &&
                '先看英文，在心里回忆意思。诚实地选一个状态，再翻开看看。'}
              {stage === 'review' &&
                review.phase === 'spelling' &&
                '根据中文与音标完成整批拼写。全部提交后，再一起看结果。'}
              {stage === 'review' &&
                review.phase === 'correction' &&
                '正确的词已经收好了。看看错在哪里，记住后再试一次。'}
              {stage === 'review' &&
                review.phase === 'complete' &&
                '今天的回忆和每轮答案都留在这份演示记录里，不代表已经长期掌握。'}
              {stage === 'learn' &&
                '这是新词浏览预览。先认识意思和例句，准备好了就标记「记住了」。'}
              {stage === 'practice' && '试着读懂这个简单的句子，用中文写下你的理解。'}
              {stage === 'summary' &&
                '这里只汇总你在当前页面的操作；真实学习记录和复习安排还未接入。'}
            </p>
          </div>

          <div className="study-content" aria-busy={false}>
            {review.paused ? (
              <section className="study-empty-state" aria-label="已暂停">
                <span className="study-rest-symbol" aria-hidden="true">
                  Ⅱ
                </span>
                <p className="study-card-kicker">TAKE YOUR TIME</p>
                <h2>先歇一会儿，也没关系。</h2>
                <p>当前进度仍在本页。准备好了，就从这里继续。</p>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => dispatch({ type: 'resume' })}
                >
                  继续练习 <Arrow />
                </button>
              </section>
            ) : (
              <>
                {stage === 'review' && review.phase === 'recall' && (
                  <>
                    <div className="study-card-grid">
                      {review.words.map((word, index) => (
                        <StudyWordCard
                          key={word.id}
                          word={word}
                          index={index}
                          mode="review"
                          rating={review.ratings[word.id]}
                          onRate={(rating) => dispatch({ type: 'rate', wordId: word.id, rating })}
                          practice={cardPractice[word.id]}
                          onPracticeChange={(practice) =>
                            setCardPractice((current) => ({ ...current, [word.id]: practice }))
                          }
                        />
                      ))}
                    </div>
                  </>
                )}

                {stage === 'review' &&
                  (review.phase === 'spelling' || review.phase === 'correction') && (
                    <>
                      <div className="study-content-toolbar">
                        <span>
                          第{' '}
                          <strong>
                            {review.phase === 'spelling'
                              ? review.rounds.length + 1
                              : review.rounds.length}
                          </strong>{' '}
                          轮 · {review.phase === 'spelling' ? '整批拼写' : '错词巩固'}
                        </span>
                        <span>
                          {activeWords.length} 个{review.phase === 'spelling' ? '待拼写' : '待巩固'}
                        </span>
                      </div>
                      {review.passedIds.length > 0 && (
                        <details className="study-passed">
                          <summary>
                            <span aria-hidden="true">✓</span> 已通过 {review.passedIds.length} 个{' '}
                            <span>查看单词</span>
                          </summary>
                          <p>
                            {review.words
                              .filter((word) => review.passedIds.includes(word.id))
                              .map((word) => word.english)
                              .join(' · ')}
                          </p>
                        </details>
                      )}
                      <form
                        id="study-spelling-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          dispatch({ type: 'submit' });
                        }}
                      >
                        <div className="study-card-grid study-spelling-grid">
                          {activeWords.map((word, index) => {
                            const unknown = review.unknownIds.includes(word.id);
                            const attempt = lastRound?.attempts.find(
                              (item) => item.wordId === word.id,
                            );
                            const acknowledged = review.acknowledgedIds.includes(word.id);
                            return (
                              <article
                                key={word.id}
                                className={`study-word-card study-spelling-card ${review.phase === 'correction' ? 'is-correction' : ''} ${acknowledged ? 'is-acknowledged' : ''}`}
                              >
                                <div className="study-card-top">
                                  <WordNumber index={index} />
                                  <span>
                                    {review.phase === 'correction'
                                      ? acknowledged
                                        ? '已回看'
                                        : '再记一次'
                                      : '根据意思拼写'}
                                  </span>
                                </div>
                                <label
                                  className="study-spelling-meaning"
                                  htmlFor={`spelling-${word.id}`}
                                >
                                  {word.meaning}
                                </label>
                                <p className="study-word-ipa" lang="en">
                                  {word.ipa} <span>{word.partOfSpeech}</span>
                                </p>
                                {review.phase === 'spelling' ? (
                                  <>
                                    <input
                                      id={`spelling-${word.id}`}
                                      aria-label={`${word.meaning}的英文拼写`}
                                      value={review.inputs[word.id] ?? ''}
                                      onChange={(event) =>
                                        dispatch({
                                          type: 'input',
                                          wordId: word.id,
                                          value: event.target.value,
                                        })
                                      }
                                      disabled={unknown}
                                      placeholder={unknown ? '已选择不会' : '写下英文单词'}
                                      autoComplete="off"
                                      autoCorrect="off"
                                      spellCheck={false}
                                      autoCapitalize="none"
                                    />
                                    <button
                                      type="button"
                                      className="study-unknown-button"
                                      aria-pressed={unknown}
                                      onClick={() =>
                                        dispatch({
                                          type: 'unknown',
                                          wordId: word.id,
                                          value: !unknown,
                                        })
                                      }
                                    >
                                      {unknown ? '↶ 我想再试试' : '这次不会'}
                                    </button>
                                  </>
                                ) : (
                                  <>
                                    <div className="study-correction-answer">
                                      <span>你的回答</span>
                                      <p>
                                        {attempt?.unknown
                                          ? '选择了「不会」'
                                          : attempt?.answer || '未作答'}
                                      </p>
                                    </div>
                                    <div className="study-correct-answer">
                                      <span>正确拼写</span>
                                      <strong lang="en">{word.english}</strong>
                                    </div>
                                    <button
                                      type="button"
                                      className="study-remember-button"
                                      disabled={acknowledged}
                                      onClick={() =>
                                        dispatch({ type: 'acknowledge', wordId: word.id })
                                      }
                                    >
                                      {acknowledged ? '✓ 已确认记忆' : '记住了'}
                                    </button>
                                    <button
                                      type="button"
                                      className="study-defer-button"
                                      onClick={() => dispatch({ type: 'defer', wordId: word.id })}
                                    >
                                      这个词留到下次
                                    </button>
                                  </>
                                )}
                              </article>
                            );
                          })}
                        </div>
                      </form>
                      {review.deferredIds.length > 0 && (
                        <p className="study-inline-note">
                          已暂缓 {review.deferredIds.length} 个词，未计为通过。
                        </p>
                      )}
                    </>
                  )}

                {stage === 'review' && review.phase === 'complete' && (
                  <section className="study-review-finish">
                    <span className="study-finish-symbol" aria-hidden="true">
                      ✓
                    </span>
                    <h2>认真回忆过，就有收获。</h2>
                    <p data-compact-hide>可以接着看看新词，也可以到这里结束。</p>
                    <div className="study-stat-row">
                      <div>
                        <strong>{review.passedIds.length}</strong>
                        <span>本轮拼写通过</span>
                      </div>
                      <div>
                        <strong>{review.rounds.length}</strong>
                        <span>拼写轮次</span>
                      </div>
                      <div>
                        <strong>{review.deferredIds.length}</strong>
                        <span>留待下次</span>
                      </div>
                    </div>
                    <p className="study-inline-note">
                      刚刚看过答案的正确拼写，只代表这次练习完成。
                    </p>
                  </section>
                )}

                {stage === 'learn' && (
                  <>
                    <div className="study-preview-note">
                      <span>流程预览</span> 本次先体验看词与自评；整组总拼写将在下一步接入。
                    </div>
                    <div className="study-card-grid study-learning-grid">
                      {demoLearningWords.map((word, index) => (
                        <StudyWordCard
                          key={word.id}
                          word={word}
                          index={index}
                          mode="learn"
                          learned={seenWords.includes(word.id)}
                          onToggleLearn={() => learnWord(word)}
                          practice={cardPractice[word.id]}
                          onPracticeChange={(practice) =>
                            setCardPractice((current) => ({ ...current, [word.id]: practice }))
                          }
                        />
                      ))}
                    </div>
                  </>
                )}

                {stage === 'practice' && (
                  <>
                    <div className="study-preview-note">
                      <span>流程预览</span> 可以写下翻译草稿；AI 讲解与评价尚未连接。
                    </div>
                    <article className="study-sentence-card">
                      <div className="study-card-top">
                        <span>英 → 中 · 简单句</span>
                        <span>预设例句</span>
                      </div>
                      <p className="study-sentence" lang="en">
                        My friend has a small house.
                      </p>
                      <p className="study-sentence-hint" data-compact-hide>
                        不必逐字翻译，先表达出你理解的意思。
                      </p>
                      <label htmlFor="study-translation">你的中文翻译</label>
                      <textarea
                        id="study-translation"
                        value={translation}
                        onChange={(event) => setTranslation(event.target.value)}
                        placeholder="试着写一句中文……"
                        rows={4}
                      />
                      <div className="study-sentence-actions">
                        <button
                          type="button"
                          className="secondary-button"
                          onClick={() => setShowExample((shown) => !shown)}
                        >
                          {showExample ? '收起参考译文' : '看看参考译文'}
                        </button>
                        <span>草稿只留在当前页面</span>
                      </div>
                      {showExample && (
                        <p className="study-reference">
                          我的朋友有一栋小房子。<span>这是预设参考译文，不是对你答案的评分。</span>
                        </p>
                      )}
                    </article>
                  </>
                )}

                {stage === 'summary' && (
                  <>
                    <div className="study-preview-note">
                      <span>演示小结</span> 由本页操作直接汇总，尚未由 AI 分析。
                    </div>
                    <div className="study-stat-row study-summary-stats">
                      <div>
                        <strong>{hasReview ? review.passedIds.length : 0}</strong>
                        <span>复习拼写通过</span>
                      </div>
                      <div>
                        <strong>{hasReview ? review.rounds.length : 0}</strong>
                        <span>复习拼写轮次</span>
                      </div>
                      <div>
                        <strong>{seenWords.length}</strong>
                        <span>新词自评记住</span>
                      </div>
                    </div>
                    {hasReview && (
                      <div className="study-history">
                        <h2>保留每一次尝试</h2>
                        <div className="study-table-scroll">
                          <table>
                            <thead>
                              <tr>
                                <th>单词</th>
                                <th>词义自评</th>
                                <th>首次拼写</th>
                                <th>各轮原答</th>
                                <th>本次状态</th>
                              </tr>
                            </thead>
                            <tbody>
                              {review.words.map((word) => {
                                const attempts = review.rounds.flatMap((round) =>
                                  round.attempts
                                    .filter((item) => item.wordId === word.id)
                                    .map((item) => ({ ...item, number: round.number })),
                                );
                                const first = attempts[0];
                                return (
                                  <tr key={word.id}>
                                    <td lang="en">{word.english}</td>
                                    <td>
                                      {reviewRatingOptions.find(
                                        (rating) => rating.value === review.ratings[word.id],
                                      )?.label ?? '未自评'}
                                    </td>
                                    <td>
                                      {first
                                        ? first.unknown
                                          ? '不会'
                                          : first.correct
                                            ? '正确'
                                            : '错误'
                                        : '未作答'}
                                    </td>
                                    <td>
                                      {attempts.length
                                        ? attempts
                                            .map(
                                              (attempt) =>
                                                `第 ${attempt.number} 轮：${attempt.unknown ? '不会' : attempt.answer} ${attempt.correct ? '✓' : '×'}`,
                                            )
                                            .join(' / ')
                                        : '—'}
                                    </td>
                                    <td>
                                      {review.passedIds.includes(word.id)
                                        ? '本次通过'
                                        : review.deferredIds.includes(word.id)
                                          ? '暂缓'
                                          : '未完成'}
                                    </td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                    <div className="study-summary-note">
                      <h3>下一步，让陪伴真正发生。</h3>
                      <p>
                        新词总拼写、真实复习安排和 AI
                        陪伴将在后续接入。当前自评与翻译草稿均不计为正式学习通过。
                      </p>
                      {translation.trim() && <blockquote>翻译草稿：{translation}</blockquote>}
                    </div>
                    <details className="study-sources">
                      <summary>演示词条与例句说明</summary>
                      <p>
                        音标与义项参考 Wiktionary，中文释义经整理。遵循{' '}
                        <a
                          href="https://creativecommons.org/licenses/by-sa/4.0/"
                          target="_blank"
                          rel="noreferrer"
                        >
                          CC BY-SA 4.0
                        </a>
                        ；例句为手写演示，并非实时 AI 生成。
                      </p>
                      <p>
                        {[...(hasReview ? review.words : []), ...demoLearningWords].map((word) => (
                          <a key={word.id} href={word.source.url} target="_blank" rel="noreferrer">
                            {word.english} ↗
                          </a>
                        ))}
                      </p>
                    </details>
                  </>
                )}
              </>
            )}
          </div>

          <footer className="study-actions">
            <div className="study-action-status" aria-live="polite">
              {review.paused
                ? '练习已暂停'
                : stage === 'review' && review.phase === 'recall'
                  ? `${ratingCount} / ${review.words.length} 个已自评`
                  : stage === 'review' && review.phase === 'spelling'
                    ? `${answeredCount} / ${activeWords.length} 个已填写或选择不会`
                    : stage === 'review' && review.phase === 'correction'
                      ? `${review.acknowledgedIds.length} / ${activeWords.length} 个已确认记忆`
                      : stage === 'review'
                        ? '复习练习已结束'
                        : stage === 'learn'
                          ? `${seenWords.length} / ${demoLearningWords.length} 个已自评记住`
                          : stage === 'practice'
                            ? '体验输入，不做成绩判定'
                            : '本次演示记录仅保留在本页'}
              <small>演示数据 · 刷新、切换流程或离页后清空</small>
            </div>
            <div className="study-action-buttons">
              {!review.paused && stage !== 'summary' && (
                <button
                  type="button"
                  className="study-pause-button"
                  onClick={() => dispatch({ type: 'pause' })}
                >
                  暂歇一下
                </button>
              )}
              {!review.paused && stage === 'review' && review.phase === 'recall' && (
                <button
                  className="primary-button"
                  type="button"
                  disabled={!canStartSpelling(review)}
                  onClick={() => dispatch({ type: 'start-spelling' })}
                >
                  开始整批拼写 <Arrow />
                </button>
              )}
              {!review.paused && stage === 'review' && review.phase === 'spelling' && (
                <button
                  className="primary-button"
                  type="submit"
                  form="study-spelling-form"
                  disabled={!canSubmitRound(review)}
                >
                  提交本轮拼写 <Arrow />
                </button>
              )}
              {!review.paused && stage === 'review' && review.phase === 'correction' && (
                <button
                  className="primary-button"
                  type="button"
                  disabled={!canStartNextRound(review)}
                  onClick={() => dispatch({ type: 'next-round' })}
                >
                  打乱，开始下一轮 <Arrow />
                </button>
              )}
              {!review.paused && stage === 'review' && review.phase === 'complete' && (
                <>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => goToStage('summary')}
                  >
                    查看小结
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    onClick={() => goToStage('learn')}
                  >
                    继续预览新词 <Arrow />
                  </button>
                </>
              )}
              {!review.paused && stage === 'learn' && (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => goToStage('practice')}
                >
                  预览句子练习 <Arrow />
                </button>
              )}
              {!review.paused && stage === 'practice' && (
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => goToStage('summary')}
                >
                  查看演示小结 <Arrow />
                </button>
              )}
              {!review.paused && stage === 'summary' && (
                <a className="primary-button" href="/">
                  返回首页 <Arrow />
                </a>
              )}
            </div>
          </footer>
        </main>
        <aside id="study-chat" className="study-chat" aria-label="陪伴聊天">
          <StudyCompanion />
        </aside>
      </div>
    </div>
  );
}
