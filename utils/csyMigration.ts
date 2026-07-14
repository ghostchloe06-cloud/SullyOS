import type { CharacterProfile, FullBackupData, Message } from '../types';
import type { MemoryNode, MemoryRoom, MemoryVector } from './memoryPalace/types';

export interface CsyHormoneSnapshot extends Record<string, number | undefined> {
    dopamine?: number;
    serotonin?: number;
    cortisol?: number;
    oxytocin?: number;
    norepinephrine?: number;
    endorphin?: number;
    energy?: number;
}

export interface CsyVectorMemory {
    id: string;
    charId: string;
    title: string;
    content: string;
    emotionalJourney?: string;
    importance: number;
    mentionCount?: number;
    lastMentioned?: number;
    createdAt: number;
    updatedAt?: number;
    vector: number[];
    modelId?: string;
    source?: 'auto' | 'manual' | 'import';
    sourceMessageIds?: number[];
    deprecated?: boolean;
    deprecatedReason?: string;
    hormoneSnapshot?: CsyHormoneSnapshot;
    salienceScore?: number;
}

export interface CsyBackupData extends FullBackupData {
    vectorMemories?: CsyVectorMemory[];
    extraLocalStorageConfig?: Record<string, string>;
}

export interface CsyMigrationReport {
    characters: number;
    messages: number;
    vectorMemories: number;
    reusableVectors: number;
    rebuildRequired: number;
    deprecatedMemories: number;
    skippedInvalidMemories: number;
    embeddingModels: string[];
    warnings: string[];
}

export interface PreparedCsyMigration {
    data: FullBackupData;
    report: CsyMigrationReport;
}

type ModelChoice = {
    provider: 'openai' | 'cohere';
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    dimensions?: number;
};

const finiteNumber = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const clampImportance = (value: unknown): number =>
    Math.max(1, Math.min(10, Math.round(finiteNumber(value, 5))));

const normalizeModel = (model: string | undefined): string =>
    (model || 'unknown').replace(/^Pro\//i, '').trim().toLowerCase();

const modelKey = (model: string | undefined, dimensions: number): string =>
    `${normalizeModel(model)}@${dimensions}`;

const isValidVectorMemory = (value: unknown): value is CsyVectorMemory => {
    if (!value || typeof value !== 'object') return false;
    const memory = value as CsyVectorMemory;
    return typeof memory.id === 'string'
        && memory.id.length > 0
        && typeof memory.charId === 'string'
        && memory.charId.length > 0
        && typeof memory.content === 'string'
        && Array.isArray(memory.vector)
        && memory.vector.length > 0
        && memory.vector.every(item => typeof item === 'number' && Number.isFinite(item));
};

const chooseEmbedding = (
    memories: CsyVectorMemory[],
    extra: Record<string, string> | undefined,
): ModelChoice => {
    const provider = extra?.embedding_provider === 'cohere' ? 'cohere' : 'openai';
    const configuredModel = extra?.embedding_model
        || (provider === 'cohere' ? extra?.embedding_model_cohere : extra?.embedding_model_openai);
    const configuredKey = extra?.embedding_api_key
        || (provider === 'cohere' ? extra?.embedding_api_key_cohere : extra?.embedding_api_key_openai);
    const configuredUrl = extra?.embedding_base_url
        || (provider === 'cohere' ? extra?.embedding_base_url_cohere : extra?.embedding_base_url_openai);

    if (configuredModel) {
        const matchingDimensions = new Map<number, number>();
        for (const memory of memories) {
            if (memory.modelId && normalizeModel(memory.modelId) !== normalizeModel(configuredModel)) continue;
            matchingDimensions.set(memory.vector.length, (matchingDimensions.get(memory.vector.length) || 0) + 1);
        }
        const dimensions = [...matchingDimensions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
        return { provider, model: configuredModel, dimensions, apiKey: configuredKey, baseUrl: configuredUrl };
    }

    const counts = new Map<string, { count: number; model?: string; dimensions: number }>();
    for (const memory of memories) {
        const key = modelKey(memory.modelId, memory.vector.length);
        const current = counts.get(key) || { count: 0, model: memory.modelId, dimensions: memory.vector.length };
        current.count += 1;
        counts.set(key, current);
    }
    const dominant = [...counts.values()].sort((a, b) => b.count - a.count)[0];
    return { provider, model: dominant?.model, dimensions: dominant?.dimensions, apiKey: configuredKey, baseUrl: configuredUrl };
};

const canReuseVector = (memory: CsyVectorMemory, choice: ModelChoice): boolean => {
    if (choice.provider === 'cohere') return false;
    if (choice.dimensions && memory.vector.length !== choice.dimensions) return false;
    if (!memory.modelId || !choice.model) return true;
    return normalizeModel(memory.modelId) === normalizeModel(choice.model);
};

const inferRoom = (memory: CsyVectorMemory): MemoryRoom => {
    if (memory.deprecated) return 'attic';
    const text = `${memory.title || ''} ${memory.content} ${memory.emotionalJourney || ''}`.toLowerCase();
    if (/计划|期待|希望|约定|目标|未来|想要/.test(text)) return 'windowsill';
    if (/学习|工作|考试|项目|技能|课程|论文|学校/.test(text)) return 'study';
    if (/用户|习惯|喜欢|讨厌|生日|家人|住在|职业/.test(text)) return 'user_room';
    if (/自我|身份|价值观|意识|成长|改变|反思/.test(text)) return 'self_room';
    if (/爱|亲密|想念|依恋|拥抱|亲吻|争吵|和好|难过|心痛/.test(text)) return 'bedroom';
    return 'living_room';
};

const inferMood = (memory: CsyVectorMemory): string => {
    const hormones = memory.hormoneSnapshot;
    if (!hormones) return memory.emotionalJourney ? 'emotional' : 'neutral';
    const candidates: Array<[string, number]> = [
        ['loving', finiteNumber(hormones.oxytocin, 0)],
        ['happy', Math.max(finiteNumber(hormones.dopamine, 0), finiteNumber(hormones.serotonin, 0), finiteNumber(hormones.endorphin, 0))],
        ['anxious', finiteNumber(hormones.cortisol, 0)],
        ['excited', finiteNumber(hormones.norepinephrine, 0)],
    ];
    candidates.sort((a, b) => b[1] - a[1]);
    return candidates[0][1] > 0 ? candidates[0][0] : 'neutral';
};

const makeNodeId = (memoryId: string): string => `csy_${memoryId}`;

const convertMemory = (
    memory: CsyVectorMemory,
    reusable: boolean,
): { node: MemoryNode; vector?: MemoryVector } => {
    const createdAt = finiteNumber(memory.createdAt, Date.now());
    const title = (memory.title || 'CSY 记忆').trim();
    // CSY 生成原向量时使用的正是 `${title}: ${content}`；保持一致才能无损复用。
    const content = `${title}: ${memory.content}`;
    const id = makeNodeId(memory.id);
    const node: MemoryNode = {
        id,
        charId: memory.charId,
        content,
        room: inferRoom(memory),
        tags: ['CSY迁移', title, memory.source ? `来源:${memory.source}` : '来源:未知'],
        importance: clampImportance(memory.importance),
        mood: inferMood(memory),
        embedded: reusable,
        createdAt,
        lastAccessedAt: finiteNumber(memory.lastMentioned, createdAt) || createdAt,
        accessCount: Math.max(0, Math.round(finiteNumber(memory.mentionCount, 0))),
        origin: memory.source === 'auto' ? 'extraction' : 'system',
        archived: memory.deprecated === true,
        legacyCsy: {
            originalId: memory.id,
            title,
            originalContent: memory.content,
            emotionalJourney: memory.emotionalJourney,
            source: memory.source,
            sourceMessageIds: memory.sourceMessageIds,
            deprecated: memory.deprecated,
            deprecatedReason: memory.deprecatedReason,
            hormoneSnapshot: memory.hormoneSnapshot,
            salienceScore: memory.salienceScore,
            updatedAt: memory.updatedAt,
            modelId: memory.modelId,
        },
    };

    if (!reusable) return { node };
    return {
        node,
        vector: {
            memoryId: id,
            charId: memory.charId,
            vector: memory.vector,
            dimensions: memory.vector.length,
            model: memory.modelId,
        },
    };
};

const maxMessageIdByCharacter = (messages: Message[] | undefined): Record<string, number> | undefined => {
    if (!Array.isArray(messages)) return undefined;
    const result: Record<string, number> = {};
    for (const message of messages) {
        if (!message || typeof message.charId !== 'string' || !Number.isFinite(message.id)) continue;
        result[message.charId] = Math.max(result[message.charId] || 0, message.id);
    }
    return Object.keys(result).length > 0 ? result : undefined;
};

export function inspectCsyBackup(input: unknown): CsyMigrationReport {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('文件不是有效的 CSY-OS 备份对象。');
    }
    const data = input as CsyBackupData;
    const characters = Array.isArray(data.characters) ? data.characters : [];
    const messages = Array.isArray(data.messages) ? data.messages : [];
    const rawMemories = Array.isArray(data.vectorMemories) ? data.vectorMemories : [];
    if (characters.length === 0 && messages.length === 0 && rawMemories.length === 0) {
        throw new Error('没有找到角色、聊天记录或 CSY 向量记忆；请确认选择的是 CSY-OS 导出的完整 ZIP/JSON。');
    }

    const valid = rawMemories.filter(isValidVectorMemory);
    const choice = chooseEmbedding(valid, data.extraLocalStorageConfig);
    const reusable = valid.filter(memory => canReuseVector(memory, choice)).length;
    const models = [...new Set(valid.map(memory => modelKey(memory.modelId, memory.vector.length)))].sort();
    const warnings: string[] = [];
    if (rawMemories.length !== valid.length) warnings.push(`${rawMemories.length - valid.length} 条损坏或空向量记忆将跳过。`);
    if (choice.provider === 'cohere' && valid.length > 0) warnings.push('CSY 使用 Cohere 文档/查询双模式；正文会保留，但向量需在 SullyOS 重新生成。');
    if (models.length > 1) warnings.push('备份包含多种向量模型或维度；仅与当前主模型一致的向量会直接复用。');
    if (valid.length === 0) warnings.push('备份中没有可转换的本地向量记忆；角色和聊天仍可迁移。');
    warnings.push('CSY 备份中的后端 token 与额外 API 密钥不会写入全局 localStorage。');

    return {
        characters: characters.length,
        messages: messages.length,
        vectorMemories: valid.length,
        reusableVectors: reusable,
        rebuildRequired: valid.length - reusable,
        deprecatedMemories: valid.filter(memory => memory.deprecated).length,
        skippedInvalidMemories: rawMemories.length - valid.length,
        embeddingModels: models,
        warnings,
    };
}

export function prepareCsyMigration(input: unknown): PreparedCsyMigration {
    const report = inspectCsyBackup(input);
    const source = input as CsyBackupData;
    const data = { ...source } as CsyBackupData;
    const rawMemories = Array.isArray(source.vectorMemories) ? source.vectorMemories : [];
    const valid = rawMemories.filter(isValidVectorMemory);
    const choice = chooseEmbedding(valid, source.extraLocalStorageConfig);
    const nodes: MemoryNode[] = [];
    const vectors: MemoryVector[] = [];

    for (const memory of valid) {
        const converted = convertMemory(memory, canReuseVector(memory, choice));
        nodes.push(converted.node);
        if (converted.vector) vectors.push(converted.vector);
    }

    const byCharacter = new Map<string, CsyVectorMemory[]>();
    for (const memory of valid) {
        const list = byCharacter.get(memory.charId) || [];
        list.push(memory);
        byCharacter.set(memory.charId, list);
    }

    if (Array.isArray(source.characters)) {
        data.characters = source.characters.map(raw => {
            const character = raw as CharacterProfile & Record<string, any>;
            const memories = byCharacter.get(character.id) || [];
            const dimensions = memories.find(memory => canReuseVector(memory, choice))?.vector.length;
            const migrated: CharacterProfile & Record<string, any> = {
                ...character,
                showThinkingChain: character.showThinkingChain ?? character.showThinking,
                memoryPalaceEnabled: memories.length > 0 ? character.vectorMemoryEnabled !== false : character.memoryPalaceEnabled,
            };
            if (choice.provider === 'openai' && choice.model && dimensions) {
                migrated.embeddingConfig = {
                    baseUrl: choice.baseUrl || 'https://api.siliconflow.cn/v1',
                    apiKey: choice.apiKey || '',
                    model: choice.model,
                    dimensions,
                };
            }
            return migrated;
        });
    }

    data.memoryNodes = nodes;
    data.memoryVectors = vectors;
    data.memoryLinks = [];
    data.topicBoxes = [];
    data.anticipations = [];
    data.eventBoxes = [];
    data.memoryBatches = [];
    data.memoryPalaceHighWaterMarks = maxMessageIdByCharacter(source.messages);

    if (choice.provider === 'openai' && choice.model && choice.dimensions) {
        const extra = source.extraLocalStorageConfig;
        const lightBaseUrl = extra?.sub_api_base_url || source.apiConfig?.baseUrl || '';
        const lightApiKey = extra?.sub_api_key || source.apiConfig?.apiKey || '';
        const lightModel = extra?.sub_api_model || source.apiConfig?.model || '';
        data.memoryPalaceConfig = {
            embedding: {
                baseUrl: choice.baseUrl || 'https://api.siliconflow.cn/v1',
                apiKey: choice.apiKey || '',
                model: choice.model,
                dimensions: choice.dimensions,
            },
            lightLLM: { baseUrl: lightBaseUrl, apiKey: lightApiKey, model: lightModel },
            rerank: {
                enabled: false,
                baseUrl: choice.baseUrl || 'https://api.siliconflow.cn/v1',
                apiKey: choice.apiKey || '',
                model: 'BAAI/bge-reranker-v2-m3',
                topN: 5,
            },
        };
    }

    // SullyOS 不认识这些 CSY 字段；转换完成后移除，避免给人“已经导入”的错觉。
    delete data.vectorMemories;
    delete data.extraLocalStorageConfig;

    return { data: data as FullBackupData, report };
}
