import { useCallback, useId, useRef } from 'react';
import { reviewRatingOptions, type DemoWord, type ReviewRating } from './study-demo';
import './StudyWordCard.css';

export interface CardPractice {
  open: boolean;
  answer: string;
  checked: boolean;
  cardHeight?: number;
}

const emptyCardPractice: CardPractice = { open: false, answer: '', checked: false };

type StudyWordCardProps = {
  word: DemoWord;
  index: number;
  practice: CardPractice | undefined;
  onPracticeChange(practice: CardPractice): void;
} & (
  | { mode: 'review'; rating: ReviewRating | undefined; onRate(rating: ReviewRating): void }
  | { mode: 'learn'; learned: boolean; onToggleLearn(): void }
);

export function StudyWordCard(props: StudyWordCardProps) {
  const { word, index, practice = emptyCardPractice, onPracticeChange } = props;
  const marked = props.mode === 'review' ? Boolean(props.rating) : props.learned;
  const practicing = marked && practice.open;
  const rating = props.mode === 'review' ? props.rating : props.learned ? 'clear' : undefined;
  const inputId = useId();
  const cardRef = useRef<HTMLElement>(null);
  const restoreFocus = useRef(false);
  const composingRef = useRef(false);
  const correct = practice.answer.trim().toLowerCase() === word.english.toLowerCase();
  const practiceTriggerRef = useCallback((button: HTMLButtonElement | null) => {
    if (button && restoreFocus.current) {
      restoreFocus.current = false;
      button.focus({ preventScroll: true });
    }
  }, []);

  function closePractice() {
    restoreFocus.current = true;
    composingRef.current = false;
    onPracticeChange(emptyCardPractice);
  }

  return (
    <article
      ref={cardRef}
      className={`study-word-card ${props.mode === 'learn' ? 'study-learning-card' : ''} ${marked ? 'is-recalled' : ''}`}
      data-rating={rating}
      data-word-id={word.id}
      style={{ minHeight: practicing ? practice.cardHeight : undefined }}
    >
      <div className="study-card-top">
        <span className="study-word-number">{String(index + 1).padStart(2, '0')}</span>
        {!practicing && (
          <div className="study-card-tools">
            {props.mode === 'learn' && (
              <span data-compact-hide>{marked ? '已自评记住' : '认识一个新词'}</span>
            )}
            {marked && (
              <button
                className="study-card-practice-toggle"
                ref={practiceTriggerRef}
                type="button"
                aria-label={`${word.meaning}：单卡默写`}
                title="单卡默写"
                onClick={() =>
                  onPracticeChange({
                    ...emptyCardPractice,
                    open: true,
                    cardHeight: cardRef.current?.getBoundingClientRect().height,
                  })
                }
              >
                <svg
                  width="16"
                  height="16"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M14 4H6a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8M8 3v4M8 11h3M8 15h2" />
                  <path d="m14 12 1-4 5-5 2 2-5 5-3 2Z" />
                </svg>
              </button>
            )}
          </div>
        )}
      </div>

      {practicing ? (
        <form
          className="study-card-practice"
          aria-label={`${word.meaning}的单卡默写`}
          onSubmit={(event) => {
            event.preventDefault();
            if (!composingRef.current) {
              onPracticeChange({ ...practice, checked: true });
            }
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || composingRef.current) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              closePractice();
            }
          }}
        >
          <label className="study-word-meaning" htmlFor={inputId}>
            {word.meaning}
          </label>
          <input
            id={inputId}
            className="study-card-practice-input"
            autoFocus
            value={practice.answer}
            onChange={(event) =>
              onPracticeChange({ ...practice, answer: event.target.value, checked: false })
            }
            onCompositionStart={() => {
              composingRef.current = true;
            }}
            onCompositionEnd={() => {
              composingRef.current = false;
            }}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            maxLength={100}
          />
          <p
            className="study-card-practice-feedback"
            data-correct={practice.checked ? correct : undefined}
            role="status"
          >
            {practice.checked &&
              (correct ? (
                '✓ 拼写一致'
              ) : (
                <>
                  正确拼写：<strong lang="en">{word.english}</strong>
                </>
              ))}
          </p>
          <div className="study-card-practice-actions">
            <button className="secondary-button" type="button" onClick={closePractice}>
              返回
            </button>
            <button className="primary-button" type="submit">
              确定
            </button>
          </div>
        </form>
      ) : props.mode === 'review' ? (
        <div className="study-recall-face" key={marked ? 'revealed' : 'hidden'}>
          <h2 lang="en">{word.english}</h2>
          {marked && (
            <>
              <p className="study-word-ipa" lang="en">
                {word.ipa} <span>{word.partOfSpeech}</span>
              </p>
              <p className="study-word-meaning">{word.meaning}</p>
            </>
          )}
        </div>
      ) : (
        <>
          <h2 lang="en">{word.english}</h2>
          <p className="study-word-ipa" lang="en">
            {word.ipa} <span>{word.partOfSpeech}</span>
          </p>
          <p className="study-word-meaning">{word.meaning}</p>
          <div className="study-example">
            <p lang="en">{word.example}</p>
            <p>{word.translation}</p>
          </div>
        </>
      )}

      {!practicing &&
        (props.mode === 'review' ? (
          <div className="study-rating-buttons" aria-label={`${word.english} 的回忆状态`}>
            {reviewRatingOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={`rating-${option.value}`}
                aria-label={`${word.english}：${option.label}`}
                aria-pressed={props.rating === option.value}
                title={props.rating === option.value ? '再次点击撤销自评' : option.hint}
                onClick={() => {
                  if (props.rating === option.value) onPracticeChange(emptyCardPractice);
                  props.onRate(option.value);
                }}
              >
                {props.rating === option.value && <span aria-hidden="true">✓ </span>}
                {option.label}
              </button>
            ))}
          </div>
        ) : (
          <button
            className="study-remember-button"
            type="button"
            aria-pressed={props.learned}
            onClick={() => {
              if (props.learned) onPracticeChange(emptyCardPractice);
              props.onToggleLearn();
            }}
          >
            {props.learned ? '✓ 记住了 · 撤销' : '我记住了'}
          </button>
        ))}
    </article>
  );
}
