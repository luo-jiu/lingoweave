import { useEffect, useState } from 'react';
import type { HealthResponse } from '@lingoweave/contracts';
import { getHealth } from './lib/api';

type ConnectionState =
  | { status: 'loading' }
  | { status: 'connected'; health: HealthResponse }
  | { status: 'error'; message: string };

function WeaveMark() {
  return (
    <svg viewBox="0 0 48 48" fill="none" aria-hidden="true">
      <rect width="48" height="48" rx="14" fill="currentColor" />
      <path
        d="M13 13v15a7 7 0 0 0 7 7h15M23 13v15a7 7 0 0 0 7 7M13 23h15a7 7 0 0 1 7 7v5"
        stroke="#eaf3bd"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function ConnectionCard() {
  const [connection, setConnection] = useState<ConnectionState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 8_000);

    void getHealth(controller.signal)
      .then((health) => {
        if (active && !controller.signal.aborted) {
          setConnection({ status: 'connected', health });
        }
      })
      .catch((error: unknown) => {
        if (!active || (controller.signal.aborted && !timedOut)) return;

        setConnection({
          status: 'error',
          message: timedOut
            ? '连接超时，请确认本地服务已经启动。'
            : error instanceof TypeError
              ? '暂时连接不上本地服务，请启动服务后重试。'
              : error instanceof Error
                ? error.message
                : '连接失败，请稍后重试。',
        });
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      active = false;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [attempt]);

  const refresh = () => {
    setConnection({ status: 'loading' });
    setAttempt((value) => value + 1);
  };

  return (
    <section className="connection-card" id="connection" aria-labelledby="connection-title">
      <div className="section-label">WORKSPACE STATUS</div>
      <div className="connection-heading">
        <h2 id="connection-title">空间连接</h2>
        <span className={`status-dot status-dot--${connection.status}`} aria-hidden="true" />
      </div>
      <div className="connection-feedback" role="status" aria-live="polite" aria-atomic="true">
        {connection.status === 'loading' && (
          <>
            <p className="connection-result">正在连接本地服务…</p>
            <p className="muted">确认你的学习空间已准备就绪。</p>
          </>
        )}
        {connection.status === 'connected' && (
          <>
            <p className="connection-result">前后端已连接</p>
            <p className="muted">
              服务 v{connection.health.version} ·{' '}
              <time dateTime={connection.health.timestamp}>
                {new Date(connection.health.timestamp).toLocaleTimeString('zh-CN', {
                  hour12: false,
                })}
              </time>{' '}
              检查成功
            </p>
          </>
        )}
        {connection.status === 'error' && (
          <>
            <p className="connection-result">连接暂时中断</p>
            <p className="muted">{connection.message}</p>
          </>
        )}
      </div>
      <button
        className="text-button"
        onClick={refresh}
        disabled={connection.status === 'loading'}
        type="button"
      >
        {connection.status === 'loading' ? '检查中…' : '重新检查连接'}
        <span aria-hidden="true">↗</span>
      </button>
    </section>
  );
}

const learningSteps = [
  {
    number: '01',
    title: '先遇见，再记住',
    subtitle: '看词与回忆',
    text: '用一小组单词开始。看释义、读例句、在心里回忆，按自己的节奏标记记住了。',
  },
  {
    number: '02',
    title: '让记忆有迹可循',
    subtitle: '总拼写与复习',
    text: '准备好后，再用整组拼写检验记忆。保留每一次尝试，让复习跟上真实的学习情况。',
  },
  {
    number: '03',
    title: '把单词织成表达',
    subtitle: 'AI 陪伴练习',
    text: '从简单的句子和翻译开始。AI 根据学习记录组织练习，逐步走向阅读与书写。',
  },
];

export function App() {
  return (
    <>
      <a className="skip-link" href="#main">
        跳转到主要内容
      </a>
      <div className="page-shell">
        <header className="site-header">
          <a className="brand" href="#main" aria-label="LingoWeave 语织首页">
            <span className="brand-mark">
              <WeaveMark />
            </span>
            <span className="brand-wordmark">
              LingoWeave <span>语织</span>
            </span>
          </a>
          <nav aria-label="页面导航">
            <a href="#journey">学习路径</a>
            <a href="#connection">空间状态</a>
          </nav>
        </header>

        <main id="main">
          <section className="hero" aria-labelledby="hero-title">
            <div className="hero-copy">
              <div className="eyebrow">
                <span aria-hidden="true" />
                你的英语读写学习空间
              </div>
              <h1 id="hero-title">
                从一个单词，
                <br />
                织起自己的语言。
              </h1>
              <p className="hero-description">
                从基础开始，以自己的节奏记忆、复习和表达。
                <br className="desktop-break" />
                让每天的一小步，慢慢连成能读、能写的能力。
              </p>
              <a className="primary-link" href="#journey">
                看看学习路径 <span aria-hidden="true">↓</span>
              </a>
              <p className="foundation-note">
                <span className="small-tag">基础工程</span> 学习功能正在建设中
              </p>
            </div>

            <div className="weave-panel" aria-hidden="true">
              <div className="weave-panel-top">
                <span>WORDS INTO WORLDS</span>
                <span>✳</span>
              </div>
              <div className="weave-lines">
                <svg viewBox="0 0 400 400" fill="none">
                  <path d="M75-25v215c0 70 50 120 120 120h240" />
                  <path d="M130-25v215c0 40 25 65 65 65h240" />
                  <path d="M185-25v215c0 7 3 10 10 10h240" />
                  <path d="M-25 75h215c70 0 120 50 120 120v240" />
                  <path d="M-25 130h215c40 0 65 25 65 65v240" />
                  <path d="M-25 185h215c7 0 10 3 10 10v240" />
                </svg>
              </div>
              <p className="weave-mantra">
                Small steps.
                <br />
                <em>Lasting words.</em>
              </p>
              <div className="weave-panel-bottom">
                <span>一点一点，编织成长。</span>
                <span>LINGOWEAVE</span>
              </div>
            </div>
          </section>

          <section className="journey-section" id="journey" aria-labelledby="journey-title">
            <div className="section-heading">
              <div>
                <div className="section-label">THE LEARNING JOURNEY</div>
                <h2 id="journey-title">一条循序渐进的学习路径</h2>
              </div>
              <span className="planned-badge">规划中的学习流程</span>
            </div>
            <div className="step-grid">
              {learningSteps.map((step) => (
                <article className="step-card" key={step.number}>
                  <div className="step-top">
                    <span className="step-number">{step.number}</span>
                    <span>{step.subtitle}</span>
                  </div>
                  <h3>{step.title}</h3>
                  <p>{step.text}</p>
                </article>
              ))}
            </div>
          </section>

          <div className="workspace-row">
            <section className="principles-card" aria-labelledby="principles-title">
              <div className="section-label">BUILT AROUND YOUR PACE</div>
              <h2 id="principles-title">今天学一点，也是在向前。</h2>
              <p>
                算法安排学什么、复习什么，AI
                帮你找到适合的学法。这里将保留你的尝试与进步，让学习计划适应你每天的时间。
              </p>
              <div className="principle-tags">
                <span>从基础起步</span>
                <span>按记忆复习</span>
                <span>用句子表达</span>
              </div>
            </section>
            <ConnectionCard />
          </div>
        </main>

        <footer className="site-footer">
          <span>LingoWeave · 语织</span>
          <span>让单词成为你自己的语言。</span>
        </footer>
      </div>
    </>
  );
}
