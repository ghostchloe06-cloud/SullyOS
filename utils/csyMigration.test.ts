import { describe, expect, it } from 'vitest';
import { inspectCsyBackup, prepareCsyMigration } from './csyMigration';

const sample = () => ({
    timestamp: 123,
    version: 2,
    characters: [{
        id: 'char-1', name: 'A', avatar: '', description: '', systemPrompt: '', memories: [],
        vectorMemoryEnabled: true, showThinking: true,
    }],
    messages: [
        { id: 1, charId: 'char-1', role: 'user', type: 'text', content: 'hello', timestamp: 10 },
        { id: 8, charId: 'char-1', role: 'assistant', type: 'text', content: 'world', timestamp: 20 },
    ],
    vectorMemories: [{
        id: 'vmem-1', charId: 'char-1', title: '雨天', content: '一起在雨里散步',
        emotionalJourney: '从局促到安心', importance: 8, mentionCount: 3,
        lastMentioned: 200, createdAt: 100, vector: [0.1, 0.2, 0.3],
        modelId: 'BAAI/bge-m3', source: 'auto', sourceMessageIds: [1, 8],
        hormoneSnapshot: { oxytocin: 0.9, cortisol: 0.1 },
    }],
    extraLocalStorageConfig: {
        embedding_provider: 'openai', embedding_model: 'BAAI/bge-m3',
        embedding_base_url: 'https://api.example/v1', embedding_api_key: 'secret',
        csyos_backend_token: 'do-not-restore',
    },
});

describe('CSY-OS migration', () => {
    it('previews counts and reusable vectors without mutating the source', () => {
        const source = sample();
        const report = inspectCsyBackup(source);
        expect(report).toMatchObject({
            characters: 1, messages: 2, vectorMemories: 1,
            reusableVectors: 1, rebuildRequired: 0, skippedInvalidMemories: 0,
        });
        expect(source.vectorMemories).toHaveLength(1);
    });

    it('converts CSY memory and keeps provenance while preserving embedding text', () => {
        const source = sample();
        const { data } = prepareCsyMigration(source);
        expect(data.memoryNodes).toHaveLength(1);
        expect(data.memoryVectors).toHaveLength(1);
        expect(data.memoryNodes![0]).toMatchObject({
            id: 'csy_vmem-1', charId: 'char-1', content: '雨天: 一起在雨里散步',
            importance: 8, accessCount: 3, lastAccessedAt: 200, embedded: true,
            legacyCsy: {
                originalId: 'vmem-1', title: '雨天', originalContent: '一起在雨里散步',
                emotionalJourney: '从局促到安心', sourceMessageIds: [1, 8], modelId: 'BAAI/bge-m3',
            },
        });
        expect(data.memoryVectors![0]).toMatchObject({
            memoryId: 'csy_vmem-1', charId: 'char-1', dimensions: 3, model: 'BAAI/bge-m3',
            vector: [0.1, 0.2, 0.3],
        });
        expect((data.characters![0] as any).memoryPalaceEnabled).toBe(true);
        expect((data.characters![0] as any).showThinkingChain).toBe(true);
        expect((data.characters![0] as any).embeddingConfig).toEqual({
            baseUrl: 'https://api.example/v1', apiKey: 'secret', model: 'BAAI/bge-m3', dimensions: 3,
        });
        expect(data.memoryPalaceConfig).toMatchObject({
            embedding: { baseUrl: 'https://api.example/v1', apiKey: 'secret', model: 'BAAI/bge-m3', dimensions: 3 },
            rerank: { enabled: false },
        });
        expect(data.memoryPalaceHighWaterMarks).toEqual({ 'char-1': 8 });
        expect((data as any).vectorMemories).toBeUndefined();
        expect((data as any).extraLocalStorageConfig).toBeUndefined();
        expect(source.vectorMemories).toHaveLength(1);
    });

    it('keeps Cohere memory text but requires re-embedding', () => {
        const source = sample();
        source.extraLocalStorageConfig.embedding_provider = 'cohere';
        source.extraLocalStorageConfig.embedding_model = 'embed-v4.0';
        source.vectorMemories[0].modelId = 'embed-v4.0';
        const { data, report } = prepareCsyMigration(source);
        expect(report.reusableVectors).toBe(0);
        expect(report.rebuildRequired).toBe(1);
        expect(data.memoryNodes![0].embedded).toBe(false);
        expect(data.memoryVectors).toEqual([]);
        expect((data.characters![0] as any).embeddingConfig).toBeUndefined();
    });

    it('does not reuse vectors with a mismatched dimension', () => {
        const source = sample() as any;
        source.vectorMemories.push({
            ...source.vectorMemories[0], id: 'vmem-2', vector: [0.1, 0.2], createdAt: 101,
        });
        const { data, report } = prepareCsyMigration(source);
        expect(report.reusableVectors).toBe(1);
        expect(report.rebuildRequired).toBe(1);
        expect(data.memoryNodes).toHaveLength(2);
        expect(data.memoryVectors).toHaveLength(1);
        expect(data.memoryNodes!.find((node: any) => node.id === 'csy_vmem-2')?.embedded).toBe(false);
    });

    it('treats SiliconFlow Pro/ model aliases as the same embedding model', () => {
        const source = sample();
        source.extraLocalStorageConfig.embedding_model = 'Pro/BAAI/bge-m3';
        const { report } = prepareCsyMigration(source);
        expect(report.reusableVectors).toBe(1);
        expect(report.rebuildRequired).toBe(0);
    });

    it('skips invalid vectors and rejects unrelated empty data', () => {
        const source = sample() as any;
        source.vectorMemories.push({ id: 'bad', charId: 'char-1', content: 'bad', vector: [1, NaN] });
        const { data, report } = prepareCsyMigration(source);
        expect(report.skippedInvalidMemories).toBe(1);
        expect(data.memoryNodes).toHaveLength(1);
        expect(() => inspectCsyBackup({ version: 2 })).toThrow(/没有找到/);
    });
});
