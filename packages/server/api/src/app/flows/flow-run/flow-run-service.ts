import { exceptionHandler, logger } from '@activepieces/server-shared'
import {
    ActivepiecesError,
    apId,
    Cursor,
    ErrorCode,
    ExecutionState,
    ExecutionType,
    ExecutioOutputFile,
    FileCompression,
    FileType,
    FlowId,
    FlowRetryStrategy,
    FlowRun,
    FlowRunId,
    FlowRunStatus,
    FlowVersionId,
    isNil,
    MAX_LOG_SIZE,
    PauseMetadata,
    PauseType,
    ProgressUpdateType,
    ProjectId,
    RunEnvironment,
    SeekPage,
    spreadIfDefined,
    TelemetryEventName,
} from '@activepieces/shared'
import { In } from 'typeorm'
import { repoFactory } from '../../core/db/repo-factory'
import {
    APArrayContains,
} from '../../database/database-connection'
import { fileService } from '../../file/file.service'
import { flowVersionService } from '../../flows/flow-version/flow-version.service'
import { buildPaginator } from '../../helper/pagination/build-paginator'
import { paginationHelper } from '../../helper/pagination/pagination-utils'
import { Order } from '../../helper/pagination/paginator'
import { telemetry } from '../../helper/telemetry.utils'
import { webhookResponseWatcher } from '../../workers/helper/webhook-response-watcher'
import { getJobPriority } from '../../workers/queue/queue-manager'
import { flowService } from '../flow/flow.service'
import { FlowRunEntity } from './flow-run-entity'
import { flowRunSideEffects } from './flow-run-side-effects'
import { logSerializer } from './log-serializer'

export const flowRunRepo = repoFactory<FlowRun>(FlowRunEntity)

const getFlowRunOrCreate = async (
    params: GetOrCreateParams,
): Promise<Partial<FlowRun>> => {
    const { id, projectId, flowId, flowVersionId, flowDisplayName, environment } =
        params

    if (id) {
        return flowRunService.getOneOrThrow({
            id,
            projectId,
        })
    }

    return {
        id: apId(),
        projectId,
        flowId,
        flowVersionId,
        environment,
        flowDisplayName,
        startTime: new Date().toISOString(),
    }
}

async function updateFlowRunToLatestFlowVersionIdAndReturnPayload(
    flowRunId: FlowRunId,
): Promise<unknown> {
    const flowRun = await flowRunService.getOnePopulatedOrThrow({
        id: flowRunId,
        projectId: undefined,
    })
    const flowVersion = await flowVersionService.getLatestLockedVersionOrThrow(
        flowRun.flowId,
    )
    await flowRunRepo().update(flowRunId, {
        flowVersionId: flowVersion.id,
    })
    return flowRun.steps ? flowRun.steps[flowVersion.trigger.name]?.output : undefined
}

function returnHandlerId(pauseMetadata: PauseMetadata | undefined, requestId: string | undefined): string {
    const handlerId = webhookResponseWatcher.getServerId()
    if (isNil(pauseMetadata)) {
        return handlerId
    }

    if (pauseMetadata.type === PauseType.WEBHOOK && requestId === pauseMetadata.requestId && pauseMetadata.handlerId) {
        return pauseMetadata.handlerId
    }
    else {
        return handlerId
    }
}

export const flowRunService = {
    async list({
        projectId,
        flowId,
        status,
        cursor,
        limit,
        tags,
        createdAfter,
        createdBefore,
    }: ListParams): Promise<SeekPage<FlowRun>> {
        const decodedCursor = paginationHelper.decodeCursor(cursor)
        const paginator = buildPaginator<FlowRun>({
            entity: FlowRunEntity,
            query: {
                limit,
                order: Order.DESC,
                afterCursor: decodedCursor.nextCursor,
                beforeCursor: decodedCursor.previousCursor,
            },
        })

        let query = flowRunRepo().createQueryBuilder('flow_run').where({
            projectId,
            environment: RunEnvironment.PRODUCTION,
        })
        if (flowId) {
            query = query.andWhere({
                flowId: In(flowId),
            })
        }
        if (status) {
            query = query.andWhere({
                status: In(status),
            })
        }
        if (createdAfter) {
            query = query.andWhere('flow_run.created >= :createdAfter', {
                createdAfter,
            })
        }
        if (createdBefore) {
            query = query.andWhere('flow_run.created <= :createdBefore', {
                createdBefore,
            })
        }
        if (tags) {
            query = APArrayContains('tags', tags, query)
        }
        const { data, cursor: newCursor } = await paginator.paginate(query)
        return paginationHelper.createPage<FlowRun>(data, newCursor)
    },
    async retry({ flowRunId, strategy }: RetryParams): Promise<void> {
        switch (strategy) {
            case FlowRetryStrategy.FROM_FAILED_STEP:
                await flowRunService.addToQueue({
                    flowRunId,
                    executionType: ExecutionType.RESUME,
                    progressUpdateType: ProgressUpdateType.NONE,
                })
                break
            case FlowRetryStrategy.ON_LATEST_VERSION: {
                const payload = await updateFlowRunToLatestFlowVersionIdAndReturnPayload(flowRunId)
                await flowRunService.addToQueue({
                    payload,
                    flowRunId,
                    executionType: ExecutionType.BEGIN,
                    progressUpdateType: ProgressUpdateType.NONE,
                })
                break
            }
        }
    },
    async addToQueue({
        flowRunId,
        payload,
        requestId,
        progressUpdateType,
        executionType,
    }: {
        flowRunId: FlowRunId
        requestId?: string
        progressUpdateType: ProgressUpdateType
        payload?: unknown
        executionType: ExecutionType
    }): Promise<void> {
        logger.info(`[FlowRunService#resume] flowRunId=${flowRunId}`)

        const flowRunToResume = await flowRunRepo().findOneBy({
            id: flowRunId,
        })

        if (isNil(flowRunToResume)) {
            throw new ActivepiecesError({
                code: ErrorCode.FLOW_RUN_NOT_FOUND,
                params: {
                    id: flowRunId,
                },
            })
        }
        const pauseMetadata = flowRunToResume.pauseMetadata
        const matchRequestId = isNil(pauseMetadata) || (pauseMetadata.type === PauseType.WEBHOOK && requestId === pauseMetadata.requestId)
        if (matchRequestId) {
            await flowRunService.start({
                payload,
                flowRunId: flowRunToResume.id,
                projectId: flowRunToResume.projectId,
                flowVersionId: flowRunToResume.flowVersionId,
                synchronousHandlerId: returnHandlerId(pauseMetadata, requestId),
                httpRequestId: requestId,
                progressUpdateType,
                executionType,
                environment: RunEnvironment.PRODUCTION,
            })
        }
    },
    async updateStatus({
        flowRunId,
        status,
        tasks,
        executionState,
        projectId,
        tags,
        duration,
    }: FinishParams): Promise<FlowRun> {
        const logFileId = await updateLogs({
            flowRunId,
            projectId,
            executionState,
        })

        await flowRunRepo().update(flowRunId, {
            status,
            tasks,
            ...spreadIfDefined('duration', duration ? Math.floor(Number(duration)) : undefined),
            ...spreadIfDefined('logsFileId', logFileId),
            terminationReason: undefined,
            tags,
            finishTime: new Date().toISOString(),
        })
        const flowRun = await this.getOnePopulatedOrThrow({
            id: flowRunId,
            projectId: undefined,
        })

        await flowRunSideEffects.finish({ flowRun })
        return flowRun
    },

    async start({
        projectId,
        flowVersionId,
        flowRunId,
        payload,
        environment,
        executionType,
        synchronousHandlerId,
        progressUpdateType,
        httpRequestId,
    }: StartParams): Promise<FlowRun> {
        const flowVersion = await flowVersionService.getOneOrThrow(flowVersionId)

        const flow = await flowService.getOneOrThrow({
            id: flowVersion.flowId,
            projectId,
        })

        const flowRun = await getFlowRunOrCreate({
            id: flowRunId,
            projectId: flow.projectId,
            flowId: flowVersion.flowId,
            flowVersionId: flowVersion.id,
            environment,
            flowDisplayName: flowVersion.displayName,
        })

        flowRun.status = FlowRunStatus.RUNNING

        const savedFlowRun = await flowRunRepo().save(flowRun)

        telemetry
            .trackProject(flow.projectId, {
                name: TelemetryEventName.FLOW_RUN_CREATED,
                payload: {
                    projectId: savedFlowRun.projectId,
                    flowId: savedFlowRun.flowId,
                    environment: savedFlowRun.environment,
                },
            })
            .catch((e) =>
                logger.error(e, '[FlowRunService#Start] telemetry.trackProject'),
            )

        const priority = await getJobPriority(savedFlowRun.projectId, synchronousHandlerId)
        await flowRunSideEffects.start({
            flowRun: savedFlowRun,
            httpRequestId,
            payload,
            priority,
            synchronousHandlerId,
            executionType,
            progressUpdateType,
        })

        return savedFlowRun
    },

    async test({ projectId, flowVersionId }: TestParams): Promise<FlowRun> {
        const flowVersion = await flowVersionService.getOneOrThrow(flowVersionId)

        const payload =
            flowVersion.trigger.settings.inputUiInfo.currentSelectedData

        return this.start({
            projectId,
            flowVersionId,
            payload,
            environment: RunEnvironment.TESTING,
            executionType: ExecutionType.BEGIN,
            synchronousHandlerId: webhookResponseWatcher.getServerId(),
            httpRequestId: undefined,
            progressUpdateType: ProgressUpdateType.TEST_FLOW,
        })
    },

    async pause(params: PauseParams): Promise<void> {
        logger.info(
            `[FlowRunService#pause] flowRunId=${params.flowRunId} pauseType=${params.pauseMetadata.type}`,
        )

        const { flowRunId, pauseMetadata } = params

        await flowRunRepo().update(flowRunId, {
            status: FlowRunStatus.PAUSED,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            pauseMetadata: pauseMetadata as any,
        })

        const flowRun = await flowRunRepo().findOneByOrFail({ id: flowRunId })

        await flowRunSideEffects.pause({ flowRun })
    },

    async getOneOrThrow(params: GetOneParams): Promise<FlowRun> {
        const flowRun = await flowRunRepo().findOneBy({
            projectId: params.projectId,
            id: params.id,
        })

        if (isNil(flowRun)) {
            throw new ActivepiecesError({
                code: ErrorCode.FLOW_RUN_NOT_FOUND,
                params: {
                    id: params.id,
                },
            })
        }

        return flowRun
    },
    async getOnePopulatedOrThrow(params: GetOneParams): Promise<FlowRun> {
        const flowRun = await this.getOneOrThrow(params)
        let steps = {}
        if (!isNil(flowRun.logsFileId)) {
            const logFile = await fileService.getOneOrThrow({
                fileId: flowRun.logsFileId,
                projectId: flowRun.projectId,
            })

            const serializedExecutionOutput = logFile.data.toString('utf-8')
            const executionOutput: ExecutioOutputFile = JSON.parse(
                serializedExecutionOutput,
            )
            steps = executionOutput.executionState.steps
        }
        return {
            ...flowRun,
            steps,
        }
    },
}

async function updateLogs({ flowRunId, projectId, executionState }: UpdateLogs): Promise<undefined | string> {
    if (isNil(executionState)) {
        return undefined
    }
    const flowRun = await flowRunRepo().findOneByOrFail({ id: flowRunId })
    const serializedLogs = await logSerializer.serialize({
        executionState,
    })

    if (serializedLogs.byteLength > MAX_LOG_SIZE) {
        const errors = new Error(
            'Execution Output is too large, maximum size is ' + MAX_LOG_SIZE,
        )
        exceptionHandler.handle(errors)
        throw errors
    }
    const fileId = flowRun.logsFileId ?? apId()
    await fileService.save({
        fileId,
        projectId,
        data: serializedLogs,
        type: FileType.FLOW_RUN_LOG,
        compression: FileCompression.GZIP,
    })
    return fileId
}

type UpdateLogs = {
    flowRunId: string
    projectId: ProjectId
    executionState: ExecutionState | null
}

type FinishParams = {
    flowRunId: FlowRunId
    projectId: string
    status: FlowRunStatus
    tasks: number
    duration: number | undefined
    executionState: ExecutionState | null
    tags: string[]
}

type GetOrCreateParams = {
    id?: FlowRunId
    projectId: ProjectId
    flowId: FlowId
    flowVersionId: FlowVersionId
    flowDisplayName: string
    environment: RunEnvironment
}

type ListParams = {
    projectId: ProjectId
    flowId: FlowId[] | undefined
    status: FlowRunStatus[] | undefined
    cursor: Cursor | null
    tags?: string[]
    limit: number
    createdAfter?: string
    createdBefore?: string
}

type GetOneParams = {
    id: FlowRunId
    projectId: ProjectId | undefined
}

type StartParams = {
    projectId: ProjectId
    flowVersionId: FlowVersionId
    flowRunId?: FlowRunId
    environment: RunEnvironment
    payload: unknown
    synchronousHandlerId: string | undefined
    httpRequestId: string | undefined
    progressUpdateType: ProgressUpdateType
    executionType: ExecutionType
}

type TestParams = {
    projectId: ProjectId
    flowVersionId: FlowVersionId
}

type PauseParams = {
    flowRunId: FlowRunId
    pauseMetadata: PauseMetadata
}

type RetryParams = {
    flowRunId: FlowRunId
    strategy: FlowRetryStrategy
}

