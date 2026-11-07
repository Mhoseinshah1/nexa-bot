import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  API_PREFIX,
  RESELLER_REQUEST_ERROR_CODES,
  RESELLER_REQUEST_ROUTES,
  errors,
  resellerRequestApproveRequestSchema,
  resellerRequestListQuerySchema,
  resellerRequestMessageRequestSchema,
  resellerRequestQuestionsSaveRequestSchema,
  resellerRequestRejectRequestSchema,
  routePattern,
  type BotInstanceId,
  type ResellerRequestDetailResponse,
  type ResellerRequestListResponse,
  type ResellerRequestQuestionsResponse,
} from '@nexa/contracts';
import { CONTAINER, type Container } from '../../container.js';
import { authenticateAdmin } from './authenticated-request.js';
import type {
  RequestDetail,
  RequestDecisionResult,
} from '../../modules/commerce/reseller-requests/application/reseller-request.service.js';
import type {
  QuestionRecord,
  RequestRecord,
} from '../../modules/commerce/reseller-requests/application/ports.js';

/**
 * «درخواست‌های نمایندگی» over HTTP (PR-2): the list with its four chips, one request with its
 * conversation, the operator's message, the decision, and the owner's questions.
 *
 * Authentication and the origin check happen here; AUTHORIZATION does not.
 * `ResellerRequestService` charges `resellers.view` for a read and `resellers.edit` for a
 * write inside its transactions.
 */
@Controller(`${API_PREFIX}`)
export class ResellerRequestsController {
  constructor(@Inject(CONTAINER) private readonly container: Container) {}

  @Get(RESELLER_REQUEST_ROUTES.list)
  async list(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
  ): Promise<ResellerRequestListResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = resellerRequestListQuerySchema.parse(query ?? {});
    const page = await this.container.resellerRequests.list(scope, actor, {
      filter: input.filter,
      limit: input.limit,
      before:
        input.before === undefined || input.beforeId === undefined
          ? undefined
          : { at: new Date(input.before), id: input.beforeId },
    });
    return {
      requests: page.items.map((item) => ({
        id: item.request.id,
        number: Number(item.request.number),
        customerId: item.request.customerId,
        customerName: item.customerName,
        customerUsername: item.customerUsername,
        status: item.request.status,
        conversing: item.conversing,
        createdAt: item.request.createdAt.toISOString(),
        decidedAt: item.request.decidedAt?.toISOString() ?? null,
        lastMessageAt: item.request.lastMessageAt?.toISOString() ?? null,
      })),
      counts: page.counts,
      nextCursor: page.next === null ? null : { at: page.next.at.toISOString(), id: page.next.id },
    };
  }

  @Get(routePattern(RESELLER_REQUEST_ROUTES.detail, 'requestId'))
  async detail(
    @Req() request: FastifyRequest,
    @Param('requestId') requestId: string,
  ): Promise<ResellerRequestDetailResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return {
      request: this.view(await this.container.resellerRequests.get(scope, actor, requestId)),
    };
  }

  @Post(routePattern(RESELLER_REQUEST_ROUTES.message, 'requestId'))
  async message(
    @Req() request: FastifyRequest,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<ResellerRequestDetailResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = resellerRequestMessageRequestSchema.parse(body);
    await this.container.resellerRequests.postMessage(scope, actor, { requestId, ...input });
    return {
      request: this.view(await this.container.resellerRequests.get(scope, actor, requestId)),
    };
  }

  @Post(routePattern(RESELLER_REQUEST_ROUTES.approve, 'requestId'))
  async approve(
    @Req() request: FastifyRequest,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<ResellerRequestDetailResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = resellerRequestApproveRequestSchema.parse(body);
    // The boundary is wired; the approval transaction is the next change's.
    await this.container.resellerRequests.approve(scope, actor, { requestId, ...input });
    return {
      request: this.view(await this.container.resellerRequests.get(scope, actor, requestId)),
    };
  }

  @Post(routePattern(RESELLER_REQUEST_ROUTES.reject, 'requestId'))
  async reject(
    @Req() request: FastifyRequest,
    @Param('requestId') requestId: string,
    @Body() body: unknown,
  ): Promise<ResellerRequestDetailResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = resellerRequestRejectRequestSchema.parse(body);
    const result: RequestDecisionResult = await this.container.resellerRequests.reject(
      scope,
      actor,
      { requestId, reason: input.reason, idempotencyKey: input.idempotencyKey },
    );
    return {
      request: this.view(
        await this.container.resellerRequests.get(scope, actor, result.request.id),
      ),
    };
  }

  /**
   * The BYTES of an applicant's photo, fetched by this process with the bot that received it —
   * the ticket attachments' route and headers: `attachment`, `nosniff`, octet-stream whatever
   * the customer declared, so a file a customer uploaded is never rendered in the admin origin
   * and no `file_id` ever reaches a browser.
   */
  @Get(routePattern(RESELLER_REQUEST_ROUTES.attachment, 'messageId'))
  async attachment(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('messageId') messageId: string,
  ): Promise<void> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const { message, attachment } = await this.container.resellerRequests.attachmentOf(
      scope,
      actor,
      messageId,
    );
    const fetched = await this.container.receiptFiles.download(scope, {
      botInstanceId: attachment.botInstanceId as BotInstanceId,
      fileId: attachment.fileId,
    });
    if (fetched.outcome !== 'SUCCEEDED') {
      throw errors.preconditionFailed(
        RESELLER_REQUEST_ERROR_CODES.ATTACHMENT_UNAVAILABLE,
        'This attachment can no longer be fetched from Telegram.',
      );
    }
    const bytes = fetched.bytes;
    await reply
      .header('content-type', 'application/octet-stream')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename="${message.id}"`)
      .header('content-length', String(bytes.byteLength))
      .header('cache-control', 'no-store')
      .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  }

  @Get(RESELLER_REQUEST_ROUTES.questions)
  async questions(@Req() request: FastifyRequest): Promise<ResellerRequestQuestionsResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    return {
      questions: (await this.container.resellerRequests.listQuestions(scope, actor)).map(
        questionView,
      ),
    };
  }

  @Post(RESELLER_REQUEST_ROUTES.questions)
  async saveQuestions(
    @Req() request: FastifyRequest,
    @Body() body: unknown,
  ): Promise<ResellerRequestQuestionsResponse> {
    const { scope, actor } = await authenticateAdmin(this.container, request);
    const input = resellerRequestQuestionsSaveRequestSchema.parse(body);
    const saved = await this.container.resellerRequests.saveQuestions(scope, actor, input);
    return { questions: saved.questions.map(questionView) };
  }

  private view(detail: RequestDetail): ResellerRequestDetailResponse['request'] {
    const r: RequestRecord = detail.request;
    return {
      id: r.id,
      number: Number(r.number),
      customerId: r.customerId,
      customerName: detail.customer?.displayName ?? null,
      customerUsername: detail.customer?.username ?? null,
      status: r.status,
      conversing: detail.conversing,
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      lastMessageAt: r.lastMessageAt?.toISOString() ?? null,
      answers: [...r.answers],
      reason: r.reason,
      decidedByName: detail.decidedByName,
      tierId: r.tierId,
      tierName: detail.tierName,
      servicesCount: detail.customer?.servicesCount ?? 0,
      messages: detail.messages.map((one) => ({
        id: one.id,
        senderType: one.senderType,
        authorAdminName: one.authorAdminName,
        body: one.body,
        attachmentKind: one.attachment?.kind ?? null,
        createdAt: one.createdAt.toISOString(),
      })),
    };
  }
}

function questionView(question: QuestionRecord) {
  return {
    id: question.id,
    position: question.position,
    text: question.text,
    required: question.required,
    maxLength: question.maxLength,
  };
}
