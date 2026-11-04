// Pure logic only: transpile project TypeScript in memory; no Electron, network or audio.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const queuePath = 'src/renderer/mainWindow/core/trackPlayer/playQueue.ts';
const playerPath = 'src/renderer/mainWindow/core/trackPlayer/index.ts';
const music = (id) => ({ platform: 'test', id, title: id, artist: 'Artist' });
const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(music);
const ids = (queue) => Array.from(queue.queue, (item) => item.id);

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function harness(random = () => 0) {
    const storage = new Map();
    const values = new Map();
    const atoms = Object.fromEntries(
        [
            'musicQueueAtom',
            'currentMusicAtom',
            'playerStateAtom',
            'repeatModeAtom',
            'progressAtom',
            'volumeAtom',
            'speedAtom',
            'qualityAtom',
            'sourceInfoAtom',
            'currentLyricAtom',
        ].map((name) => [name, name]),
    );
    const store = {
        get: (key) => values.get(key),
        set: (key, value) => values.set(key, value),
        sub: () => {},
    };
    const syncKV = {
        get: (key) => JSON.parse(storage.get(key) ?? 'null'),
        set: (key, value) => storage.set(key, JSON.stringify(value)),
        remove: (key) => storage.delete(key),
    };
    const env = {
        db: [],
        writes: [],
        storage,
        syncKV,
        store,
        atoms,
        config: new Map(),
        errors: [],
        requestedQualities: [],
        audioInfoPaths: [],
        decodedUrls: [],
        mediaSource: { url: 'https://example.test/audio' },
        audioFormat: { codec: 'FLAC', sampleRate: 44100, bitsPerSample: 16 },
    };
    const bridge = {
        getAll: async () => env.db,
        set: async (items) => {
            env.writes.push(Array.from(items, (item) => item.id));
        },
        add: async () => {},
        remove: async () => {},
        clear: async () => {},
    };
    const mocks = {
        './store': { store, ...atoms },
        '@renderer/common/kvStore': { syncKV },
        '@infra/musicSheet/renderer': {
            __esModule: true,
            default: {
                getRawMusicItem: async () => null,
                isFavoriteMusic: () => false,
                subscribeFavoriteChange() {},
            },
            playQueueBridge: bridge,
        },
        '@common/delay': async () => {},
        '@common/throttle': (callback) => callback,
        '@infra/pluginManager/renderer': {
            callPluginMethod: async () => {
                if (env.enrichmentError) throw env.enrichmentError;
                return env.musicInfoPromise ?? null;
            },
            getPluginByPlatform: () => ({ hash: 'mock' }),
            adapters: {
                getMediaSource: async ({ quality }) => {
                    env.requestedQualities.push(quality);
                    return env.mediaSource
                        ? { ...env.mediaSource, quality: env.mediaSource.quality ?? quality }
                        : null;
                },
            },
        },
        '@infra/appConfig/renderer': {
            getConfigByKey: (key) => env.config.get(key),
            onConfigUpdated() {},
        },
        '@infra/downloadManager/renderer': {
            isDownloaded: () => env.download,
            removeDownload: async () => {},
        },
        '@infra/fsUtil/renderer': {
            isFile: async () => true,
            addFileScheme: (filePath) => pathToFileURL(filePath).href,
            fileUrlToPath: (url) => {
                env.decodedUrls.push(url);
                return env.decodedPath ?? fileURLToPath(url);
            },
        },
        '@infra/localMusic/renderer': {
            getAudioInfo: async (filePath) => {
                env.audioInfoPaths.push(filePath);
                if (env.metadataError) throw env.metadataError;
                return env.audioFormat;
            },
        },
        '@infra/appSync/renderer/main': { syncAppState() {}, onSubscribe() {}, onCommand() {} },
        '../recentlyPlayed': { addToRecentlyPlayed: async () => {} },
        './audioController': { createAudioController: () => env.audio },
        './lyricManager': class {
            fetchLyric() {}
            reset() {}
        },
    };
    const modules = new Map();
    function load(relativePath) {
        const filename = path.resolve(root, relativePath);
        if (modules.has(filename)) return modules.get(filename);
        const source = readFileSync(filename, 'utf8');
        const { outputText, diagnostics } = ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2021,
                esModuleInterop: true,
            },
            reportDiagnostics: true,
        });
        assert.equal(diagnostics.length, 0, filename);
        const exports = {};
        modules.set(filename, exports);
        vm.runInNewContext(
            outputText,
            {
                exports,
                require: (name) => {
                    if (Object.hasOwn(mocks, name)) return mocks[name];
                    if (name.startsWith('@common/')) return load(`src/common/${name.slice(8)}.ts`);
                    if (name.startsWith('.'))
                        return load(path.resolve(path.dirname(filename), `${name}.ts`));
                    throw new Error(`Unexpected dependency: ${name}`);
                },
                localStorage: {
                    getItem: (key) => storage.get(key) ?? null,
                    setItem: (key, value) => storage.set(key, value),
                    removeItem: (key) => storage.delete(key),
                },
                console: { ...console, error: (...args) => env.errors.push(args) },
                window: { addEventListener() {} },
                navigator: {
                    mediaSession: { setActionHandler() {} },
                    mediaDevices: { addEventListener() {} },
                },
            },
            { filename },
        );
        return exports;
    }
    env.Queue = load(queuePath).default;
    env.queue = new env.Queue(random);
    env.constants = load('src/common/constant.ts');
    env.player = ({ resolveSources = false } = {}) => {
        const player = load(playerPath).default;
        const audio = Object.assign(new EventEmitter(), {
            hasSource: true,
            seeks: [],
            plays: 0,
            pauses: 0,
            sources: [],
            playerState: env.constants.PlayerState.Playing,
            seekTo(seconds) {
                this.seeks.push(seconds);
            },
            play() {
                this.plays++;
                this.playerState = env.constants.PlayerState.Playing;
            },
            pause() {
                this.pauses++;
                this.playerState = env.constants.PlayerState.Paused;
            },
            prepareTrack() {
                this.hasSource = false;
                this.playerState = env.constants.PlayerState.None;
            },
            setTrackSource(source) {
                this.sources.push(source);
                this.hasSource = true;
                this.playerState = env.constants.PlayerState.None;
            },
            setVolume() {},
            setSpeed() {},
            setSinkId: async () => {},
            updateMetadata(item) {
                this.metadata = item;
            },
            reset() {
                this.hasSource = false;
                this.playerState = env.constants.PlayerState.None;
            },
        });
        env.audio = audio;
        player.playQueue = env.queue;
        player.audioController = audio;
        player.lyricManager = { fetchLyric() {}, reset() {} };
        if (!resolveSources) {
            player.resolveSource = async () => ({
                source: { url: 'mock:audio', quality: 'standard' },
                sourceInfo: { isLocal: false },
            });
        }
        store.set(atoms.currentMusicAtom, env.queue.getCurrentMusic());
        store.set(atoms.repeatModeAtom, env.constants.RepeatMode.Random);
        store.set(atoms.qualityAtom, 'standard');
        store.set(atoms.sourceInfoAtom, { isLocal: false });
        store.set(atoms.playerStateAtom, env.constants.PlayerState.Playing);
        store.set(atoms.progressAtom, { currentTime: 12, duration: 120 });
        return { player, audio };
    };
    return env;
}

test('Shuffle: one permutation, displayed indexes are navigation indexes, DB order stays intact', () => {
    const env = harness(() => 0.25);
    const q = env.queue;
    q.setQueue([a, b, c, d], { playIndex: 1 });
    q.enterShuffle();
    const order = ids(q);
    assert.equal(order[0], 'b');
    assert.deepEqual(env.writes[0], ['a', 'b', 'c', 'd']);
    assert.equal(env.store.get(env.atoms.musicQueueAtom), q.queue);
    const visited = [q.getCurrentMusic().id];
    for (let i = 1; i < order.length; i++) {
        const index = q.getNextIndex();
        assert.equal(index, i);
        q.setCurrentIndex(index);
        visited.push(q.getCurrentMusic().id);
    }
    assert.deepEqual(visited, order);
    assert.equal(new Set(visited).size, 4);
    assert.equal(q.getNextIndex(), 0);
    q.setCurrentIndex(2);
    assert.equal(q.getCurrentMusic().id, order[2]);
    assert.equal(q.findIndex(music(order[2])), 2);
    q.exitShuffle();
    assert.deepEqual(ids(q), ['a', 'b', 'c', 'd']);
    assert.equal(q.queue[q.getCurrentIndex()].id, order[2]);
});

test('Shuffle: restore reconciles keys after DB reorder/deletion/addition; invalid versions regenerate', async () => {
    const env = harness();
    const q = env.queue;
    q.setQueue([a, b, c, d], { playIndex: 0 });
    q.enterShuffle();
    q.setCurrentIndex(q.findIndex(b));
    env.syncKV.set('player.currentMusic', b);
    const saved = JSON.parse(env.storage.get('player.shuffleOrder'));
    assert.equal(saved.version, 1);
    assert.equal(saved.keys[saved.cursor], 'test\0b');
    env.db = [d, b, a, music('new')];
    const restored = new env.Queue(() => 0);
    await restored.setup();
    restored.enterShuffle(true);
    const expected = saved.keys.filter((key) => key !== 'test\0c').map((key) => key.split('\0')[1]);
    assert.deepEqual(ids(restored), [...expected, 'new']);
    assert.equal(restored.queue[restored.getCurrentIndex()].id, 'b');
    assert.equal(
        restored.queue[restored.getNextIndex()].id,
        ids(restored)[(restored.getCurrentIndex() + 1) % 4],
    );
    env.storage.set(
        'player.shuffleOrder',
        JSON.stringify({ version: 99, keys: ['missing'], cursor: 0 }),
    );
    const invalid = new env.Queue(() => 0);
    await invalid.setup();
    invalid.enterShuffle(true);
    assert.equal(invalid.queue[0].id, 'b');
    assert.equal(new Set(ids(invalid)).size, env.db.length);
});

test('Shuffle: insertion, append and deletion retain displayed successor and current identity', () => {
    const { queue: q } = harness();
    q.setQueue([a, b, c, d], { playIndex: 0 });
    q.enterShuffle();
    q.addNext([d, d]);
    assert.equal(q.queue[q.getNextIndex()].id, 'd');
    q.setCurrentIndex(q.getNextIndex());
    const successor = q.queue[q.getNextIndex()];
    q.remove(d);
    assert.equal(q.getCurrentIndex(), -1);
    assert.equal(q.queue[q.getNextIndex()].id, successor.id);
    q.setCurrentIndex(q.getNextIndex());
    const current = q.getCurrentMusic().id;
    q.append([music('new'), a, music('new')]);
    assert.equal(new Set(ids(q)).size, q.queue.length);
    assert.equal(q.getCurrentMusic().id, current);
    q.clear();
    assert.deepEqual(ids(q), []);
    q.setQueue([d, c], { playIndex: 1 });
    assert.deepEqual(ids(q), ['c', 'd']);
});

test('Random: repeated draws are real history; back/forward does not draw; history is bounded', () => {
    let draws = 0;
    const { queue: q } = harness(() => {
        draws++;
        return 0;
    });
    q.setQueue([a, b, c], { playIndex: 0 });
    q.enterRandom();
    q.setCurrentIndex(q.getNextIndex());
    assert.equal(q.getCurrentMusic().id, 'a');
    q.setCurrentIndex(q.getPrevIndex());
    assert.equal(q.getPrevIndex(), -1);
    q.setCurrentIndex(q.getNextIndex());
    assert.equal(draws, 1);
    for (let i = 0; i < 205; i++) q.setCurrentIndex(q.getNextIndex());
    let steps = 0;
    while (q.getPrevIndex() >= 0) {
        q.setCurrentIndex(q.getPrevIndex());
        steps++;
    }
    assert.equal(steps, 199);
});

test('Random: priority insertion, new candidates, manual branching and removed history', () => {
    const { queue: q } = harness(() => 0.99);
    q.setQueue([a, b, c], { playIndex: 0 });
    q.enterRandom();
    q.setCurrentIndex(q.getNextIndex()); // a -> c
    q.setCurrentIndex(q.getPrevIndex()); // a
    q.addNext([d, b]);
    q.setCurrentIndex(q.getNextIndex());
    assert.equal(q.getCurrentMusic().id, 'd');
    q.setCurrentIndex(q.getNextIndex());
    assert.equal(q.getCurrentMusic().id, 'b');
    q.setCurrentIndex(q.getPrevIndex());
    assert.equal(q.getCurrentMusic().id, 'd');
    q.setCurrentIndex(q.findIndex(c)); // manual selection branches history
    q.remove([a, d]);
    assert.equal(q.getPrevIndex(), -1);
    q.append([music('new')]);
    q.setCurrentIndex(q.getNextIndex());
    assert.equal(q.getCurrentMusic().id, 'new');
    q.remove(music('new'));
    q.setCurrentIndex(q.getNextIndex());
    assert.ok(['b', 'c'].includes(q.getCurrentMusic().id));
    q.addNext([q.getCurrentMusic()]);
    assert.equal(q.getNextIndex(), q.getCurrentIndex());
    const excluded = q.getCurrentMusic();
    assert.notEqual(q.queue[q.getNextIndex(excluded)].id, excluded.id);
});

test('Random: restore seeds current track; mode changes, replacement and clear reset history', async () => {
    const env = harness();
    env.db = [a, b];
    env.syncKV.set('player.currentMusic', b);
    const q = env.queue;
    await q.setup();
    q.enterRandom();
    assert.equal(q.getCurrentMusic().id, 'b');
    assert.equal(q.getPrevIndex(), -1);
    q.setCurrentIndex(q.getNextIndex());
    q.enterShuffle();
    assert.equal(q.isRandomActive, false);
    q.enterRandom();
    assert.equal(q.isShuffleActive, false);
    assert.equal(q.getPrevIndex(), -1);
    q.setQueue([c, d], { playIndex: 1 });
    assert.equal(q.getCurrentMusic().id, 'd');
    assert.equal(q.getPrevIndex(), -1);
    q.clear();
    assert.equal(q.getNextIndex(), -1);
    assert.equal(q.getPrevIndex(), -1);
    q.setQueue([a], { playIndex: 0 });
    assert.equal(q.getNextIndex(a), -1);
});

test('TrackPlayer: Random next and natural end restart same song at zero and record navigation', async () => {
    const env = harness();
    env.queue.setQueue([a, b], { playIndex: 0 });
    env.queue.enterRandom();
    const { player, audio } = env.player();
    await player.skipToNext();
    await player.advanceAfterCompletion();
    assert.deepEqual(audio.seeks, [0, 0]);
    assert.equal(audio.plays, 2);
    await player.skipToPrev();
    await player.skipToPrev();
    assert.equal(env.queue.getPrevIndex(), -1);
    assert.equal(audio.plays, 4);
    await player.skipToPrev();
    assert.equal(audio.plays, 4);
});

test('TrackPlayer: Shuffle replacement targets the input song; removing current respects navigation', async () => {
    const env = harness();
    env.queue.setQueue([a, b, c], { playIndex: 0 });
    env.queue.enterShuffle();
    const { player } = env.player();
    await player.playMusicWithReplaceQueue([a, b, c, d], { startItem: c });
    assert.equal(env.queue.getCurrentMusic().id, 'c');
    const successor = env.queue.queue[env.queue.getNextIndex()];
    await player.removeMusic(c);
    assert.equal(env.queue.getCurrentMusic().id, successor.id);
    await player.playMusicWithReplaceQueue([]);
    assert.equal(env.store.get(env.atoms.currentMusicAtom), null);
});

test('TrackPlayer: Random failures exclude the failed item and stop after three without retry loops', async () => {
    const env = harness();
    env.queue.setQueue([a, b, c], { playIndex: 0 });
    env.queue.enterRandom();
    const { player, audio } = env.player();
    const attempts = [];
    audio.hasSource = false;
    player.resolveSource = async (item) => {
        attempts.push(item.id);
        throw new Error('Controlled source failure');
    };
    await player.playIndex(0);
    assert.deepEqual(attempts, ['a', 'b', 'a']);
    assert.equal(audio.pauses, 1);
    assert.equal(env.store.get(env.atoms.playerStateAtom), env.constants.PlayerState.Paused);
    assert.equal(audio.plays, 0);
});

test('TrackPlayer: receiving a URL does not reset the consecutive media-error limit', async () => {
    const env = harness();
    env.queue.setQueue([a, b], { playIndex: 0 });
    env.queue.enterRandom();
    const { player, audio } = env.player();
    await player.handlePlayError(a);
    assert.equal(env.queue.getCurrentMusic().id, 'b');
    await player.handlePlayError(b);
    assert.equal(env.queue.getCurrentMusic().id, 'a');
    await player.handlePlayError(a);
    assert.equal(audio.plays, 2);
    assert.equal(audio.pauses, 1);

    player.bindAudioEvents();
    player.consecutiveErrors = 2;
    audio.emit('stateChange', env.constants.PlayerState.Playing);
    assert.equal(player.consecutiveErrors, 0);
});

test('TrackPlayer: repeated Random selection while loading rejects the older same-key source', async () => {
    const env = harness();
    env.queue.setQueue([a, b], { playIndex: 0 });
    env.queue.enterRandom();
    const { player, audio } = env.player();
    audio.hasSource = false;
    const pending = [];
    const committed = [];
    const started = [];
    const firstStarted = new Promise((resolve) => started.push(resolve));
    const secondStarted = new Promise((resolve) => started.push(resolve));
    player.resolveSource = () =>
        new Promise((resolve) => {
            pending.push(resolve);
            started.shift()();
        });
    audio.setTrackSource = (source) => {
        committed.push(source.url);
        audio.hasSource = true;
    };
    const first = player.playIndex(0);
    await firstStarted;
    const second = player.skipToNext();
    await secondStarted;
    assert.equal(pending.length, 2);
    pending[1]({
        source: { url: 'mock:new', quality: 'standard' },
        sourceInfo: { isLocal: false },
    });
    await second;
    pending[0]({
        source: { url: 'mock:old', quality: 'standard' },
        sourceInfo: { isLocal: false },
    });
    await first;
    assert.deepEqual(committed, ['mock:new']);
});

test('Quality: source parsing reports external files/cache metadata without mutating playback atoms', async () => {
    const env = harness();
    const { player } = env.player({ resolveSources: true });
    const previous = env.store.get(env.atoms.sourceInfoAtom);
    env.mediaSource = { url: 'FILE:///C:/Music/example%20song.flac' };
    env.decodedPath = 'C:\\Music\\example song.flac';
    let result = await player.resolveSource(a, 'super');
    assert.equal(result.sourceInfo.isLocal, true);
    assert.equal(result.sourceInfo.localPath, env.decodedPath);
    assert.equal(result.sourceInfo.audioFormat, env.audioFormat);
    assert.deepEqual(env.decodedUrls, [env.mediaSource.url]);
    assert.deepEqual(env.audioInfoPaths, [env.decodedPath]);
    assert.equal(env.store.get(env.atoms.sourceInfoAtom), previous);
    assert.equal(env.store.get(env.atoms.qualityAtom), 'standard');

    env.metadataError = new Error('Unreadable tags');
    result = await player.resolveSource(a, 'super');
    assert.equal(result.source.url, env.mediaSource.url);
    assert.match(result.sourceInfo.metadataError, /Unreadable tags/);
    assert.equal(result.sourceInfo.audioFormat, undefined);
    assert.ok(env.errors.some((args) => String(args[0]).includes('local audio format')));

    env.metadataError = null;
    env.decodedPath = undefined;
    env.download = { path: '/music/cache.flac', quality: 'high' };
    const requests = env.requestedQualities.length;
    result = await player.resolveSource(a, 'super');
    assert.equal(result.sourceInfo.localPath, '/music/cache.flac');
    assert.equal(result.sourceInfo.isLocal, true);
    assert.equal(env.requestedQualities.length, requests);
});

test('Quality: setup uses saved online preference, then validated configured default', async () => {
    for (const [saved, configured, expected] of [
        ['high', 'super', 'high'],
        [null, 'super', 'super'],
        ['invalid', 'high', 'high'],
        [null, 'invalid', 'standard'],
    ]) {
        const env = harness();
        env.config.set('playMusic.defaultQuality', configured);
        if (saved !== null) env.syncKV.set('player.currentQuality', saved);
        const { player } = env.player({ resolveSources: true });
        await player.setup();
        assert.equal(player.onlineQuality, expected);
        assert.equal(env.store.get(env.atoms.qualityAtom), expected);
        assert.equal(env.store.get(env.atoms.sourceInfoAtom), null);
    }
});

test('Quality: restored local files cannot change online preference or reload via setQuality', async () => {
    const env = harness();
    env.db = [a];
    env.syncKV.set('player.currentMusic', a);
    env.syncKV.set('player.currentQuality', 'high');
    env.mediaSource = { url: 'file:///music/external.flac', quality: 'super' };
    env.metadataError = new Error('Unsupported file tags');
    const { player, audio } = env.player({ resolveSources: true });
    await player.setup();
    assert.equal(env.store.get(env.atoms.sourceInfoAtom).isLocal, true);
    assert.match(env.store.get(env.atoms.sourceInfoAtom).metadataError, /Unsupported file tags/);
    assert.equal(env.store.get(env.atoms.playerStateAtom), env.constants.PlayerState.Paused);
    assert.equal(audio.plays, 0);
    player.resume();
    assert.equal(audio.plays, 1);
    const sourceCount = audio.sources.length;
    assert.equal(await player.setQuality('super'), false);
    assert.equal(audio.sources.length, sourceCount);
    assert.equal(env.syncKV.get('player.currentQuality'), 'high');
    assert.equal(player.onlineQuality, 'high');
    await player.handlePlayError(a);
    assert.equal(env.syncKV.get('player.currentQuality'), 'high');

    env.mediaSource = { url: 'https://example.test/online', quality: 'low' };
    await player.playMusic(b);
    assert.equal(env.requestedQualities.at(-1), 'high');
    assert.equal(env.store.get(env.atoms.sourceInfoAtom).isLocal, false);
    assert.equal(env.store.get(env.atoms.qualityAtom), 'low');
    assert.equal(env.syncKV.get('player.currentQuality'), 'high');
    player.reset();
    assert.equal(env.store.get(env.atoms.sourceInfoAtom), null);
});

test('Metadata: restored local playback receives its cover without reloading, seeking or autoplay', async () => {
    const env = harness();
    env.db = [a];
    env.syncKV.set('player.currentMusic', a);
    env.syncKV.set('player.currentProgress', 37);
    env.mediaSource = { url: 'file:///music/restored.flac' };
    const info = deferred();
    env.musicInfoPromise = info.promise;
    const { player, audio } = env.player({ resolveSources: true });
    const enrich = player.enrichCurrentMusic.bind(player);
    let enrichment;
    player.enrichCurrentMusic = (...args) => {
        enrichment = enrich(...args);
        return enrichment;
    };
    await player.setup();
    assert.ok(enrichment);
    assert.equal(audio.sources.length, 1);
    assert.deepEqual(audio.seeks, [37]);
    assert.equal(audio.plays, 0);
    const progress = env.store.get(env.atoms.progressAtom);
    const sourceInfo = env.store.get(env.atoms.sourceInfoAtom);
    info.resolve({
        artwork: 'data:image/png;base64,cover',
        title: 'With cover',
        platform: 'wrong',
        id: 'wrong',
    });
    await enrichment;
    const current = env.store.get(env.atoms.currentMusicAtom);
    assert.equal(current.artwork, 'data:image/png;base64,cover');
    assert.equal(current.title, 'With cover');
    assert.equal(current.platform, a.platform);
    assert.equal(current.id, a.id);
    assert.equal(audio.metadata.artwork, current.artwork);
    assert.equal(audio.sources.length, 1);
    assert.deepEqual(audio.seeks, [37]);
    assert.equal(audio.plays, 0);
    assert.equal(env.store.get(env.atoms.progressAtom), progress);
    assert.equal(env.store.get(env.atoms.sourceInfoAtom), sourceInfo);
    assert.equal(env.store.get(env.atoms.playerStateAtom), env.constants.PlayerState.Paused);
    player.resume();
    assert.equal(audio.plays, 1);
    assert.equal(audio.sources.length, 1);
    assert.deepEqual(audio.seeks, [37]);
});

test('Quality: online replacement uses the latest seek/pause state and commits matching source info', async () => {
    const env = harness();
    env.queue.setQueue([a], { playIndex: 0 });
    const { player, audio } = env.player();
    const started = deferred();
    const pending = deferred();
    player.resolveSource = () => {
        started.resolve();
        return pending.promise;
    };
    const switching = player.setQuality('high');
    await started.promise;
    env.store.set(env.atoms.progressAtom, { currentTime: 42, duration: 120 });
    player.pause();
    const sourceInfo = { isLocal: false };
    pending.resolve({ source: { url: 'mock:high', quality: 'high' }, sourceInfo });
    assert.equal(await switching, true);
    assert.deepEqual(audio.seeks, [42]);
    assert.equal(audio.plays, 0);
    assert.equal(env.store.get(env.atoms.playerStateAtom), env.constants.PlayerState.Paused);
    assert.equal(env.store.get(env.atoms.sourceInfoAtom), sourceInfo);
    assert.equal(env.store.get(env.atoms.qualityAtom), 'high');
    assert.equal(env.syncKV.get('player.currentQuality'), 'high');
});

test('Quality: stale switch success/failure cannot overwrite a newer local source or its state', async () => {
    for (const fail of [false, true]) {
        const env = harness();
        env.queue.setQueue([a, b], { playIndex: 0 });
        env.syncKV.set('player.currentQuality', 'standard');
        const { player, audio } = env.player();
        const started = deferred();
        const pending = deferred();
        const sourceInfo = { isLocal: true, localPath: '/music/new.flac' };
        player.resolveSource = async (_item, quality) => {
            if (quality === 'high') {
                started.resolve();
                return pending.promise;
            }
            return { source: { url: 'file:///music/new.flac', quality }, sourceInfo };
        };
        const switching = player.setQuality('high');
        await started.promise;
        await player.playIndex(1);
        const state = env.store.get(env.atoms.playerStateAtom);
        if (fail) pending.reject(new Error('Stale failure'));
        else
            pending.resolve({
                source: { url: 'mock:old', quality: 'high' },
                sourceInfo: { isLocal: false },
            });
        assert.equal(await switching, false);
        assert.equal(audio.sources.length, 1);
        assert.equal(audio.sources[0].url, 'file:///music/new.flac');
        assert.equal(env.store.get(env.atoms.sourceInfoAtom), sourceInfo);
        assert.equal(env.store.get(env.atoms.playerStateAtom), state);
        assert.equal(env.syncKV.get('player.currentQuality'), 'standard');
    }
});

test('Quality: failed online resolution rolls back; selecting the current tier cancels a pending switch', async () => {
    const env = harness();
    env.queue.setQueue([a], { playIndex: 0 });
    env.syncKV.set('player.currentQuality', 'standard');
    const { player, audio } = env.player();
    const sourceInfo = env.store.get(env.atoms.sourceInfoAtom);
    player.resolveSource = async () => {
        throw new Error('Controlled quality failure');
    };
    assert.equal(await player.setQuality('high'), false);
    assert.equal(audio.sources.length, 0);
    assert.equal(env.store.get(env.atoms.sourceInfoAtom), sourceInfo);
    assert.equal(env.store.get(env.atoms.qualityAtom), 'standard');
    assert.equal(env.store.get(env.atoms.playerStateAtom), env.constants.PlayerState.Playing);
    assert.equal(env.syncKV.get('player.currentQuality'), 'standard');

    const started = deferred();
    const pending = deferred();
    player.resolveSource = () => {
        started.resolve();
        return pending.promise;
    };
    const switching = player.setQuality('high');
    await started.promise;
    assert.equal(await player.setQuality('standard'), true);
    pending.resolve({
        source: { url: 'mock:cancelled', quality: 'high' },
        sourceInfo: { isLocal: false },
    });
    assert.equal(await switching, false);
    assert.equal(audio.sources.length, 0);
    assert.equal(env.syncKV.get('player.currentQuality'), 'standard');
});
