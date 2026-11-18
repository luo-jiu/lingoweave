import { miniActionSchema, miniAiKindSchema, type MiniAction } from '@lingoweave/contracts';

export function miniAiTools(kind: ReturnType<typeof miniAiKindSchema.parse>, audioEnabled = false) {
  const names = [
    'learning_get_context',
    'learning_get_history',
    'learning_get_word',
    'learning_commit',
  ];
  return kind === 'advisor' && audioEnabled
    ? [...names, 'learning_get_audio', 'learning_generate_audio']
    : names;
}

export const miniAiActions: Record<
  ReturnType<typeof miniAiKindSchema.parse>,
  MiniAction['type'][]
> = {
  prepare: ['add_sentences', 'create_focus', 'update_focus'],
  writing: ['publish_writing', 'create_focus', 'update_focus'],
  feedback: ['qualitative_feedback', 'create_focus', 'update_focus'],
  advisor: [
    'set_long_term_plan',
    'set_today_plan',
    'clear_today_plan',
    'set_session_plan',
    'clear_session_plan',
    'create_focus',
    'update_focus',
    'remember_preference',
    'forget_preference',
  ],
};

export function miniAiActionOptions(kind: ReturnType<typeof miniAiKindSchema.parse>) {
  return miniActionSchema.options.filter((option) =>
    miniAiActions[kind].includes(option.shape.type.value),
  );
}
