// ============================================================================
// QualityPopover — 音质选择气泡面板
// ============================================================================
//
// 在线源保留四档选择；本地源只展示实际音频参数，不提供切换操作。

import { useEffect, useId, useRef, useState, memo } from 'react';
import { getDefaultStore, useAtomValue } from 'jotai';
import { Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@common/cn';
import { QUALITY_KEYS } from '@common/constant';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import { useQuality } from '@renderer/mainWindow/core/trackPlayer/hooks';
import { sourceInfoAtom } from '@renderer/mainWindow/core/trackPlayer/store';
import appConfig from '@infra/appConfig/renderer';
import { showToast } from '../../ui/Toast';

/** 音质 key → i18n key */
const QUALITY_I18N_KEYS: Record<IMusic.IQualityKey, string> = {
    low: 'quality.low',
    standard: 'quality.standard',
    high: 'quality.high',
    super: 'quality.super',
};

/** 从高到低排列，面板自上而下为高 → 低 */
const QUALITY_OPTIONS = [...QUALITY_KEYS].reverse();

const QualityPopover = memo(function QualityPopover() {
    const quality = useQuality();
    const sourceInfo = useAtomValue(sourceInfoAtom);
    const { t, i18n } = useTranslation();
    const [open, setOpen] = useState(false);
    const [switching, setSwitching] = useState(false);
    const anchorRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const pendingFocus = useRef<number | null>(null);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const panelId = useId();

    useEffect(() => {
        setOpen(false);
        if (timerRef.current) clearTimeout(timerRef.current);
        return () => {
            if (timerRef.current) clearTimeout(timerRef.current);
        };
    }, [sourceInfo]);

    useEffect(() => {
        if (!open) return;
        if (pendingFocus.current !== null) {
            optionRefs.current[pendingFocus.current]?.focus();
            pendingFocus.current = null;
        }
        const onPointerDown = (event: PointerEvent) => {
            if (!anchorRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [open]);

    const show = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setOpen(true), 120);
    };

    const hide = () => {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
            if (!anchorRef.current?.contains(document.activeElement)) setOpen(false);
        }, 200);
    };

    const handleSelect = async (q: IMusic.IQualityKey) => {
        const currentSource = getDefaultStore().get(sourceInfoAtom);
        if (!currentSource || currentSource.isLocal || switching) return;
        if (timerRef.current) clearTimeout(timerRef.current);
        setOpen(false);
        triggerRef.current?.focus();
        setSwitching(true);
        try {
            const success = await trackPlayer.setQuality(q);
            if (success) {
                appConfig.setConfig({ 'playMusic.defaultQuality': q });
            } else {
                showToast(t('quality.unavailable'), { type: 'warn' });
            }
        } catch (error) {
            showToast(t('quality.unavailable'), {
                type: 'warn',
                description: error instanceof Error ? error.message : String(error),
            });
        } finally {
            setSwitching(false);
        }
    };

    if (!sourceInfo) {
        return (
            <span
                className="l-player-bar__quality is-readonly"
                role="note"
                tabIndex={0}
                title={t('quality.no_source')}
                aria-label={t('quality.no_source')}
            >
                {t('common.unknown')}
            </span>
        );
    }

    if (sourceInfo.isLocal) {
        const format = sourceInfo.audioFormat;
        const unknown = t('common.unknown');
        const numberFormat = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 3 });
        const codec = format?.codec || unknown;
        const bitrate =
            format?.bitrate == null
                ? unknown
                : t('media.bitrate_value', { value: numberFormat.format(format.bitrate / 1000) });
        const detail =
            format?.lossless === true
                ? t('quality.lossless')
                : format?.bitrate != null
                  ? bitrate
                  : undefined;
        const description = [
            t('quality.local_fixed'),
            ...(sourceInfo.metadataError
                ? [`${t('quality.read_failed')}: ${sourceInfo.metadataError}`]
                : []),
            `${t('media.codec')}: ${codec}`,
            `${t('media.lossless_encoding')}: ${format?.lossless == null ? unknown : t(format.lossless ? 'common.yes' : 'common.no')}`,
            `${t('media.bitrate')}: ${bitrate}`,
            `${t('media.sample_rate')}: ${format?.sampleRate == null ? unknown : t('media.sample_rate_value', { value: numberFormat.format(format.sampleRate / 1000) })}`,
            `${t('media.bit_depth')}: ${format?.bitsPerSample == null ? unknown : t('media.bit_depth_value', { value: numberFormat.format(format.bitsPerSample) })}`,
        ].join('\n');

        return (
            <span
                className="l-player-bar__quality is-readonly"
                role="note"
                tabIndex={0}
                title={description}
                aria-label={description}
            >
                <span className="l-player-bar__quality-codec">
                    {sourceInfo.metadataError ? t('quality.read_failed') : codec}
                </span>
                {!sourceInfo.metadataError && detail && (
                    <span className="l-player-bar__quality-detail">{detail}</span>
                )}
            </span>
        );
    }

    return (
        <div
            ref={anchorRef}
            className="l-player-bar__popover-anchor l-player-bar__popover-anchor--no-ml"
            onMouseEnter={show}
            onMouseLeave={hide}
            onFocus={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                    if (timerRef.current) clearTimeout(timerRef.current);
                    setOpen(true);
                }
            }}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) {
                    if (timerRef.current) clearTimeout(timerRef.current);
                    setOpen(false);
                }
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape' && open) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (timerRef.current) clearTimeout(timerRef.current);
                    setOpen(false);
                    triggerRef.current?.focus();
                    return;
                }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || switching)
                    return;
                event.preventDefault();
                event.stopPropagation();
                if (timerRef.current) clearTimeout(timerRef.current);
                const current = optionRefs.current.findIndex(
                    (option) => option === document.activeElement,
                );
                const next =
                    event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? QUALITY_OPTIONS.length - 1
                          : current < 0
                            ? QUALITY_OPTIONS.indexOf(quality)
                            : (current +
                                  (event.key === 'ArrowDown' ? 1 : -1) +
                                  QUALITY_OPTIONS.length) %
                              QUALITY_OPTIONS.length;
                if (open) optionRefs.current[next]?.focus();
                else {
                    pendingFocus.current = next;
                    setOpen(true);
                }
            }}
        >
            {/* 触发按钮 */}
            <button
                ref={triggerRef}
                className="l-player-bar__quality"
                type="button"
                title={open ? undefined : t('quality.switch')}
                aria-label={`${t('quality.switch')}: ${t(QUALITY_I18N_KEYS[quality])}`}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={panelId}
                aria-busy={switching}
                onClick={() => setOpen(true)}
            >
                {t(QUALITY_I18N_KEYS[quality])}
            </button>

            {/* 气泡面板 */}
            <div
                id={panelId}
                className={cn(
                    'l-player-bar__popover l-player-bar__popover--list',
                    open && 'is-visible',
                )}
                role="menu"
                aria-label={t('quality.switch')}
                aria-hidden={!open}
            >
                {QUALITY_OPTIONS.map((q, index) => {
                    const isActive = q === quality;
                    return (
                        <button
                            key={q}
                            ref={(element) => {
                                optionRefs.current[index] = element;
                            }}
                            type="button"
                            role="menuitemradio"
                            aria-checked={isActive}
                            tabIndex={open ? 0 : -1}
                            disabled={switching}
                            className={cn('l-player-bar__quality-option', isActive && 'is-active')}
                            onClick={() => handleSelect(q)}
                        >
                            <span className="l-player-bar__quality-option-label">
                                {t(QUALITY_I18N_KEYS[q])}
                            </span>
                            {isActive && (
                                <Check size={12} className="l-player-bar__quality-option-check" />
                            )}
                        </button>
                    );
                })}
            </div>
        </div>
    );
});

export default QualityPopover;
