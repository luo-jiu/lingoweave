import { PreparationWorkspace } from './features/PreparationWorkspace';
import { StudyWorkspace } from './features/StudyWorkspace';
import { WeaveMark } from './components/WeaveMark';
import { AppearanceSettings } from './components/AppearanceSettings';

export function App() {
  if (window.location.pathname.replace(/\/$/, '') === '/study') {
    return <StudyWorkspace />;
  }

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
          <div className="site-header-actions">
            <nav aria-label="页面导航">
              <a href="#words">本组词条</a>
              <a href="#connection">备课助手</a>
            </nav>
            <AppearanceSettings />
          </div>
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
