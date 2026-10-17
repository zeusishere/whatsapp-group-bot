import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppConfig } from '../../config/env.schema.js';
import { ConversationTurn } from '../models/types.js';
import { Redactor } from './redactor.js';
import { ClaimInput, TraceRepository } from './trace.repository.js';
import { TraceCollector } from './trace-collector.js';

export type ClaimOutcome =
  | { created: true; turn: ConversationTurn; collector: TraceCollector }
  | { created: false; turn: ConversationTurn };

/**
 * Entry point for starting a traced turn. Owns the shared `Redactor` and builds one
 * `TraceCollector` per turn.
 */
@Injectable()
export class TraceService {
  readonly redactor: Redactor;
  private readonly previewChars: number;

  constructor(
    private readonly repo: TraceRepository,
    config: ConfigService<AppConfig, true>,
  ) {
    const tracing = config.get('tracing', { infer: true });
    this.redactor = new Redactor({ enabled: tracing.redact, maxFieldChars: tracing.maxFieldChars });
    this.previewChars = tracing.previewChars;
  }

  /**
   * Idempotent start of a turn. Either this call creates the turn (and gets the collector that
   * must see it through to `run`), or the key was already used and the existing turn is
   * returned untouched, so a double-submit cannot duplicate spans or messages.
   */
  claim(input: ClaimInput): ClaimOutcome {
    const { created, turn } = this.repo.claimTurn(input);
    if (!created) return { created: false, turn };
    return { created: true, turn, collector: this.collectorFor(turn) };
  }

  collectorFor(turn: ConversationTurn): TraceCollector {
    return new TraceCollector(turn, this.repo, this.redactor, { previewChars: this.previewChars });
  }
}
