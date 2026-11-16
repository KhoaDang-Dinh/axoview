/**
 * A Strands model that plays a script instead of calling Bedrock: each turn
 * either calls one tool ({ tool, input }) or answers ({ text }). It records
 * what the agent sent it (the tool names offered, the messages, the system
 * prompt), so a test can check what the model would have seen. Test-only.
 */
import { Model } from '@strands-agents/sdk';

export class ScriptedModel extends Model {
  constructor(turns, { repeatLast = false } = {}) {
    super();
    this.turns = [...turns];
    this.repeatLast = repeatLast;
    this.calls = [];
    this.config = { modelId: 'scripted' };
  }

  updateConfig(config) { this.config = { ...this.config, ...config }; }

  getConfig() { return this.config; }

  async *stream(messages, options) {
    this.calls.push({
      tools: (options?.toolSpecs || []).map((spec) => spec.name),
      system: JSON.stringify(options?.systemPrompt ?? ''),
      messages: messages.map((message) => JSON.stringify(message))
    });
    const turn = this.turns.length > 1 || !this.repeatLast ? this.turns.shift() : this.turns[0];
    if (!turn) throw new Error('the script ran out');
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if (turn.tool) {
      yield { type: 'modelContentBlockStartEvent', start: { type: 'toolUseStart', name: turn.tool, toolUseId: `use-${this.calls.length}` } };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(turn.input ?? {}) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: turn.text } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
    yield { type: 'modelMetadataEvent', usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } };
  }
}

/** What a tool returned to the model after model call `n` (0-based). */
export function toolResultSeen(model, n) {
  const message = JSON.parse(model.calls[n + 1].messages.at(-1));
  const block = message.content[0].toolResult.content[0];
  return block.json ?? block.text;
}
