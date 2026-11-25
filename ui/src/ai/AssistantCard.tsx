// Settings → Accounts: connect an AI assistant (or none). A key is checked with its provider
// before it is saved, so a wrong one never looks connected.

import { useEffect, useRef, useState } from 'react';
import { Unplug } from 'lucide-react';
import { Group, SettingRow } from '../screens/settings/parts';
import { useKeys } from '../state/keys';
import { Button, Segmented, Select, TextField } from '../ui/controls';
import { toast } from '../ui/toast';
import { CLAUDE_DEFAULT_MODEL, CLAUDE_MODELS } from './claudeModels';
import { GEMINI_DEFAULT_MODEL, geminiModel } from './gemini';
import { assistantFor, assistantName } from './index';
import { OPENAI_DEFAULT_BASE_URL, OPENAI_DEFAULT_MODEL, baseUrlProblem, openAiBaseUrl } from './openai';
import { AiError, isAbort, type AiProviderId, type AiSettings } from './types';

type Choice = AiProviderId | 'off';

const CHOICES: { value: Choice; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'claude', label: 'Claude' },
  { value: 'gemini', label: 'Gemini' },
  { value: 'openai', label: 'OpenAI-compatible' },
];

const ABOUT: Record<Choice, string> = {
  off: 'Off. Nothing is sent to any AI provider, and no key is kept.',
  claude: 'Claude, with your own Anthropic API key. Requests are billed to your Anthropic API account: every ask, and every refresh of For you, is one small request.',
  gemini: 'Gemini, with a key from Google AI Studio. The Flash models are free within Google’s limits; on that free tier Google may use what is sent to improve its products.',
  openai: 'Any service that speaks OpenAI’s chat API: OpenAI, OpenRouter, Groq, or a server on this PC such as Ollama. Whoever runs it sets the price.',
};

const KEY_HINT: Record<AiProviderId, string> = {
  claude: 'Create one at platform.claude.com under API keys.',
  gemini: 'A free one comes from aistudio.google.com under Get API key.',
  openai: 'Leave it empty for a server on this PC that needs none.',
};

const DEFAULT_MODEL: Record<AiProviderId, string> = { claude: CLAUDE_DEFAULT_MODEL, gemini: GEMINI_DEFAULT_MODEL, openai: OPENAI_DEFAULT_MODEL };

/** Claude's models, plus the saved one when it is not among them (it stays selectable as it is). */
const claudeOptions = (current: string) => (CLAUDE_MODELS.some((m) => m.value === current) ? CLAUDE_MODELS : [...CLAUDE_MODELS, { value: current, label: current, detail: 'Saved earlier' }]);

/** Stops a check that is still running when its form goes away. */
function useChecks() {
  const live = useRef<AbortController | null>(null);
  useEffect(() => () => live.current?.abort(), []);
  return () => {
    live.current?.abort();
    live.current = new AbortController();
    return live.current.signal;
  };
}

export function AssistantCard() {
  const saved = useKeys((s) => s.ai);
  const setAi = useKeys((s) => s.setAi);
  const [choice, setChoice] = useState<Choice>(saved?.provider ?? 'off');
  // The key store loads a moment after the app starts: follow it until the user picks something.
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setChoice(saved?.provider ?? 'off');
  }, [saved?.provider]);

  const disconnect = () => {
    if (!saved) return;
    const was = saved;
    touched.current = true;
    setChoice('off');
    void setAi(null);
    toast.info(`${assistantName(was)} disconnected, and its key forgotten`, {
      label: 'Undo',
      run: () => {
        void useKeys.getState().setAi(was);
        setChoice(was.provider);
      },
    });
  };

  const choose = (next: Choice) => {
    touched.current = true;
    if (next === 'off' && saved) return disconnect();
    setChoice(next);
  };

  const connected = saved && choice === saved.provider ? saved : null;

  return (
    <Group
      title="AI assistant"
      note="Nothing is sent to an AI provider unless one is connected here. Once one is, Ask in Search sends the request you type, and the For you row on Home sends the names and years of titles from the open profile’s history and watchlist (once a day at most, or when you pick Refresh). They go to the provider you chose and nowhere else. The key is stored encrypted for your Windows account and serves every profile."
    >
      <SettingRow label="Assistant" hint={ABOUT[choice]} stacked>
        <Segmented label="Assistant" value={choice} onChange={choose} options={CHOICES} />
      </SettingRow>
      {connected && (
        <>
          <SettingRow
            label={`Connected to ${assistantName(connected)}`}
            hint={[connected.provider === 'openai' ? connected.baseUrl : null, connected.apiKey ? `Key ends in …${connected.apiKey.slice(-4)}` : 'No key'].filter(Boolean).join(' · ')}
          >
            <Button variant="ghost" icon={<Unplug size={16} />} onClick={disconnect}>
              Disconnect
            </Button>
          </SettingRow>
          {connected.provider === 'claude' ? (
            <SettingRow label="Model" hint="Opus gives the best picks. Sonnet and Haiku answer faster and cost less.">
              <Select label="Model" value={connected.model} options={claudeOptions(connected.model)} onChange={(model) => void setAi({ ...connected, model })} />
            </SettingRow>
          ) : (
            <ModelField key={`${connected.provider}:${connected.model}`} saved={connected} />
          )}
        </>
      )}
      {choice !== 'off' && !connected && <Connect key={choice} provider={choice} replaces={saved} />}
    </Group>
  );
}

/** The model of a connected Gemini or OpenAI-compatible assistant: free text, checked like a key before it is saved. */
function ModelField({ saved }: { saved: AiSettings }) {
  const [model, setModel] = useState(saved.model);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useChecks();
  const next = saved.provider === 'gemini' ? geminiModel(model) : model.trim();
  const changed = !!next && next !== saved.model;

  const save = async () => {
    if (busy || !changed) return;
    const settings = { ...saved, model: next };
    setBusy(true);
    setError(null);
    try {
      await assistantFor(settings).check(check());
      await useKeys.getState().setAi(settings);
      toast.success(`Now using ${next}`);
    } catch (e) {
      if (!isAbort(e)) setError(e instanceof AiError ? e.message : 'The model could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingRow label="Model" hint={saved.provider === 'gemini' ? 'A model name from Google’s list, such as gemini-3.8-flash.' : 'The model name exactly as the service lists it.'} stacked>
      <div className="inline-form">
        <TextField value={model} onChange={(v) => (setModel(v), setError(null))} placeholder={saved.model} error={error} aria-label="Model" onKeyDown={(e) => e.key === 'Enter' && void save()} />
        <Button variant="secondary" busy={busy} disabled={!changed} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </SettingRow>
  );
}

function Connect({ provider, replaces }: { provider: AiProviderId; replaces: AiSettings | null }) {
  const [key, setKey] = useState('');
  const [model, setModel] = useState(DEFAULT_MODEL[provider]);
  const [baseUrl, setBaseUrl] = useState(OPENAI_DEFAULT_BASE_URL);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = useChecks();

  const ready = !!model.trim() && (provider === 'openai' ? !!baseUrl.trim() : !!key.trim());

  const connect = async () => {
    if (busy || !ready) return;
    const apiKey = key.trim();
    const settings: AiSettings =
      provider === 'openai' ? { provider, apiKey, model: model.trim(), baseUrl: openAiBaseUrl(baseUrl) } : { provider, apiKey, model: provider === 'gemini' ? geminiModel(model) : model.trim() };
    const problem = provider === 'openai' ? baseUrlProblem(settings.baseUrl!, apiKey) : null;
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    try {
      // The provider is asked first. Saved unchecked, a wrong key would look connected and then
      // fail on every ask.
      await assistantFor(settings).check(check());
      await useKeys.getState().setAi(settings);
      setKey('');
      toast.success(`${assistantName(settings)} connected. Ask in Search, and For you is on Home.`);
    } catch (e) {
      if (!isAbort(e)) setError(e instanceof AiError ? e.message : 'The key could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const onEnter = (e: React.KeyboardEvent) => e.key === 'Enter' && void connect();
  const edit = (set: (v: string) => void) => (v: string) => (set(v), setError(null));

  return (
    <>
      {provider === 'openai' && (
        <SettingRow label="Address" hint="Where the service’s API lives. OpenAI: https://api.openai.com/v1 · OpenRouter: https://openrouter.ai/api/v1 · Groq: https://api.groq.com/openai/v1 · Ollama on this PC: http://localhost:11434/v1" stacked>
          <TextField value={baseUrl} onChange={edit(setBaseUrl)} placeholder={OPENAI_DEFAULT_BASE_URL} aria-label="Address" onKeyDown={onEnter} />
        </SettingRow>
      )}
      {provider === 'claude' ? (
        <SettingRow label="Model" hint="Opus gives the best picks. Sonnet and Haiku answer faster and cost less.">
          <Select label="Model" value={model} options={CLAUDE_MODELS} onChange={setModel} />
        </SettingRow>
      ) : (
        <SettingRow label="Model" hint={provider === 'gemini' ? 'Any Gemini model name works; the Flash models are the free ones.' : 'The model name exactly as the service lists it.'} stacked>
          <TextField value={model} onChange={edit(setModel)} placeholder={DEFAULT_MODEL[provider]} aria-label="Model" onKeyDown={onEnter} />
        </SettingRow>
      )}
      <SettingRow label="API key" hint={`${KEY_HINT[provider]}${replaces ? ` Connecting replaces ${assistantName(replaces)}.` : ''}`} stacked>
        <div className="inline-form">
          <TextField value={key} onChange={edit(setKey)} secret placeholder={provider === 'claude' ? 'sk-ant-…' : provider === 'gemini' ? 'Your Gemini API key' : 'API key'} error={error} aria-label="API key" onKeyDown={onEnter} />
          <Button variant="primary" busy={busy} disabled={!ready} onClick={() => void connect()}>
            Connect
          </Button>
        </div>
      </SettingRow>
    </>
  );
}
