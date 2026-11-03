import { PreparationWorkspace } from './features/PreparationWorkspace';

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
            <a href="#words">本组词条</a>
            <a href="#connection">备课助手</a>
          </nav>
        </header>
        <main id="main">
          <PreparationWorkspace />
        </main>
        <footer className="site-footer">
          <span>LingoWeave · 语织</span>
          <span>让单词成为你自己的语言。</span>
        </footer>
      </div>
    </>
  );
}
