// Pure logic only: transpile project TypeScript in memory; no Electron, network or audio.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
            'currentLyricAtom',
        ].map((name) => [name, name]),
    );
    const store = { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
    const syncKV = {
        get: (key) => JSON.parse(storage.get(key) ?? 'null'),
        set: (key, value) => storage.set(key, JSON.stringify(value)),
        remove: (key) => storage.delete(key),
    };
    const env = { db: [], writes: [], storage, syncKV, store, atoms };
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
            default: { getRawMusicItem: async () => null },
            playQueueBridge: bridge,
        },
        '@common/delay': async () => {},
        '@common/throttle': (callback) => callback,
        '@infra/pluginManager/renderer': { callPluginMethod: async () => null },
        '@infra/appConfig/renderer': { getConfigByKey: () => 'skip' },
        '@infra/downloadManager/renderer': {},
        '@infra/fsUtil/renderer': {},
        '@infra/appSync/renderer/main': {},
        '../recentlyPlayed': { addToRecentlyPlayed: async () => {} },
        './audioController': {},
        './lyricManager': class {},
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
                console,
            },
            { filename },
        );
        return exports;
    }
    env.Queue = load(queuePath).default;
    env.queue = new env.Queue(random);
    env.constants = load('src/common/constant.ts');
    env.player = () => {
        const player = load(playerPath).default;
        const audio = Object.assign(new EventEmitter(), {
            hasSource: true,
            seeks: [],
            plays: 0,
            pauses: 0,
            seekTo(seconds) {
                this.seeks.push(seconds);
            },
            play() {
                this.plays++;
            },
            pause() {
                this.pauses++;
            },
            prepareTrack() {
                this.hasSource = false;
            },
            setTrackSource() {
                this.hasSource = true;
            },
            updateMetadata() {},
            reset() {
                this.hasSource = false;
            },
        });
        player.playQueue = env.queue;
        player.audioController = audio;
        player.lyricManager = { fetchLyric() {}, reset() {} };
        player.resolveSource = async () => ({ url: 'mock:audio', quality: 'standard' });
        store.set(atoms.currentMusicAtom, env.queue.getCurrentMusic());
        store.set(atoms.repeatModeAtom, env.constants.RepeatMode.Random);
        store.set(atoms.qualityAtom, 'standard');
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
    pending[1]({ url: 'mock:new', quality: 'standard' });
    await second;
    pending[0]({ url: 'mock:old', quality: 'standard' });
    await first;
    assert.deepEqual(committed, ['mock:new']);
});
