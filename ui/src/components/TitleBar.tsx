import { ChevronLeft, ChevronRight, Copy, Minus, Square, X } from 'lucide-react';
import { appWindow, inShell } from '../bridge';
import { usePlayer } from '../player/store';
import { useNav } from '../nav/router';

interface Props {
  /** Over playing video: the bar fades with the player's controls and shows no navigation. */
  overVideo?: boolean;
  visible?: boolean;
  /** Back and forward buttons for in-app navigation. */
  nav?: boolean;
}

export function TitleBar({ overVideo = false, visible = true, nav = false }: Props) {
  const maximized = usePlayer((s) => s.window.maximized);
  const fullscreen = usePlayer((s) => s.window.fullscreen);
  const canBack = useNav((s) => s.index > 0);
  const canForward = useNav((s) => s.index < s.stack.length - 1);
  if (fullscreen) return null;

  return (
    <header
      className={`titlebar${overVideo ? ' titlebar--over-video' : ''}${visible ? '' : ' is-hidden'}`}
      // In the app the empty parts of the bar are a real title bar (app-region: drag): move, Snap,
      // double-click to maximize. In a plain browser there is no window to move.
      onDoubleClick={inShell ? undefined : (e) => !(e.target as HTMLElement).closest('button') && appWindow.toggleMaximize()}
    >
      {!maximized && inShell && (
        <>
          <div className="resize-edge resize-edge--n" onPointerDown={(e) => (e.stopPropagation(), appWindow.resize('n'))} />
          <div className="resize-edge resize-edge--nw" onPointerDown={(e) => (e.stopPropagation(), appWindow.resize('nw'))} />
          <div className="resize-edge resize-edge--ne" onPointerDown={(e) => (e.stopPropagation(), appWindow.resize('ne'))} />
        </>
      )}
      {nav && (
        <div className="titlebar__nav">
          <button className="titlebar__navbtn" aria-label="Back" title="Back (Alt+←)" disabled={!canBack} onClick={() => useNav.getState().back()}>
            <ChevronLeft size={18} />
          </button>
          <button className="titlebar__navbtn" aria-label="Forward" title="Forward (Alt+→)" disabled={!canForward} onClick={() => useNav.getState().forward()}>
            <ChevronRight size={18} />
          </button>
        </div>
      )}
      <div className="titlebar__spacer" />
      <div className="titlebar__buttons">
        <button className="winbtn" aria-label="Minimize" onClick={appWindow.minimize}>
          <Minus size={16} strokeWidth={1.5} />
        </button>
        <button className="winbtn" aria-label={maximized ? 'Restore' : 'Maximize'} onClick={appWindow.toggleMaximize}>
          {maximized ? <Copy size={13} strokeWidth={1.5} style={{ transform: 'scaleX(-1)' }} /> : <Square size={12.5} strokeWidth={1.5} />}
        </button>
        <button className="winbtn winbtn--close" aria-label="Close" onClick={appWindow.close}>
          <X size={17} strokeWidth={1.5} />
        </button>
      </div>
    </header>
  );
}
