import { useEffect, useId, useRef, useState } from 'react';
import './StudyCompanion.css';

export function StudyCompanion() {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  const inputId = useId();
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [messages.length]);

  function sendPreview() {
    const message = draft.trim();
    if (!message) return;
    setMessages((previous) => [...previous, message]);
    setDraft('');
    inputRef.current?.focus();
  }

  return (
    <section className="study-companion" aria-labelledby="study-companion-title">
      <header className="companion-heading">
        <span className="companion-emblem" aria-hidden="true">
          ✳
        </span>
        <div>
          <h2 id="study-companion-title">学习陪伴</h2>
          <p>
            <span className="companion-offline-dot" />
            尚未连接
          </p>
        </div>
        <span className="companion-label">预览</span>
      </header>

      <div className="companion-history" ref={logRef}>
        <div className="companion-intro" data-compact-hide>
          <span className="companion-kicker">A LITTLE HELP, ALWAYS.</span>
          <h3>
            有不懂的，
            <br />
            随时记下来。
          </h3>
          <p>这里将陪你理解例句、回顾难点。现在可以试用聊天输入，消息仅留在本页。</p>
          <div className="companion-suggestions" aria-label="试试这些问题">
            {['这个词怎么记更容易？', '帮我解释一下这个例句'].map((suggestion) => (
              <button
                type="button"
                key={suggestion}
                onClick={() => {
                  setDraft(suggestion);
                  inputRef.current?.focus();
                }}
              >
                {suggestion}
                <span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </div>

        <div className="companion-messages" role="log" aria-label="本页聊天预览" aria-live="polite">
          {messages.map((message, index) => (
            <div className="companion-message" key={index}>
              <p>{message}</p>
              <span>本页预览 · 未发送给 AI</span>
            </div>
          ))}
        </div>
      </div>

      <form
        className="companion-composer"
        onSubmit={(event) => {
          event.preventDefault();
          sendPreview();
        }}
      >
        <label htmlFor={inputId}>想问点什么？</label>
        <div className="companion-input-wrap">
          <textarea
            id={inputId}
            ref={inputRef}
            rows={3}
            value={draft}
            maxLength={2000}
            placeholder="把你的疑问写在这里…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                sendPreview();
              }
            }}
          />
          <div className="companion-send-row">
            <span data-compact-hide>Enter 发送 · Shift + Enter 换行</span>
            <button
              type="submit"
              disabled={!draft.trim()}
              aria-label="预览发送消息"
              title="仅添加到本页，不调用 AI"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path
                  d="M12 19V5m-6 6 6-6 6 6"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>
        <p className="companion-footnote">聊天未接入 AI · 刷新后清空</p>
      </form>
    </section>
  );
}
