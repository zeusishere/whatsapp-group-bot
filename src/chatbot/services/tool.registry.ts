import { Injectable } from '@nestjs/common';
import { MessagesRepository } from '../../messages/messages.repository.js';
import { CodedError } from '../models/errors.js';
import { Json } from '../models/types.js';

/** Facts about the current turn that tools may need. */
export interface ToolContext {
  device_session_id: string | null;
  group_id: string | null;
  now: number;
}

export interface ToolDefinition {
  name: string;
  /** Shown to the router model so it knows when to pick the tool. */
  description: string;
  /** Human-readable argument summary for the router prompt. */
  parameters: string;
  /** Validates and normalizes model-supplied arguments. Throws `CodedError('TOOL_BAD_ARGS')`. */
  validate(args: unknown): Record<string, Json>;
  run(args: Record<string, Json>, ctx: ToolContext): Promise<Json> | Json;
}

const badArgs = (message: string) => new CodedError('TOOL_BAD_ARGS', message);

/**
 * The tools the router may select. Arguments come from a language model, so they are always
 * validated before use; a tool never receives raw model output.
 */
@Injectable()
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  constructor(private readonly messages: MessagesRepository) {
    this.register(this.lookupQuotedMessage());
    this.register(currentDatetime());
  }

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()];
  }

  private lookupQuotedMessage(): ToolDefinition {
    return {
      name: 'lookup_quoted_message',
      description: 'Fetch the text of a specific earlier message of this group (e.g. the message the user replied to).',
      parameters: '{"message_id": string}',
      validate: (args): Record<string, Json> => {
        const id = (args as { message_id?: unknown } | null)?.message_id;
        if (typeof id !== 'string' || !id.trim() || id.length > 200) throw badArgs('message_id must be a non-empty string');
        return { message_id: id.trim() };
      },
      run: (args, ctx): Json => {
        if (!ctx.device_session_id || !ctx.group_id) return { found: false, reason: 'thread is not bound to a group' };
        const [m] = this.messages.getByIds(ctx.device_session_id, ctx.group_id, [String(args.message_id)]);
        if (!m) return { found: false, reason: 'message not found (it may have been trimmed)' };
        return { found: true, sender_name: m.senderName, text: m.text, timestamp: m.timestamp };
      },
    };
  }
}

function currentDatetime(): ToolDefinition {
  return {
    name: 'current_datetime',
    description: 'The current date and time, optionally in a given IANA time zone.',
    parameters: '{"timezone"?: string, e.g. "Asia/Kolkata"}',
    validate: (args): Record<string, Json> => {
      const tz = (args as { timezone?: unknown } | null)?.timezone;
      if (tz === undefined || tz === null) return {};
      if (typeof tz !== 'string') throw badArgs('timezone must be a string');
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz });
      } catch {
        throw badArgs(`Unknown time zone: ${tz.slice(0, 60)}`);
      }
      return { timezone: tz };
    },
    run: (args, ctx): Json => {
      const timeZone = typeof args.timezone === 'string' ? args.timezone : 'UTC';
      const date = new Date(ctx.now);
      return {
        iso: date.toISOString(),
        timezone: timeZone,
        local: new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'long', timeZone }).format(date),
      };
    },
  };
}
