import {
  IOPacket,
  QueueOptions,
  SemanticInternalAttributes,
  TriggerTaskRequestBody,
  packetRequiresOffloading,
} from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { autoIncrementCounter } from "~/services/autoIncrementCounter.server";
import { sanitizeQueueName } from "~/v3/marqs/index.server";
import { eventRepository } from "../eventRepository.server";
import { generateFriendlyId } from "../friendlyIdentifiers";
import { uploadToObjectStore } from "../r2.server";
import { startActiveSpan } from "../tracer.server";
import { getEntitlement } from "~/services/platform.v3.server";
import { BaseService, ServiceValidationError } from "./baseService.server";
import { logger } from "~/services/logger.server";
import { isFinalAttemptStatus, isFinalRunStatus } from "../taskStatus";
import { createTag, MAX_TAGS_PER_RUN } from "~/models/taskRunTag.server";
import { findCurrentWorkerFromEnvironment } from "../models/workerDeployment.server";
import { handleMetadataPacket } from "~/utils/packets";
import type { PrismaClientOrTransaction } from "~/db.server";
import { engine, type RunEngine } from "../runEngine.server";

export type TriggerTaskServiceOptions = {
  idempotencyKey?: string;
  triggerVersion?: string;
  traceContext?: Record<string, string | undefined>;
  spanParentAsLink?: boolean;
  parentAsLinkType?: "replay" | "trigger";
  batchId?: string;
  customIcon?: string;
};

export class OutOfEntitlementError extends Error {
  constructor() {
    super("You can't trigger a task because you have run out of credits.");
  }
}

export class TriggerTaskServiceV2 extends BaseService {
  private _engine: RunEngine;

  constructor({ prisma, runEngine }: { prisma: PrismaClientOrTransaction; runEngine: RunEngine }) {
    super(prisma);
    this._engine = runEngine ?? engine;
  }

  public async call({
    taskId,
    environment,
    body,
    options = {},
  }: {
    taskId: string;
    environment: AuthenticatedEnvironment;
    body: TriggerTaskRequestBody;
    options?: TriggerTaskServiceOptions;
  }) {
    return await this.traceWithEnv("call()", environment, async (span) => {
      span.setAttribute("taskId", taskId);

      const idempotencyKey = options.idempotencyKey ?? body.options?.idempotencyKey;
      const delayUntil = await parseDelay(body.options?.delay);

      const ttl =
        typeof body.options?.ttl === "number"
          ? stringifyDuration(body.options?.ttl)
          : body.options?.ttl ?? (environment.type === "DEVELOPMENT" ? "10m" : undefined);

      const existingRun = idempotencyKey
        ? await this._prisma.taskRun.findUnique({
            where: {
              runtimeEnvironmentId_taskIdentifier_idempotencyKey: {
                runtimeEnvironmentId: environment.id,
                idempotencyKey,
                taskIdentifier: taskId,
              },
            },
          })
        : undefined;

      if (existingRun) {
        span.setAttribute("runId", existingRun.friendlyId);

        return existingRun;
      }

      if (environment.type !== "DEVELOPMENT") {
        const result = await getEntitlement(environment.organizationId);
        if (result && result.hasAccess === false) {
          throw new OutOfEntitlementError();
        }
      }

      if (
        body.options?.tags &&
        typeof body.options.tags !== "string" &&
        body.options.tags.length > MAX_TAGS_PER_RUN
      ) {
        throw new ServiceValidationError(
          `Runs can only have ${MAX_TAGS_PER_RUN} tags, you're trying to set ${body.options.tags.length}.`
        );
      }

      const runFriendlyId = generateFriendlyId("run");

      const payloadPacket = await this.#handlePayloadPacket(
        body.payload,
        body.options?.payloadType ?? "application/json",
        runFriendlyId,
        environment
      );

      const metadataPacket = body.options?.metadata
        ? handleMetadataPacket(
            body.options?.metadata,
            body.options?.metadataType ?? "application/json"
          )
        : undefined;

      const dependentAttempt = body.options?.dependentAttempt
        ? await this._prisma.taskRunAttempt.findUnique({
            where: { friendlyId: body.options.dependentAttempt },
            include: {
              taskRun: {
                select: {
                  id: true,
                  status: true,
                  taskIdentifier: true,
                  rootTaskRunId: true,
                  depth: true,
                },
              },
            },
          })
        : undefined;

      if (
        dependentAttempt &&
        (isFinalAttemptStatus(dependentAttempt.status) ||
          isFinalRunStatus(dependentAttempt.taskRun.status))
      ) {
        logger.debug("Dependent attempt or run is in a terminal state", {
          dependentAttempt: dependentAttempt,
        });

        if (isFinalAttemptStatus(dependentAttempt.status)) {
          throw new ServiceValidationError(
            `Cannot trigger ${taskId} as the parent attempt has a status of ${dependentAttempt.status}`
          );
        } else {
          throw new ServiceValidationError(
            `Cannot trigger ${taskId} as the parent run has a status of ${dependentAttempt.taskRun.status}`
          );
        }
      }

      const parentAttempt = body.options?.parentAttempt
        ? await this._prisma.taskRunAttempt.findUnique({
            where: { friendlyId: body.options.parentAttempt },
            include: {
              taskRun: {
                select: {
                  id: true,
                  status: true,
                  taskIdentifier: true,
                  rootTaskRunId: true,
                  depth: true,
                },
              },
            },
          })
        : undefined;

      const dependentBatchRun = body.options?.dependentBatch
        ? await this._prisma.batchTaskRun.findUnique({
            where: { friendlyId: body.options.dependentBatch },
            include: {
              dependentTaskAttempt: {
                include: {
                  taskRun: {
                    select: {
                      id: true,
                      status: true,
                      taskIdentifier: true,
                      rootTaskRunId: true,
                      depth: true,
                    },
                  },
                },
              },
            },
          })
        : undefined;

      if (
        dependentBatchRun &&
        dependentBatchRun.dependentTaskAttempt &&
        (isFinalAttemptStatus(dependentBatchRun.dependentTaskAttempt.status) ||
          isFinalRunStatus(dependentBatchRun.dependentTaskAttempt.taskRun.status))
      ) {
        logger.debug("Dependent batch run task attempt or run has been canceled", {
          dependentBatchRunId: dependentBatchRun.id,
          status: dependentBatchRun.status,
          attempt: dependentBatchRun.dependentTaskAttempt,
        });

        if (isFinalAttemptStatus(dependentBatchRun.dependentTaskAttempt.status)) {
          throw new ServiceValidationError(
            `Cannot trigger ${taskId} as the parent attempt has a status of ${dependentBatchRun.dependentTaskAttempt.status}`
          );
        } else {
          throw new ServiceValidationError(
            `Cannot trigger ${taskId} as the parent run has a status of ${dependentBatchRun.dependentTaskAttempt.taskRun.status}`
          );
        }
      }

      const parentBatchRun = body.options?.parentBatch
        ? await this._prisma.batchTaskRun.findUnique({
            where: { friendlyId: body.options.parentBatch },
            include: {
              dependentTaskAttempt: {
                include: {
                  taskRun: {
                    select: {
                      id: true,
                      status: true,
                      taskIdentifier: true,
                      rootTaskRunId: true,
                    },
                  },
                },
              },
            },
          })
        : undefined;

      return await eventRepository.traceEvent(
        taskId,
        {
          context: options.traceContext,
          spanParentAsLink: options.spanParentAsLink,
          parentAsLinkType: options.parentAsLinkType,
          kind: "SERVER",
          environment,
          taskSlug: taskId,
          attributes: {
            properties: {
              [SemanticInternalAttributes.SHOW_ACTIONS]: true,
            },
            style: {
              icon: options.customIcon ?? "task",
            },
            runIsTest: body.options?.test ?? false,
            batchId: options.batchId,
            idempotencyKey,
          },
          incomplete: true,
          immediate: true,
        },
        async (event, traceContext, traceparent) => {
          const run = await autoIncrementCounter.incrementInTransaction(
            `v3-run:${environment.id}:${taskId}`,
            async (num, tx) => {
              const lockedToBackgroundWorker = body.options?.lockToVersion
                ? await tx.backgroundWorker.findUnique({
                    where: {
                      projectId_runtimeEnvironmentId_version: {
                        projectId: environment.projectId,
                        runtimeEnvironmentId: environment.id,
                        version: body.options?.lockToVersion,
                      },
                    },
                  })
                : undefined;

              let queueName = sanitizeQueueName(
                await this.#getQueueName(taskId, environment, body.options?.queue?.name)
              );

              // Check that the queuename is not an empty string
              if (!queueName) {
                queueName = sanitizeQueueName(`task/${taskId}`);
              }

              event.setAttribute("queueName", queueName);
              span.setAttribute("queueName", queueName);

              //upsert tags
              let tagIds: string[] = [];
              const bodyTags =
                typeof body.options?.tags === "string" ? [body.options.tags] : body.options?.tags;
              if (bodyTags && bodyTags.length > 0) {
                for (const tag of bodyTags) {
                  const tagRecord = await createTag({
                    tag,
                    projectId: environment.projectId,
                  });
                  if (tagRecord) {
                    tagIds.push(tagRecord.id);
                  }
                }
              }

              const depth = dependentAttempt
                ? dependentAttempt.taskRun.depth + 1
                : parentAttempt
                ? parentAttempt.taskRun.depth + 1
                : dependentBatchRun?.dependentTaskAttempt
                ? dependentBatchRun.dependentTaskAttempt.taskRun.depth + 1
                : 0;

              event.setAttribute("runId", runFriendlyId);
              span.setAttribute("runId", runFriendlyId);

              const taskRun = await this._engine.trigger(
                {
                  number: num,
                  friendlyId: runFriendlyId,
                  environment: environment,
                  idempotencyKey,
                  taskIdentifier: taskId,
                  payload: payloadPacket.data ?? "",
                  payloadType: payloadPacket.dataType,
                  context: body.context,
                  traceContext: traceContext,
                  traceId: event.traceId,
                  spanId: event.spanId,
                  parentSpanId:
                    options.parentAsLinkType === "replay" ? undefined : traceparent?.spanId,
                  lockedToVersionId: lockedToBackgroundWorker?.id,
                  concurrencyKey: body.options?.concurrencyKey,
                  queueName,
                  queue: body.options?.queue,
                  //todo multiple worker pools support
                  masterQueue: "main",
                  isTest: body.options?.test ?? false,
                  delayUntil,
                  queuedAt: delayUntil ? undefined : new Date(),
                  maxAttempts: body.options?.maxAttempts,
                  ttl,
                  tags: tagIds,
                  parentTaskRunId: parentAttempt?.taskRun.id,
                  rootTaskRunId: parentAttempt?.taskRun.rootTaskRunId ?? parentAttempt?.taskRun.id,
                  batchId: dependentBatchRun?.id ?? parentBatchRun?.id,
                  resumeParentOnCompletion: !!(dependentAttempt ?? dependentBatchRun),
                  depth,
                  metadata: metadataPacket?.data,
                  metadataType: metadataPacket?.dataType,
                  seedMetadata: metadataPacket?.data,
                  seedMetadataType: metadataPacket?.dataType,
                },
                this._prisma
              );

              return taskRun;
            },
            async (_, tx) => {
              const counter = await tx.taskRunNumberCounter.findUnique({
                where: {
                  taskIdentifier_environmentId: {
                    taskIdentifier: taskId,
                    environmentId: environment.id,
                  },
                },
                select: { lastNumber: true },
              });

              return counter?.lastNumber;
            },
            this._prisma
          );

          return run;
        }
      );
    });
  }

  async #getQueueName(taskId: string, environment: AuthenticatedEnvironment, queueName?: string) {
    if (queueName) {
      return queueName;
    }

    const defaultQueueName = `task/${taskId}`;

    const worker = await findCurrentWorkerFromEnvironment(environment);

    if (!worker) {
      logger.debug("Failed to get queue name: No worker found", {
        taskId,
        environmentId: environment.id,
      });

      return defaultQueueName;
    }

    const task = await this._prisma.backgroundWorkerTask.findUnique({
      where: {
        workerId_slug: {
          workerId: worker.id,
          slug: taskId,
        },
      },
    });

    if (!task) {
      console.log("Failed to get queue name: No task found", {
        taskId,
        environmentId: environment.id,
      });

      return defaultQueueName;
    }

    const queueConfig = QueueOptions.optional().nullable().safeParse(task.queueConfig);

    if (!queueConfig.success) {
      console.log("Failed to get queue name: Invalid queue config", {
        taskId,
        environmentId: environment.id,
        queueConfig: task.queueConfig,
      });

      return defaultQueueName;
    }

    return queueConfig.data?.name ?? defaultQueueName;
  }

  async #handlePayloadPacket(
    payload: any,
    payloadType: string,
    pathPrefix: string,
    environment: AuthenticatedEnvironment
  ) {
    return await startActiveSpan("handlePayloadPacket()", async (span) => {
      const packet = this.#createPayloadPacket(payload, payloadType);

      if (!packet.data) {
        return packet;
      }

      const { needsOffloading, size } = packetRequiresOffloading(
        packet,
        env.TASK_PAYLOAD_OFFLOAD_THRESHOLD
      );

      if (!needsOffloading) {
        return packet;
      }

      const filename = `${pathPrefix}/payload.json`;

      await uploadToObjectStore(filename, packet.data, packet.dataType, environment);

      return {
        data: filename,
        dataType: "application/store",
      };
    });
  }

  #createPayloadPacket(payload: any, payloadType: string): IOPacket {
    if (payloadType === "application/json") {
      return { data: JSON.stringify(payload), dataType: "application/json" };
    }

    if (typeof payload === "string") {
      return { data: payload, dataType: payloadType };
    }

    return { dataType: payloadType };
  }
}

export async function parseDelay(value?: string | Date): Promise<Date | undefined> {
  if (!value) {
    return;
  }

  if (value instanceof Date) {
    return value;
  }

  try {
    const date = new Date(value);

    // Check if the date is valid
    if (isNaN(date.getTime())) {
      return parseNaturalLanguageDuration(value);
    }

    if (date.getTime() <= Date.now()) {
      return;
    }

    return date;
  } catch (error) {
    return parseNaturalLanguageDuration(value);
  }
}

export function parseNaturalLanguageDuration(duration: string): Date | undefined {
  const regexPattern = /^(\d+w)?(\d+d)?(\d+h)?(\d+m)?(\d+s)?$/;

  const result: Date = new Date();
  let hasMatch = false;

  const elements = duration.match(regexPattern);
  if (elements) {
    if (elements[1]) {
      const weeks = Number(elements[1].slice(0, -1));
      if (weeks >= 0) {
        result.setDate(result.getDate() + 7 * weeks);
        hasMatch = true;
      }
    }
    if (elements[2]) {
      const days = Number(elements[2].slice(0, -1));
      if (days >= 0) {
        result.setDate(result.getDate() + days);
        hasMatch = true;
      }
    }
    if (elements[3]) {
      const hours = Number(elements[3].slice(0, -1));
      if (hours >= 0) {
        result.setHours(result.getHours() + hours);
        hasMatch = true;
      }
    }
    if (elements[4]) {
      const minutes = Number(elements[4].slice(0, -1));
      if (minutes >= 0) {
        result.setMinutes(result.getMinutes() + minutes);
        hasMatch = true;
      }
    }
    if (elements[5]) {
      const seconds = Number(elements[5].slice(0, -1));
      if (seconds >= 0) {
        result.setSeconds(result.getSeconds() + seconds);
        hasMatch = true;
      }
    }
  }

  if (hasMatch) {
    return result;
  }

  return undefined;
}

function stringifyDuration(seconds: number): string | undefined {
  if (seconds <= 0) {
    return;
  }

  const units = {
    w: Math.floor(seconds / 604800),
    d: Math.floor((seconds % 604800) / 86400),
    h: Math.floor((seconds % 86400) / 3600),
    m: Math.floor((seconds % 3600) / 60),
    s: Math.floor(seconds % 60),
  };

  // Filter the units having non-zero values and join them
  const result: string = Object.entries(units)
    .filter(([unit, val]) => val != 0)
    .map(([unit, val]) => `${val}${unit}`)
    .join("");

  return result;
}
