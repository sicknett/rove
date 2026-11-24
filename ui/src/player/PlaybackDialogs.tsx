import { Play, RotateCcw, X } from 'lucide-react';
import { Button, Dialog } from '../ui/controls';
import { Img } from '../ui/Img';
import { formatTime } from '../format';
import { cancelFinding, resumeChoice, usePlayback } from './session';

/** "Resume or start over?" when the setting asks. */
export function ResumeDialog() {
  const prompt = usePlayback((s) => s.resumePrompt);
  if (!prompt) return null;
  const t = prompt.target;
  return (
    <Dialog open onClose={() => usePlayback.setState({ resumePrompt: null })} title={t.type === 'series' && t.season !== undefined ? `${t.name} · S${t.season} E${t.episode}` : t.name} width={460}>
      <p className="dialog__text">
        You stopped at {formatTime(prompt.positionS)} of {formatTime(prompt.durationS)}.
      </p>
      <div className="dialog__stack">
        <Button variant="primary" size="lg" icon={<Play size={18} fill="currentColor" strokeWidth={0} />} data-autofocus onClick={() => resumeChoice(false)}>
          Resume from {formatTime(prompt.positionS)}
        </Button>
        <Button variant="secondary" size="lg" icon={<RotateCcw size={18} />} onClick={() => resumeChoice(true)}>
          Start from the beginning
        </Button>
      </div>
    </Dialog>
  );
}

/** Full-screen "finding a source" state, over everything, until one starts or the picker opens. */
export function FindingOverlay() {
  const finding = usePlayback((s) => s.finding);
  if (!finding) return null;
  return (
    <div className="finding" role="status" aria-live="polite">
      <Img src={finding.background ?? finding.poster} alt="" className="finding__bg" loading="eager" />
      <div className="finding__shade" />
      <div className="finding__content">
        {finding.logo ? <Img src={finding.logo} alt={finding.name} className="finding__logo" fallback={<h2 className="finding__title">{finding.name}</h2>} /> : <h2 className="finding__title">{finding.name}</h2>}
        {finding.season !== undefined && (
          <p className="finding__ep">
            S{finding.season} E{finding.episode}
            {finding.episodeTitle ? ` · ${finding.episodeTitle}` : ''}
          </p>
        )}
        <div className="finding__status">
          <span className="spinner" /> Finding the best source…
        </div>
        <Button variant="ghost" icon={<X size={16} />} onClick={cancelFinding}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
