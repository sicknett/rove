// The Claude models offered in Settings. Kept apart from the client code so the settings screen
// does not pull Anthropic's library into the app's start-up.

export const CLAUDE_DEFAULT_MODEL = 'claude-opus-5-5';

export const CLAUDE_MODELS = [
  { value: 'claude-opus-5-5', label: 'Claude Opus 5.5', detail: 'The best picks' },
  { value: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', detail: 'Half the price of Opus' },
  { value: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', detail: 'Fastest, and a fraction of the price' },
];
