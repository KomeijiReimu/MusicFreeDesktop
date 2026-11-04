import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire, registerHooks } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAudioMeta } from '../src/infra/localMusic/common/parseAudioMeta.ts';

// Node 直接加载 TS 时，补齐 writer 中这一个无扩展名的相对导入。
const writerURL = new URL('../src/infra/localMusic/main/metadataWriter.ts', import.meta.url).href;
const parserURL = new URL('../src/infra/localMusic/common/parseAudioMeta.ts', import.meta.url).href;
const resolver = registerHooks({
    resolve(specifier, context, nextResolve) {
        if (context.parentURL === writerURL && specifier === '../common/parseAudioMeta') {
            return nextResolve(parserURL, context);
        }
        return nextResolve(specifier, context);
    },
});
const { writeFileTags } = await import(writerURL);
resolver.deregister();

const temporaryRoot = fileURLToPath(new URL('../.cache/tests/', import.meta.url));
await mkdir(temporaryRoot, { recursive: true });
const directory = await mkdtemp(path.join(temporaryRoot, 'local-metadata-'));
after(() => rm(directory, { recursive: true, force: true }));

// 80 个单声道 PCM 样本：8000 Hz、16 bit、0.01 秒。
const wav = Buffer.alloc(44 + 160);
wav.write('RIFF', 0);
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24);
wav.writeUInt32LE(16000, 28);
wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(160, 40);

test('真实 WAV 格式值、并发去重与缓存复用', async () => {
    const filePath = path.join(directory, 'tone.wav');
    await writeFile(filePath, wav);
    const [first, second] = await Promise.all([parseAudioMeta(filePath), parseAudioMeta(filePath)]);
    assert.deepEqual(first.format, {
        codec: 'PCM',
        container: 'WAVE',
        lossless: true,
        bitrate: 128000,
        sampleRate: 8000,
        bitsPerSample: 16,
        numberOfChannels: 1,
        duration: 0.01,
    });
    assert.equal(first, second);
    assert.equal(await parseAudioMeta(filePath, { skipCovers: true, skipLyrics: true }), first);
});

test('解析失败不缓存，修复文件后相同指纹可重试', async () => {
    const filePath = path.join(directory, 'repaired.bin');
    const options = { fileInfo: { size: wav.length, mtime: 1 } };
    await writeFile(filePath, Buffer.alloc(wav.length));
    await assert.rejects(parseAudioMeta(filePath, options));
    await writeFile(filePath, wav);
    assert.equal((await parseAudioMeta(filePath, options)).format.sampleRate, 8000);
});

test('真实标签写入使已有解析缓存失效', async () => {
    const filePath = path.join(directory, 'tagged.mp3');
    // 两个 MPEG-1 Layer III 帧，128 kbit/s、44100 Hz；无需启动音频设备。
    const frame = Buffer.alloc(417);
    frame.set([0xff, 0xfb, 0x90, 0x64]);
    await writeFile(filePath, Buffer.concat([frame, frame]));
    const before = await parseAudioMeta(filePath);
    await writeFileTags(filePath, { title: 'Updated title', artist: 'Artist', album: 'Album' });
    // 故意沿用写入前指纹，确认是 writer 显式失效，而非仅靠 stat 变化。
    const afterWrite = await parseAudioMeta(filePath, {
        fileInfo: { size: before.fileSize, mtime: before.fileMtime },
    });
    assert.notEqual(afterWrite, before);
    assert.equal(afterWrite.title, 'Updated title');
});

test('详情只补齐同一文件的已知格式，不覆盖扫描得到的时长', async () => {
    // 隔离 Electron/数据库入口，执行实际主进程 IPC handler，不启动应用。
    const require = createRequire(import.meta.url);
    const ts = require('typescript');
    const source = await readFile(
        new URL('../src/infra/localMusic/main/index.ts', import.meta.url),
        'utf8',
    );
    const compiled = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
    }).outputText;
    const handlers = new Map();
    const meta = {
        fileSize: 100,
        fileMtime: 12.5,
        format: { duration: undefined, sampleRate: 96000, lossless: false, bitrate: 0 },
        common: {},
        native: {},
    };
    const dependencies = {
        electron: { ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) } },
        nanoid: {},
        '@common/constant': {},
        '../common/constant': { IPC: { GET_METADATA: 'metadata' } },
        './scanner': {},
        './metadataParser': {},
        './metadataWriter': {},
        './pathImport': {},
        '../common/parseAudioMeta': {
            parseAudioMeta: async (_filePath, options) => {
                assert.equal(options.includeDetails, true);
                assert.notEqual(options.duration, true);
                return meta;
            },
        },
    };
    const module = { exports: {} };
    new Function('require', 'module', 'exports', compiled)(
        (name) => (Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)),
        module,
        module.exports,
    );
    const manager = module.exports.default;
    let saved;
    manager.queries = {
        getFileMetadata: {
            get: () => ({
                title: 'Library title',
                artist: '',
                album: '',
                formatSize: 100,
                formatMtime: 12.5,
                audioFormat: JSON.stringify({
                    duration: 123.5,
                    sampleRate: 48000,
                    lossless: true,
                    bitrate: 128000,
                }),
            }),
        },
        updateAudioFormat: {
            run: (value) => {
                saved = JSON.parse(value.audioFormat);
            },
        },
    };
    manager.registerIpcHandlers();
    const getMetadata = handlers.get('metadata');
    const result = await getMetadata(null, path.join(directory, 'vbr.mp3'));
    assert.deepEqual(result.format, {
        duration: 123.5,
        sampleRate: 96000,
        lossless: false,
        bitrate: 0,
    });
    assert.deepEqual(saved, result.format);
    assert.equal(meta.format.duration, undefined, '不修改共享解析缓存');
    for (const fingerprint of [
        { fileSize: 101, fileMtime: 12.5 },
        { fileSize: 100, fileMtime: 13 },
    ]) {
        Object.assign(meta, fingerprint);
        assert.equal(
            (await getMetadata(null, path.join(directory, 'vbr.mp3'))).format.duration,
            undefined,
        );
        assert.equal(Object.hasOwn(saved, 'duration'), false);
    }
});
