import { Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module.js';
import { SessionsModule } from '../sessions/sessions.module.js';
import { WhatsappModule } from '../whatsapp/whatsapp.module.js';
import { ChatController } from './controllers/chat.controller.js';
import { DebugController } from './controllers/debug.controller.js';
import { TraceInspectorService } from './inspector/trace-inspector.service.js';
import { EmbeddingClient, LlmClient } from './llm/llm-client.js';
import { GeminiEmbeddingClient, GeminiLlmClient, GeminiSdk } from './llm/gemini.client.js';
import { ChatPipelineService } from './pipeline/chat-pipeline.service.js';
import { ChatService } from './pipeline/chat.service.js';
import { DecisionEngine } from './services/decision-engine.service.js';
import { EmbeddingService } from './services/embedding.service.js';
import { PromptAssembler } from './services/prompt-assembler.service.js';
import { HeuristicReranker, Reranker } from './services/reranker.js';
import { RetrievalService } from './services/retrieval.service.js';
import { ToolRegistry } from './services/tool.registry.js';
import { WebSearchService } from './services/web-search.service.js';
import { TraceRepository } from './tracing/trace.repository.js';
import { TraceService } from './tracing/trace.service.js';

@Module({
  imports: [MessagesModule, SessionsModule, WhatsappModule],
  controllers: [ChatController, DebugController],
  providers: [
    TraceRepository,
    TraceService,
    TraceInspectorService,
    GeminiSdk,
    { provide: LlmClient, useClass: GeminiLlmClient },
    { provide: EmbeddingClient, useClass: GeminiEmbeddingClient },
    { provide: Reranker, useClass: HeuristicReranker },
    EmbeddingService,
    RetrievalService,
    WebSearchService,
    ToolRegistry,
    DecisionEngine,
    PromptAssembler,
    ChatPipelineService,
    ChatService,
  ],
  exports: [ChatService, TraceRepository, TraceInspectorService],
})
export class ChatbotModule {}
