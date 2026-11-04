import { useCallback, useEffect, useRef, useState } from 'react';
import {
  workspaceEventSchema,
  type RuntimeStatus,
  type WorkspaceSnapshot,
} from '@lingoweave/contracts';
import {
  getRuntime,
  getWorkspace,
  LearningRequestError,
  parsePendingAction,
  sendAction,
  type PendingAction,
} from '../lib/learning-api';

const pendingKey = 'lingoweave:pending-preparation-action:v1';

function readPending(): PendingAction | null {
  try {
    const stored = sessionStorage.getItem(pendingKey);
    return stored ? parsePendingAction(JSON.parse(stored)) : null;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : '请求暂时无法完成，请稍后重试。';
}

export function usePreparation() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot | null>(null);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(true);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(true);
  const [runtimeAttempt, setRuntimeAttempt] = useState(0);
  const [streamState, setStreamState] = useState<'connecting' | 'connected' | 'reconnecting'>(
    'connecting',
  );
  const [initialCursor, setInitialCursor] = useState<number | null>(null);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [pendingAction, setPendingAction] = useState(readPending);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const snapshotGeneration = useRef(0);
  const snapshotReset = useRef(false);
  const snapshotRequest = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const applySnapshot = useCallback((next: WorkspaceSnapshot, generation: number) => {
    if (!mounted.current || generation !== snapshotGeneration.current) return;
    if (snapshotReset.current) {
      snapshotReset.current = false;
      setSnapshot(next);
      setInitialCursor(next.lastEventSeq);
      setStreamAttempt((attempt) => attempt + 1);
    } else {
      setSnapshot((current) =>
        !current || next.lastEventSeq >= current.lastEventSeq ? next : current,
      );
      setInitialCursor((current) => current ?? next.lastEventSeq);
    }
  }, []);

  const refreshSnapshot = useCallback(
    async (signal?: AbortSignal) => {
      const generation = snapshotGeneration.current;
      const request = ++snapshotRequest.current;
      try {
        const next = await getWorkspace(signal);
        if (!mounted.current || signal?.aborted || generation !== snapshotGeneration.current)
          return;
        applySnapshot(next, generation);
        if (request === snapshotRequest.current) setSnapshotError(null);
      } catch (error) {
        if (
          mounted.current &&
          !signal?.aborted &&
          generation === snapshotGeneration.current &&
          request === snapshotRequest.current
        )
          setSnapshotError(describeError(error));
      } finally {
        if (mounted.current && !signal?.aborted) setSnapshotLoading(false);
      }
    },
    [applySnapshot],
  );

  useEffect(() => {
    const controller = new AbortController();
    const generation = snapshotGeneration.current;
    void getWorkspace(controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        applySnapshot(next, generation);
        setSnapshotError(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setSnapshotError(describeError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setSnapshotLoading(false);
      });
    return () => controller.abort();
  }, [applySnapshot]);

  useEffect(() => {
    const controller = new AbortController();
    void getRuntime(controller.signal)
      .then((result) => {
        if (controller.signal.aborted) return;
        setRuntime(result);
        setRuntimeError(null);
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) setRuntimeError(describeError(error));
      })
      .finally(() => {
        if (!controller.signal.aborted) setRuntimeLoading(false);
      });
    return () => controller.abort();
  }, [runtimeAttempt]);

  useEffect(() => {
    if (initialCursor === null) return;
    const controller = new AbortController();
    const stream = new EventSource(`/api/learning/events?after=${initialCursor}`);
    let refreshTimer: number | undefined;
    let observedSequence = initialCursor;
    let refreshing = false;
    let refreshAgain = false;

    const scheduleRefresh = () => {
      refreshAgain = true;
      if (refreshTimer !== undefined || refreshing) return;
      refreshTimer = window.setTimeout(() => {
        refreshTimer = undefined;
        refreshing = true;
        refreshAgain = false;
        void refreshSnapshot(controller.signal).finally(() => {
          refreshing = false;
          if (refreshAgain && !controller.signal.aborted) scheduleRefresh();
        });
      }, 100);
    };

    stream.onopen = () => {
      setStreamState('connected');
      scheduleRefresh();
    };
    stream.onerror = () => setStreamState('reconnecting');
    const onUpdate = (event: MessageEvent<string>) => {
      try {
        const result = workspaceEventSchema.safeParse(JSON.parse(event.data));
        if (!result.success) {
          setSnapshotError('收到无法识别的进度信息，请刷新学习状态。');
          return;
        }
        if (result.data.seq <= observedSequence) return;
        observedSequence = result.data.seq;
        scheduleRefresh();
      } catch {
        setSnapshotError('进度信息暂时无法读取，请刷新学习状态。');
      }
    };
    const onReset = () => {
      snapshotGeneration.current += 1;
      snapshotReset.current = true;
      scheduleRefresh();
    };
    stream.addEventListener('update', onUpdate);
    stream.addEventListener('reset', onReset);
    return () => {
      controller.abort();
      window.clearTimeout(refreshTimer);
      stream.removeEventListener('update', onUpdate);
      stream.removeEventListener('reset', onReset);
      stream.close();
    };
  }, [initialCursor, refreshSnapshot, streamAttempt]);

  const dispatchAction = async (action: PendingAction) => {
    if (actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    setActionError(null);
    setActionNotice(null);

    try {
      sessionStorage.setItem(pendingKey, JSON.stringify(action));
      setPendingAction(action);
    } catch {
      setActionError('浏览器暂时无法保存请求信息。请允许此站点使用本地存储后重试。');
      setActionBusy(false);
      actionLock.current = false;
      return;
    }

    const clearPending = () => {
      try {
        if (readPending()?.requestId === action.requestId) sessionStorage.removeItem(pendingKey);
      } catch {
        // A saved request can safely be replayed after reload; the server owns its receipt.
      }
      if (mounted.current) setPendingAction(null);
    };

    try {
      const receipt = await sendAction(action);
      clearPending();
      if (mounted.current) {
        setActionNotice(
          action.kind === 'cancel'
            ? '已收到停止请求的处理结果。'
            : receipt.reused
              ? '已找到原来的备课记录。'
              : '已开始准备这一组学习材料。',
        );
      }
      await refreshSnapshot();
    } catch (error) {
      if (error instanceof LearningRequestError && error.definitive) clearPending();
      if (mounted.current) setActionError(describeError(error));
      await refreshSnapshot();
    } finally {
      actionLock.current = false;
      if (mounted.current) setActionBusy(false);
    }
  };

  const prepare = (model: string) => {
    if (pendingAction) return dispatchAction(pendingAction);
    return dispatchAction({
      kind: 'prepare',
      requestId: crypto.randomUUID(),
      ...(model ? { model } : {}),
    });
  };

  const cancel = () => {
    if (pendingAction) return dispatchAction(pendingAction);
    if (!snapshot?.job) return;
    return dispatchAction({
      kind: 'cancel',
      requestId: crypto.randomUUID(),
      jobId: snapshot.job.id,
    });
  };

  return {
    snapshot,
    snapshotLoading,
    snapshotError,
    runtime,
    runtimeLoading,
    runtimeError,
    streamState,
    pendingAction,
    actionBusy,
    actionError,
    actionNotice,
    refreshSnapshot,
    refreshRuntime: () => {
      setRuntimeLoading(true);
      setRuntimeAttempt((attempt) => attempt + 1);
    },
    prepare,
    cancel,
    retryPending: () => pendingAction && dispatchAction(pendingAction),
  };
}
