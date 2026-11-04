import { useState } from 'react';
import type { LearningMaterial, LexiconWord, PreparationJob } from '@lingoweave/contracts';
import { usePreparation } from './usePreparation';

const statusLabels: Record<PreparationJob['status'], string> = {
  queued: '等待备课',
  running: '正在准备例句',
  completed: '材料已准备好',
  failed: '这次备课未完成',
  cancelled: '备课已停止',
  interrupted: '备课已中断',
};

const partOfSpeechLabels: Record<string, string> = {
  noun: '名词',
  verb: '动词',
  adjective: '形容词',
  adverb: '副词',
  pronoun: '代词',
  preposition: '介词',
  conjunction: '连词',
  determiner: '限定词',
};

function WordCard({
  word,
  material,
  index,
}: {
  word: LexiconWord;
  material?: LearningMaterial;
  index: number;
}) {
  return (
    <article className="word-card" aria-labelledby={`word-${index}`}>
      <div className="word-card-heading">
        <span className="word-position">{String(index + 1).padStart(2, '0')}</span>
        <span className="word-pos">
          {partOfSpeechLabels[word.partOfSpeech] ?? word.partOfSpeech}
        </span>
      </div>
      <h3 id={`word-${index}`} lang="en">
        {word.lemma}
      </h3>
      <p className="phonetic">{word.phonetic ?? '音标暂缺'}</p>
      <p className="word-meaning">{word.meaningZh}</p>
      {material ? (
        <div className="word-example">
          <span className="example-label">AI 自拟例句</span>
          <p className="example-en" lang="en">
            {material.english}
          </p>
          <p className="example-zh">{material.chinese}</p>
        </div>
      ) : (
        <p className="example-placeholder">备课后，这里会出现适合起步的中英例句。</p>
      )}
      <details className="word-sources">
        <summary>词条来源</summary>
        <ul>
          {word.sources.map((source, sourceIndex) => (
            <li key={`${source.url}-${sourceIndex}`}>
              <a href={source.url} target="_blank" rel="noreferrer">
                {source.name} ↗
              </a>
              <span>
                {source.license} · {source.version}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}

export function PreparationWorkspace() {
  const state = usePreparation();
  const [selectedModel, setSelectedModel] = useState('');
  const { snapshot, runtime } = state;
  const job = snapshot?.job;
  const active = job?.status === 'queued' || job?.status === 'running';
  const ready = snapshot?.group?.stage === 'ready';
  const canPrepare = Boolean(
    runtime?.available && runtime.authenticated && !runtime.error && !state.runtimeError,
  );
  const status = job ? statusLabels[job.status] : '从第一组词开始';
  const effectiveModel = runtime?.models.some((model) => model.id === selectedModel)
    ? selectedModel
    : '';
  const connectionLabel = state.runtimeLoading
    ? '正在检查 Codex…'
    : state.runtimeError
      ? '暂时无法检查'
      : !runtime?.available
        ? 'Codex 尚未就绪'
        : runtime.authenticated
          ? 'Codex 已连接'
          : '需要登录 Codex';

  return (
    <div className="preparation-workspace">
      <section className="workspace-intro" aria-labelledby="workspace-title">
        <div>
          <div className="eyebrow">
            <span aria-hidden="true" />
            你的英语读写学习空间
          </div>
          <h1 id="workspace-title">
            先从五个词，
            <br />
            开始编织。
          </h1>
          <p>给自己一个小小的起点。让 AI 准备简单例句，慢慢把单词放进句子里。</p>
        </div>
        <div className="workspace-note">
          <span className="note-star" aria-hidden="true">
            ✳
          </span>
          <p lang="en">
            Small steps.
            <br />
            <em>Lasting words.</em>
          </p>
          <span>今天的一点点，也是进步。</span>
        </div>
      </section>

      <div className="learning-layout">
        <div className="learning-main">
          <section className="preparation-panel" aria-labelledby="preparation-title">
            <div className="panel-topline">
              <span className="section-label">YOUR FIRST WORDS</span>
              <span className="small-tag">备课体验</span>
            </div>
            <div className="preparation-heading">
              <div>
                <h2 id="preparation-title">{snapshot?.group?.title ?? '我的第一组学习材料'}</h2>
                <p className="panel-description">
                  {ready
                    ? '材料已保存。重新打开页面，也能继续查看。'
                    : '平台选好词组，AI 为每个词准备一句简单英文和中文释义。'}
                </p>
              </div>
              {snapshot && (
                <span className="group-count">
                  {snapshot.words.length}
                  <small>个词</small>
                </span>
              )}
            </div>

            <div
              className={`preparation-status ${ready ? 'is-ready' : ''}`}
              role="status"
              aria-live="polite"
            >
              <span
                className={`status-dot ${ready ? 'status-dot--connected' : job?.status === 'failed' ? 'status-dot--error' : ''}`}
                aria-hidden="true"
              />
              <span>{state.snapshotLoading ? '正在恢复学习空间…' : status}</span>
              {job && <small>第 {job.attempt} 次备课</small>}
            </div>

            {state.snapshotError && (
              <div className="inline-error" role="alert">
                <p>{state.snapshotError}</p>
                <button
                  className="text-button"
                  type="button"
                  onClick={() => void state.refreshSnapshot()}
                >
                  重新读取学习状态
                </button>
              </div>
            )}
            {job?.error && <p className="job-error">{job.error}</p>}
            {state.actionError && (
              <p className="inline-error" role="alert">
                {state.actionError}
              </p>
            )}
            {state.actionNotice && (
              <p className="action-notice" role="status">
                {state.actionNotice}
              </p>
            )}

            <div className="preparation-actions">
              {state.pendingAction ? (
                <>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={state.actionBusy}
                    onClick={() => void state.retryPending()}
                  >
                    {state.actionBusy ? '正在确认…' : '确认上次请求'}
                  </button>
                  <p>正在确认之前的操作结果，确认后再继续。</p>
                </>
              ) : active ? (
                <>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={state.actionBusy}
                    onClick={() => void state.cancel()}
                  >
                    {state.actionBusy ? '正在停止…' : '停止备课'}
                  </button>
                  <p>可以离开页面，回来后会恢复已保存的进度。</p>
                </>
              ) : ready ? (
                <p className="ready-note">✓ 本组例句已保存，可以查看下方卡片。</p>
              ) : (
                <>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={
                      !snapshot ||
                      !canPrepare ||
                      state.runtimeLoading ||
                      state.actionBusy ||
                      Boolean(state.snapshotError)
                    }
                    onClick={() => void state.prepare(effectiveModel)}
                  >
                    {state.actionBusy ? '正在提交…' : job ? '重新准备材料' : '准备学习材料'}
                    <span aria-hidden="true">↗</span>
                  </button>
                  <p>{canPrepare ? '由本机 Codex 完成备课。' : '连接 Codex 后即可准备材料。'}</p>
                </>
              )}
            </div>
          </section>

          <section className="vocabulary-section" id="words" aria-labelledby="words-title">
            <div className="section-heading">
              <div>
                <div className="section-label">WORDS TO KNOW</div>
                <h2 id="words-title">这一组，先认识它们</h2>
              </div>
              {ready && <span className="saved-label">材料已保存</span>}
            </div>
            <div className="word-grid" aria-busy={state.snapshotLoading}>
              {snapshot?.words.map((word, index) => (
                <WordCard
                  key={word.id}
                  word={word}
                  index={index}
                  material={snapshot.materials.find((material) => material.wordId === word.id)}
                />
              ))}
              {!snapshot && (
                <div className="empty-card">
                  {state.snapshotLoading ? '正在读取词条…' : '读取学习状态后，这里会显示本组词条。'}
                </div>
              )}
            </div>
          </section>
        </div>

        <aside className="learning-sidebar" aria-label="备课助手与状态">
          <section className="runtime-panel" id="connection" aria-labelledby="runtime-title">
            <div className="section-label">YOUR PREPARATION ASSISTANT</div>
            <div className="connection-heading">
              <h2 id="runtime-title">备课助手</h2>
              <span
                className={`status-dot ${canPrepare ? 'status-dot--connected' : 'status-dot--error'}`}
                aria-hidden="true"
              />
            </div>
            <p className="runtime-status" role="status">
              {connectionLabel}
            </p>
            {runtime?.version && <p className="runtime-version">{runtime.version}</p>}
            {(state.runtimeError || runtime?.error) && (
              <p className="runtime-error">{state.runtimeError ?? runtime?.error}</p>
            )}
            {runtime?.available && !runtime.authenticated && (
              <p className="runtime-help">请在本机完成 Codex 登录，再点击检查连接。</p>
            )}
            <button
              className="text-button"
              type="button"
              disabled={state.runtimeLoading}
              onClick={state.refreshRuntime}
            >
              {state.runtimeLoading ? '检查中…' : '重新检查连接'} <span aria-hidden="true">↗</span>
            </button>
            {runtime && runtime.models.length > 0 && (
              <div className="model-field">
                <label htmlFor="preparation-model">备课模型</label>
                <select
                  id="preparation-model"
                  value={effectiveModel}
                  onChange={(event) => setSelectedModel(event.target.value)}
                  disabled={active || state.actionBusy || Boolean(state.pendingAction)}
                >
                  <option value="">使用 Codex 默认模型</option>
                  {runtime.models.map((model) => (
                    <option value={model.id} key={model.id}>
                      {model.name}
                      {model.isDefault ? ' · 默认' : ''}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </section>

          <section className="assistant-panel" aria-labelledby="assistant-title">
            <div className="panel-topline">
              <div className="section-label">PREPARATION NOTES</div>
              <span
                className={`stream-label ${state.streamState === 'reconnecting' ? 'is-disconnected' : ''}`}
              >
                {state.streamState === 'connected'
                  ? '实时更新'
                  : state.streamState === 'reconnecting'
                    ? '正在重连'
                    : '连接进度中'}
              </span>
            </div>
            <h2 id="assistant-title">备课进度</h2>
            <div
              className="assistant-messages"
              role="log"
              aria-live="off"
              aria-label="Codex 备课消息"
            >
              {snapshot?.messages.length ? (
                snapshot.messages.map((message) => (
                  <article className="assistant-message" key={message.id}>
                    <span className="message-author">Codex</span>
                    <p>{message.text || '正在准备…'}</p>
                    {message.status === 'interrupted' && (
                      <span className="message-caption">这段回复已中断</span>
                    )}
                    {message.status === 'streaming' && (
                      <span className="message-caption">回复中…</span>
                    )}
                  </article>
                ))
              ) : (
                <div className="assistant-empty">
                  <span aria-hidden="true">✳</span>
                  <p>
                    {active
                      ? '正在读取词条、准备简单例句。'
                      : ready
                        ? '本组材料已保存在学习空间。'
                        : '准备开始后，这里会显示助手的备课消息。'}
                  </p>
                </div>
              )}
            </div>
            {state.streamState === 'reconnecting' && (
              <p className="stream-help">连接恢复后会接续进度，已保存的材料仍可查看。</p>
            )}
          </section>

          <section className="scope-panel" aria-labelledby="scope-title">
            <h2 id="scope-title">先备好一小组材料</h2>
            <p>目前可体验真实备课与保存。看词自评、总拼写和复习计划会在接下来的版本加入。</p>
            {snapshot && (
              <p className="lexicon-size">当前种子词库：{snapshot.lexiconSize} 个词义</p>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}
