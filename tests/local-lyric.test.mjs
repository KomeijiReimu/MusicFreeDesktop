// Pure logic: use the existing in-memory TypeScript harness pattern, without Electron/audio.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const music = { platform: 'local', id: 'song', title: 'Song', localPath: '/music/song.mp3' };
const lyric = (text) => ({ rawLrc: `[00:01]${text}` });

function load(relativePath, dependencies) {
    const filename = path.join(root, relativePath);
    const { outputText, diagnostics } = ts.transpileModule(readFileSync(filename, 'utf8'), {
        compilerOptions: {
            module: ts.ModuleKind.CommonJS,
            target: ts.ScriptTarget.ES2022,
            esModuleInterop: true,
        },
        reportDiagnostics: true,
    });
    assert.equal(diagnostics.length, 0, filename);
    const module = { exports: {} };
    new Function('require', 'module', 'exports', 'console', outputText)(
        (name) => (Object.hasOwn(dependencies, name) ? dependencies[name] : require(name)),
        module,
        module.exports,
        { ...console, error: (...args) => dependencies.errors?.push(args) },
    );
    return module.exports;
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}

function adapterHarness() {
    const env = {
        files: new Map(),
        errors: [],
        parsed: [],
        pluginCalls: [],
        remoteCalls: [],
        embedded: lyric('embedded'),
        plugin: lyric('plugin'),
    };
    const { getLyricAdapter } = load('src/infra/pluginManager/main/getLyricAdapter.ts', {
        errors: env.errors,
        fs: {
            statSync(filePath) {
                if (env.statError) throw env.statError;
                if (!env.files.has(filePath))
                    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
                return { isFile: () => true };
            },
            readFileSync(filePath) {
                if (env.readError) throw env.readError;
                return env.files.get(filePath);
            },
        },
        '@common/mediaKey': { isSameMedia: (a, b) => a.platform === b.platform && a.id === b.id },
        '@infra/localMusic/common/parseAudioMeta': {
            async parseAudioMeta(filePath) {
                env.parsed.push(filePath);
                if (env.parseError) throw env.parseError;
                return env.embedded;
            },
        },
        axios: {
            async get(url) {
                env.remoteCalls.push(url);
                return { data: lyric('remote').rawLrc };
            },
        },
    });
    env.get = (source, item = music) =>
        getLyricAdapter(
            { musicItem: item, source },
            async (params) => {
                env.pluginCalls.push(params);
                return env.plugin;
            },
            {
                getDownloadData: () => env.download,
                getAssociatedLyric: () => env.associated,
                setMeta: () => assert.fail('explicit reads must not change associations'),
            },
            { getRawMusicItem: () => env.rawItem },
        );
    return env;
}

test('auto preserves association > rawLrc > sibling > plugin > remote; explicit sources override', async () => {
    const env = adapterHarness();
    env.files.set('/music/song.lrc', lyric('file').rawLrc);
    env.files.set('/music/song-tr.lrc', lyric('translation').rawLrc);
    const item = { ...music, ...lyric('cached'), lrc: 'https://lyrics.test/song' };
    env.associated = { musicItem: { platform: 'linked', id: 'other' }, ...lyric('associated') };
    assert.equal((await env.get(undefined, item)).rawLrc, lyric('associated').rawLrc);
    assert.equal((await env.get('auto', item)).rawLrc, lyric('associated').rawLrc);
    assert.equal((await env.get('file', item)).rawLrc, lyric('file').rawLrc);
    assert.equal((await env.get('file', item)).translation, lyric('translation').rawLrc);
    assert.deepEqual(await env.get('embedded', item), lyric('embedded'));
    env.associated = null;
    assert.equal((await env.get(undefined, item)).rawLrc, lyric('cached').rawLrc);
    delete item.rawLrc;
    assert.equal((await env.get(undefined, item)).rawLrc, lyric('file').rawLrc);
    env.files.clear();
    assert.equal((await env.get(undefined, item)).rawLrc, lyric('plugin').rawLrc);
    env.plugin = null;
    assert.equal((await env.get(undefined, item)).rawLrc, lyric('remote').rawLrc);
});

test('file extensions retain priority and -tr matching; missing explicit source never falls back', async () => {
    const env = adapterHarness();
    env.associated = { ...lyric('associated') };
    const item = { ...music, ...lyric('cached'), lrc: 'https://lyrics.test/song' };
    assert.equal(await env.get('file', item), null);
    env.embedded = {};
    assert.equal(await env.get('embedded', item), null);
    assert.equal(await env.get('embedded', { platform: 'online', id: 'missing' }), null);
    assert.equal(env.pluginCalls.length, 0);
    assert.equal(env.remoteCalls.length, 0);
    for (const ext of ['.txt', '.LRC', '.lrc']) {
        env.files.set(`/music/song${ext}`, lyric(ext).rawLrc);
        env.files.set(`/music/song-tr${ext}`, lyric(`translation ${ext}`).rawLrc);
        assert.equal((await env.get('file')).rawLrc, lyric(ext).rawLrc);
        assert.equal((await env.get('file')).translation, lyric(`translation ${ext}`).rawLrc);
    }
});

test('download path works without local-library rows, then full localPath and slim raw fallback', async () => {
    const env = adapterHarness();
    env.download = { path: '/downloads/song.flac' };
    env.files.set('/downloads/song.lrc', lyric('download').rawLrc);
    env.rawItem = { localPath: '/raw/song.mp3' };
    const slim = { platform: 'online', id: 'downloaded', $slim: true };
    assert.equal((await env.get('file', slim)).rawLrc, lyric('download').rawLrc);
    await env.get('embedded', slim);
    env.download = null;
    await env.get('embedded');
    await env.get('embedded', slim);
    assert.deepEqual(env.parsed, ['/downloads/song.flac', '/music/song.mp3', '/raw/song.mp3']);
});

test('explicit stat/read/parse failures reject with original error and diagnostics', async () => {
    const env = adapterHarness();
    env.files.set('/music/song.lrc', lyric('file').rawLrc);
    for (const [property, source] of [
        ['statError', 'file'],
        ['readError', 'file'],
        ['parseError', 'embedded'],
    ]) {
        const error = Object.assign(new Error(property), { code: 'EACCES' });
        env[property] = error;
        await assert.rejects(env.get(source), (actual) => actual === error);
        assert.equal(env.errors.at(-1).at(-1), error);
        delete env[property];
    }
});

function managerHarness() {
    const env = { errors: [], calls: [], meta: {}, values: new Map() };
    const atoms = Object.fromEntries(
        [
            'currentMusicAtom',
            'currentLyricAtom',
            'progressAtom',
            'associatedLyricAtom',
            'playerStateAtom',
            'sourceInfoAtom',
        ].map((key) => [key, key]),
    );
    const storeModule = {
        ...atoms,
        store: {
            get: (key) => env.values.get(key),
            set: (key, value) => env.values.set(key, value),
        },
    };
    env.values.set(atoms.progressAtom, { currentTime: 42, duration: 200 });
    env.mediaMeta = {
        getMeta: async () => env.meta,
        async setMeta(_platform, _id, patch) {
            for (const [key, value] of Object.entries(patch)) {
                if (value === null) delete env.meta[key];
                else env.meta[key] = value;
            }
        },
    };
    const LyricManager = load('src/renderer/mainWindow/core/trackPlayer/lyricManager.ts', {
        errors: env.errors,
        '@common/lyricParser': class {
            constructor(text) {
                this.text = text;
            }
            getPosition(time) {
                return { index: 0, time, text: this.text };
            }
        },
        '@infra/mediaMeta/renderer': env.mediaMeta,
        '@infra/pluginManager/renderer': {
            adapters: {
                async getLyric(item, source) {
                    env.calls.push([item, source]);
                    return env.fetch ? env.fetch(item, source) : lyric(source ?? 'auto');
                },
            },
        },
        './store': storeModule,
    }).default;
    env.manager = new LyricManager();
    env.current = () => env.values.get(atoms.currentLyricAtom);
    env.associated = () => env.values.get(atoms.associatedLyricAtom);
    env.player = () => {
        const dependencies = Object.fromEntries(
            [
                '@common/constant',
                '@common/mediaKey',
                '@common/musicItemToSlim',
                '@common/delay',
                '@common/throttle',
                '@infra/musicSheet/renderer',
                '@infra/pluginManager/renderer',
                '@infra/appConfig/renderer',
                '@infra/downloadManager/renderer',
                '@infra/localMusic/renderer',
                '@infra/fsUtil/renderer',
                '../recentlyPlayed',
                '@infra/appSync/renderer/main',
                '@renderer/common/kvStore',
                './audioController',
                './playQueue',
                './lyricManager',
            ].map((name) => [name, {}]),
        );
        const player = load('src/renderer/mainWindow/core/trackPlayer/index.ts', {
            ...dependencies,
            './store': storeModule,
        }).default;
        player.lyricManager = env.manager;
        // Any audio access during a preference refresh is a regression.
        player.audioController = new Proxy(
            {},
            { get: () => assert.fail('lyric refresh touched audio') },
        );
        env.values.set(atoms.currentMusicAtom, music);
        return player;
    };
    return env;
}

test('persisted per-track preference is passed on lyric-only refresh, auto deletes field', async () => {
    const env = managerHarness();
    const player = env.player();
    const progress = env.values.get('progressAtom');
    env.values.set('sourceInfoAtom', { url: 'file:///music/song.mp3' });
    env.values.set('playerStateAtom', 'paused');
    const source = env.values.get('sourceInfoAtom');
    for (const preference of ['file', 'embedded', null]) {
        await env.mediaMeta.setMeta(music.platform, music.id, { localLyricSource: preference });
        await player.refreshLyric();
        assert.equal(env.calls.at(-1)[1], preference ?? undefined);
        assert.equal(env.current().parser.text, lyric(preference ?? 'auto').rawLrc);
        assert.equal(env.values.get('progressAtom'), progress);
        assert.equal(env.values.get('sourceInfoAtom'), source);
        assert.equal(env.values.get('playerStateAtom'), 'paused');
    }
    assert.equal(Object.hasOwn(env.meta, 'localLyricSource'), false);
});

test('same-song overlapping getMeta cannot replace newer offset, association or parser', async () => {
    const env = managerHarness();
    const first = deferred();
    env.mediaMeta.getMeta = () => first.promise;
    const old = env.manager.fetchLyric(music);
    const linked = { platform: 'linked', id: 'new' };
    env.mediaMeta.getMeta = async () => ({
        localLyricSource: 'embedded',
        lyricOffset: 3,
        associatedLyric: { musicItem: linked },
    });
    await env.manager.refreshLyric(music);
    first.resolve({
        localLyricSource: 'file',
        lyricOffset: 99,
        associatedLyric: { musicItem: music },
    });
    await old;
    assert.equal(env.calls.length, 1);
    assert.equal(env.manager.getUserOffset(), 3);
    assert.equal(env.associated(), linked);
    assert.equal(env.current().parser.text, lyric('embedded').rawLrc);
    assert.equal(env.current().currentLrc.time, 45);
});

test('same-song lyric completion/error and reset invalidate the whole earlier async chain', async () => {
    for (const reject of [false, true]) {
        const env = managerHarness();
        const first = deferred();
        const entered = deferred();
        env.fetch = () => {
            entered.resolve();
            return first.promise;
        };
        const old = env.manager.fetchLyric(music);
        await entered.promise;
        env.fetch = () => lyric('latest');
        await env.manager.refreshLyric(music);
        if (reject) first.reject(new Error('stale'));
        else first.resolve(lyric('stale'));
        await old;
        assert.equal(env.current().parser.text, lyric('latest').rawLrc);
    }
    for (const phase of ['meta', 'lyric']) {
        const env = managerHarness();
        const pending = deferred();
        const entered = deferred();
        if (phase === 'meta') env.mediaMeta.getMeta = () => pending.promise;
        else
            env.fetch = () => {
                entered.resolve();
                return pending.promise;
            };
        const old = env.manager.fetchLyric(music);
        if (phase === 'lyric') await entered.promise;
        env.manager.reset();
        pending.resolve(
            phase === 'meta'
                ? { lyricOffset: 99, associatedLyric: { musicItem: music } }
                : lyric('stale'),
        );
        await old;
        assert.equal(env.current(), null);
        assert.equal(env.associated(), null);
        assert.equal(env.manager.getUserOffset(), 0);
    }
});

test('current metadata/lyric failures remain rejected and logged for UI handling', async () => {
    for (const phase of ['meta', 'lyric']) {
        const env = managerHarness();
        const error = new Error(`${phase} failed`);
        if (phase === 'meta')
            env.mediaMeta.getMeta = async () => {
                throw error;
            };
        else
            env.fetch = async () => {
                throw error;
            };
        await assert.rejects(env.manager.refreshLyric(music), (actual) => actual === error);
        assert.equal(env.errors.at(-1).at(-1), error);
        assert.equal(env.current(), null);
    }
});
