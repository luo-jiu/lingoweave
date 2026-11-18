function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function withoutMinutes(value: unknown): unknown {
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'minutes'));
}

/** Accept old persisted plans and pending commands while removing their retired setting. */
export function withoutMiniPlanMinutes(value: unknown): unknown {
  if (!object(value)) return value;
  const result = { ...value };
  if (object(value.planning)) {
    const planning = { ...value.planning };
    planning.longTerm = withoutMinutes(planning.longTerm);
    planning.nextSessionOverride = withoutMinutes(planning.nextSessionOverride);
    if (Array.isArray(planning.dailyOverrides))
      planning.dailyOverrides = planning.dailyOverrides.map(withoutMinutes);
    if (Array.isArray(planning.sessions)) planning.sessions = planning.sessions.map(withoutMinutes);
    result.planning = planning;
  }
  if (object(value.action)) {
    if (value.action.type === 'set_long_term_plan')
      result.action = { ...value.action, plan: withoutMinutes(value.action.plan) };
    else if (value.action.type === 'set_today_plan' || value.action.type === 'set_session_plan')
      result.action = withoutMinutes(value.action);
  }
  if (object(value.command)) result.command = withoutMiniPlanMinutes(value.command);
  return result;
}

export function legacyTimedPauseIds(value: unknown): Set<string> {
  if (!object(value) || !object(value.planning) || !Array.isArray(value.planning.sessions))
    return new Set();
  return new Set(
    value.planning.sessions.flatMap((session: unknown) => {
      if (
        !object(session) ||
        typeof session.id !== 'string' ||
        session.pauseReason !== 'budget' ||
        typeof session.minutes !== 'number' ||
        typeof session.startedAt !== 'number' ||
        typeof session.endedAt !== 'number' ||
        session.endedAt - session.startedAt < session.minutes * 60
      )
        return [];
      return [session.id];
    }),
  );
}
