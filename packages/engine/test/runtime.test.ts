import { describe, expect, it } from 'vitest';
import { BaselineExtractor, LlmExtractor, OpenAIExtractor } from '@swipeback/extraction';
import { createExtractor, resolveProvider } from '@swipeback/engine';

describe('extraction provider selection', () => {
  it.each([
    [{ SB_EXTRACTOR: 'openai' }, 'openai'],
    [{ SB_EXTRACTOR: 'anthropic' }, 'anthropic'],
    [{ SB_EXTRACTOR: 'baseline' }, 'baseline'],
    [{ SB_EXTRACTOR: 'llm', SB_LLM_PROVIDER: 'openai' }, 'openai'],
    [{ SB_EXTRACTOR: 'llm', SB_LLM_PROVIDER: 'anthropic' }, 'anthropic'],
    [{ SB_OPENAI_API_KEY: 'k' }, 'openai'],
    [{ SB_ANTHROPIC_API_KEY: 'k' }, 'anthropic'],
    [{}, 'baseline'],
  ])('%j -> %s', (env, provider) => {
    expect(resolveProvider(env as NodeJS.ProcessEnv)).toBe(provider);
  });

  it('builds the right extractor and model', () => {
    const openai = createExtractor({ SB_EXTRACTOR: 'openai', SB_OPENAI_API_KEY: 'sk-test', SB_OPENAI_MODEL: 'gpt-5.4-mini' });
    expect(openai).toBeInstanceOf(OpenAIExtractor);
    expect((openai as OpenAIExtractor).model).toBe('gpt-5.4-mini');
    expect((createExtractor({ SB_EXTRACTOR: 'openai', SB_OPENAI_API_KEY: 'sk-test' }) as OpenAIExtractor).model).toBe('gpt-5.5');
    expect(createExtractor({ SB_EXTRACTOR: 'anthropic', SB_ANTHROPIC_API_KEY: 'k' })).toBeInstanceOf(LlmExtractor);
    expect(createExtractor({})).toBeInstanceOf(BaselineExtractor);
  });

  it('a provider without its key is a configuration error, not a silent fallback', () => {
    expect(() => createExtractor({ SB_EXTRACTOR: 'openai' })).toThrow(/SB_OPENAI_API_KEY/);
    expect(() => createExtractor({ SB_EXTRACTOR: 'mystery' })).toThrow(/unknown extraction provider/);
    // Replay needs no key: it never touches the network.
    expect(createExtractor({ SB_EXTRACTOR: 'openai', SB_CASSETTES: 'replay' })).toBeInstanceOf(OpenAIExtractor);
  });
});
