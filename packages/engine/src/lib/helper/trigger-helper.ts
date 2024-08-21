import { PiecePropertyMap, StaticPropsValue, TriggerStrategy } from '@activepieces/pieces-framework'
import { assertEqual, assertNotNullOrUndefined, AUTHENTICATION_PROPERTY_NAME, EventPayload, ExecuteTriggerOperation, ExecuteTriggerResponse, PieceTrigger, ScheduleOptions, TriggerHookType } from '@activepieces/shared'
import { isValidCron } from 'cron-validator'
import { EngineConstants } from '../handler/context/engine-constants'
import { FlowExecutorContext } from '../handler/context/flow-execution-context'
import { createFilesService } from '../services/files.service'
import { createContextStore } from '../services/storage.service'
import { variableService } from '../services/variable-service'
import { pieceLoader } from './piece-loader'

type Listener = {
    events: string[]
    identifierValue: string
    identifierKey: string
}

export const triggerHelper = {
    async executeTrigger({ params, constants }: ExecuteTriggerParams): Promise<ExecuteTriggerResponse<TriggerHookType>> {
        const { pieceName, pieceVersion, triggerName, input } = (params.flowVersion.trigger as PieceTrigger).settings

        assertNotNullOrUndefined(triggerName, 'triggerName is required')
        const piece = await pieceLoader.loadPieceOrThrow({ pieceName, pieceVersion, piecesSource: constants.piecesSource })
        const trigger = piece.getTrigger(triggerName)

        if (trigger === undefined) {
            throw new Error(`trigger not found, pieceName=${pieceName}, triggerName=${triggerName}`)
        }

        const { resolvedInput } = await variableService({
            apiUrl: constants.internalApiUrl,
            projectId: params.projectId,
            engineToken: params.engineToken,
        }).resolve<StaticPropsValue<PiecePropertyMap>>({
            unresolvedInput: input,
            executionState: FlowExecutorContext.empty(),
        })

        const { processedInput, errors } = await variableService({
            apiUrl: constants.internalApiUrl,
            projectId: params.projectId,
            engineToken: params.engineToken,
        }).applyProcessorsAndValidators(resolvedInput, trigger.props, piece.auth)

        if (Object.keys(errors).length > 0) {
            throw new Error(JSON.stringify(errors))
        }

        const appListeners: Listener[] = []
        const prefix = params.test ? 'test' : ''
        let scheduleOptions: ScheduleOptions | undefined = undefined
        const context = {
            store: createContextStore({
                apiUrl: constants.internalApiUrl,
                prefix,
                flowId: params.flowVersion.flowId,
                engineToken: params.engineToken,
            }),
            app: {
                createListeners({ events, identifierKey, identifierValue }: Listener): void {
                    appListeners.push({ events, identifierValue, identifierKey })
                },
            },
            setSchedule(request: ScheduleOptions) {
                if (!isValidCron(request.cronExpression)) {
                    throw new Error(`Invalid cron expression: ${request.cronExpression}`)
                }
                scheduleOptions = {
                    cronExpression: request.cronExpression,
                    timezone: request.timezone ?? 'UTC',
                    failureCount: request.failureCount ?? 0,
                }
            },
            flows: {
                current: {
                    id: params.flowVersion.flowId,
                    version: {
                        id: params.flowVersion.id,
                    },
                },
            },
            webhookUrl: params.webhookUrl,
            auth: processedInput[AUTHENTICATION_PROPERTY_NAME],
            propsValue: processedInput,
            payload: params.triggerPayload ?? {},
            project: {
                id: params.projectId,
                externalId: constants.externalProjectId,
            },
        }
        switch (params.hookType) {
            case TriggerHookType.ON_DISABLE:
                await trigger.onDisable(context)
                return {}
            case TriggerHookType.ON_ENABLE:
                await trigger.onEnable(context)
                return {
                    listeners: appListeners,
                    scheduleOptions: trigger.type === TriggerStrategy.POLLING ? scheduleOptions : undefined,
                }
            case TriggerHookType.RENEW:
                assertEqual(trigger.type, TriggerStrategy.WEBHOOK, 'triggerType', 'WEBHOOK')
                await trigger.onRenew(context)
                return {
                    success: true,
                }
            case TriggerHookType.HANDSHAKE: {
                try {
                    const response = await trigger.onHandshake(context)
                    return {
                        success: true,
                        response,
                    }
                }
                catch (e) {
                    console.error(e)

                    return {
                        success: false,
                        message: JSON.stringify(e),
                    }
                }
            }
            case TriggerHookType.TEST:
                try {
                    return {
                        success: true,
                        output: await trigger.test({
                            ...context,
                            files: createFilesService({
                                apiUrl: constants.internalApiUrl,
                                engineToken: params.engineToken!,
                                stepName: triggerName,
                                flowId: params.flowVersion.flowId,
                                type: 'db',
                            }),
                        }),
                    }
                }
                catch (e) {
                    console.error(e)

                    return {
                        success: false,
                        message: JSON.stringify(e),
                        output: [],
                    }
                }
            case TriggerHookType.RUN: {
                if (trigger.type === TriggerStrategy.APP_WEBHOOK) {
                    if (!params.appWebhookUrl) {
                        throw new Error(`App webhook url is not available for piece name ${pieceName}`)
                    }
                    if (!params.webhookSecret) {
                        throw new Error(`Webhook secret is not available for piece name ${pieceName}`)
                    }

                    try {
                        const verified = piece.events?.verify({
                            appWebhookUrl: params.appWebhookUrl,
                            payload: params.triggerPayload as EventPayload,
                            webhookSecret: params.webhookSecret,
                        })

                        if (verified === false) {
                            console.info('Webhook is not verified')
                            return {
                                success: false,
                                message: 'Webhook is not verified',
                                output: [],
                            }
                        }
                    }
                    catch (e) {
                        console.error('Error while verifying webhook', e)
                        return {
                            success: false,
                            message: 'Error while verifying webhook',
                            output: [],
                        }
                    }
                }
                const items = await trigger.run({
                    ...context,
                    files: createFilesService({
                        apiUrl: constants.internalApiUrl,
                        engineToken: params.engineToken!,
                        flowId: params.flowVersion.flowId,
                        stepName: triggerName,
                        type: 'memory',
                    }),
                })
                if (!Array.isArray(items)) {
                    throw new Error(`Trigger run should return an array of items, but returned ${typeof items}`)
                }
                return {
                    success: true,
                    output: items,
                }
            }
        }
    },
}

type ExecuteTriggerParams = {
    params: ExecuteTriggerOperation<TriggerHookType>
    constants: EngineConstants
}
