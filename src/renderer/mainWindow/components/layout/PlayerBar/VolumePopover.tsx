// ============================================================================
// VolumePopover — 音量垂直气泡面板
// ============================================================================
//
// 悬停或键盘聚焦时弹出垂直滑条，支持拖拽、滚轮和方向键调节。
// 背景纯色 (--color-bg-modal)，不使用 backdrop-filter。

import { useCallback, useRef, useEffect, useId, useState, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { Volume2, Volume1, VolumeX } from 'lucide-react';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import { useVolume } from '@renderer/mainWindow/core/trackPlayer/hooks';
import { volumeMemory } from './volumeMemory';
import './VolumePopover.scss';

/** 根据音量值选择图标 */
function getVolumeIcon(volume: number) {
    if (volume === 0) return VolumeX;
    if (volume < 0.4) return Volume1;
    return Volume2;
}

/** 滚轮和方向键每次调节 2%。 */
const VOLUME_STEP = 0.02;

/**
 * VolumePopover
 *
 * 音量按钮 + 垂直气泡面板。
 * - hover 延迟 120ms 打开 / 200ms 关闭
 * - 垂直滑条：4px × 100px，pointer-capture 拖拽
 * - 鼠标滚轮：整个区域监听 wheel 事件，±2%
 */
const VolumePopover = memo(function VolumePopover() {
    const { t } = useTranslation();
    const volume = useVolume();
    const VolumeIcon = getVolumeIcon(volume);
    const [open, setOpen] = useState(false);
    const popoverId = useId();

    const anchorRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const isDraggingRef = useRef(false);
    /** 供原生 wheel listener 读取最新值，避免闭包过时 */
    const volumeRef = useRef(volume);
    volumeRef.current = volume;

    const changeVolume = useCallback((nextVolume: number) => {
        if (volumeRef.current > 0) volumeMemory.lastNonZero = volumeRef.current;
        if (nextVolume > 0) volumeMemory.lastNonZero = nextVolume;
        volumeRef.current = nextVolume;
        trackPlayer.setVolume(nextVolume);
    }, []);

    // ── 显示/隐藏逻辑 ──

    const show = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            setOpen(true);
        }, 120);
    }, []);

    const hide = useCallback(() => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            if (!anchorRef.current?.contains(document.activeElement) && !isDraggingRef.current) {
                setOpen(false);
            }
        }, 200);
    }, []);

    useEffect(() => {
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, []);

    // ── 垂直滑条拖拽 ──

    const setVolumeFromPointer = useCallback(
        (clientY: number) => {
            const track = trackRef.current;
            if (!track) return;
            const rect = track.getBoundingClientRect();
            // 底部 = 0，顶部 = 1
            const pct = Math.max(0, Math.min(1, (rect.bottom - clientY) / rect.height));
            changeVolume(pct);
        },
        [changeVolume],
    );

    const handlePointerDown = useCallback(
        (e: React.PointerEvent<HTMLDivElement>) => {
            e.preventDefault();
            e.currentTarget.focus();
            e.currentTarget.setPointerCapture(e.pointerId);
            isDraggingRef.current = true;
            setVolumeFromPointer(e.clientY);
        },
        [setVolumeFromPointer],
    );

    const handlePointerMove = useCallback(
        (e: React.PointerEvent) => {
            if (!isDraggingRef.current) return;
            setVolumeFromPointer(e.clientY);
        },
        [setVolumeFromPointer],
    );

    const handlePointerUp = useCallback(() => {
        isDraggingRef.current = false;
    }, []);

    // ── 滚轮调节（原生事件：React onWheel 是 passive，无法 preventDefault） ──

    useEffect(() => {
        const el = anchorRef.current;
        if (!el) return;

        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const delta = e.deltaY < 0 ? VOLUME_STEP : -VOLUME_STEP;
            changeVolume(Math.max(0, Math.min(1, volumeRef.current + delta)));
        };

        el.addEventListener('wheel', onWheel, { passive: false });
        return () => el.removeEventListener('wheel', onWheel);
    }, [changeVolume]);

    const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'Escape' && open) {
            e.preventDefault();
            e.stopPropagation();
            if (timerRef.current) clearTimeout(timerRef.current);
            setOpen(false);
            triggerRef.current?.focus();
            return;
        }

        let nextVolume: number;
        switch (e.key) {
            case 'ArrowUp':
            case 'ArrowRight':
                nextVolume = Math.min(1, volumeRef.current + VOLUME_STEP);
                break;
            case 'ArrowDown':
            case 'ArrowLeft':
                nextVolume = Math.max(0, volumeRef.current - VOLUME_STEP);
                break;
            case 'Home':
                nextVolume = 0;
                break;
            case 'End':
                nextVolume = 1;
                break;
            default:
                return;
        }
        e.preventDefault();
        e.stopPropagation();
        setOpen(true);
        changeVolume(nextVolume);
    };

    const volumePct = Math.round(volume * 100);

    return (
        <div
            ref={anchorRef}
            className="volume-popover"
            onMouseEnter={show}
            onMouseLeave={hide}
            onFocus={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) {
                    if (timerRef.current) clearTimeout(timerRef.current);
                    setOpen(true);
                }
            }}
            onBlur={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget)) hide();
            }}
            onKeyDown={handleKeyDown}
        >
            {/* 触发按钮 */}
            <button
                ref={triggerRef}
                className="volume-popover__trigger"
                type="button"
                title={t('playback.volume_percent', { volume: volumePct })}
                aria-label={`${t(volume === 0 ? 'playback.unmute' : 'playback.mute')}, ${t('playback.volume_percent', { volume: volumePct })}`}
                aria-expanded={open}
                aria-controls={popoverId}
                onClick={() => {
                    if (volume === 0) {
                        changeVolume(volumeMemory.lastNonZero);
                    } else {
                        changeVolume(0);
                    }
                }}
            >
                <VolumeIcon size={15} />
            </button>

            {/* 气泡面板 */}
            <div
                id={popoverId}
                className={`volume-popover__panel${open ? ' is-visible' : ''}`}
                aria-hidden={!open}
            >
                <span className="volume-popover__value" aria-hidden="true">
                    {volumePct}
                </span>
                <div
                    ref={trackRef}
                    className="volume-popover__track"
                    role="slider"
                    aria-label={t('playback.volume')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={volumePct}
                    aria-valuetext={t('playback.volume_percent', { volume: volumePct })}
                    aria-orientation="vertical"
                    tabIndex={open ? 0 : -1}
                    onPointerDown={handlePointerDown}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    onPointerCancel={handlePointerUp}
                    onLostPointerCapture={handlePointerUp}
                >
                    <div className="volume-popover__fill" style={{ height: `${volumePct}%` }} />
                    <div className="volume-popover__thumb" style={{ bottom: `${volumePct}%` }} />
                </div>
            </div>
        </div>
    );
});

export default VolumePopover;
