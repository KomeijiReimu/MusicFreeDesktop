import { memo, useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import { cn } from '@common/cn';
import { RepeatMode } from '@common/constant';
import { REPEAT_MODE_MAP } from '@renderer/common/repeatModeMap';
import trackPlayer from '@renderer/mainWindow/core/trackPlayer';
import { useRepeatMode } from '@renderer/mainWindow/core/trackPlayer/hooks';
import './index.scss';

const MODES = [RepeatMode.Queue, RepeatMode.Shuffle, RepeatMode.Random, RepeatMode.Loop];

interface RepeatModePopoverProps {
    buttonClassName: string;
    iconSize: number;
    fullscreen?: boolean;
}

const RepeatModePopover = memo(function RepeatModePopover({
    buttonClassName,
    iconSize,
    fullscreen = false,
}: RepeatModePopoverProps) {
    const { t } = useTranslation();
    const repeatMode = useRepeatMode();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const pendingFocus = useRef<number | null>(null);
    const panelId = useId();
    const { Icon, tipKey, descriptionKey } = REPEAT_MODE_MAP[repeatMode];
    const title = descriptionKey ? `${t(tipKey)}\n${t(descriptionKey)}` : t(tipKey);

    useEffect(() => {
        if (!open) return;
        optionRefs.current[pendingFocus.current ?? MODES.indexOf(repeatMode)]?.focus();
        pendingFocus.current = null;
        const onPointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown);
        return () => document.removeEventListener('pointerdown', onPointerDown);
    }, [open, repeatMode]);

    return (
        <div
            ref={rootRef}
            className={cn('repeat-mode-popover', fullscreen && 'repeat-mode-popover--fullscreen')}
            onBlur={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
            }}
            onKeyDown={(event) => {
                if (event.key === 'Escape' && open) {
                    event.preventDefault();
                    event.stopPropagation();
                    setOpen(false);
                    triggerRef.current?.focus();
                    return;
                }
                if (event.key === 'Tab' && open) {
                    triggerRef.current?.focus();
                    setOpen(false);
                    return;
                }
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                event.stopPropagation();
                const current = optionRefs.current.findIndex(
                    (option) => option === document.activeElement,
                );
                const next =
                    event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? MODES.length - 1
                          : current < 0
                            ? MODES.indexOf(repeatMode)
                            : (current + (event.key === 'ArrowDown' ? 1 : -1) + MODES.length) %
                              MODES.length;
                if (open) optionRefs.current[next]?.focus();
                else {
                    pendingFocus.current = next;
                    setOpen(true);
                }
            }}
        >
            <button
                ref={triggerRef}
                type="button"
                className={buttonClassName}
                title={open ? undefined : title}
                aria-label={`${t('playback.repeat_mode')}: ${t(tipKey)}`}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={panelId}
                onClick={() => setOpen((value) => !value)}
            >
                <Icon size={iconSize} />
            </button>
            {open && (
                <div
                    id={panelId}
                    className="repeat-mode-popover__panel"
                    role="menu"
                    aria-label={t('playback.repeat_mode')}
                >
                    {MODES.map((mode, index) => {
                        const entry = REPEAT_MODE_MAP[mode];
                        const active = mode === repeatMode;
                        const OptionIcon = entry.Icon;
                        const descriptionId = `${panelId}-${mode}-description`;
                        return (
                            <button
                                key={mode}
                                ref={(element) => {
                                    optionRefs.current[index] = element;
                                }}
                                type="button"
                                className={cn('repeat-mode-popover__option', active && 'is-active')}
                                role="menuitemradio"
                                aria-checked={active}
                                aria-describedby={entry.descriptionKey ? descriptionId : undefined}
                                tabIndex={active ? 0 : -1}
                                onClick={() => {
                                    trackPlayer.setRepeatMode(mode);
                                    setOpen(false);
                                    triggerRef.current?.focus();
                                }}
                            >
                                <OptionIcon size={16} aria-hidden="true" />
                                <span className="repeat-mode-popover__text">
                                    <span className="repeat-mode-popover__label">
                                        {t(entry.tipKey)}
                                    </span>
                                    {entry.descriptionKey && (
                                        <span
                                            id={descriptionId}
                                            className="repeat-mode-popover__description"
                                        >
                                            {t(entry.descriptionKey)}
                                        </span>
                                    )}
                                </span>
                                <span className="repeat-mode-popover__check">
                                    {active && <Check size={14} aria-hidden="true" />}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </div>
    );
});

export default RepeatModePopover;
