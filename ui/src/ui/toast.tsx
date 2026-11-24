import { create } from 'zustand';
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';

export interface Toast {
  id: number;
  kind: 'info' | 'success' | 'error';
  text: string;
  action?: { label: string; run: () => void };
}

interface ToastState {
  toasts: Toast[];
  show: (t: Omit<Toast, 'id'>, ms?: number) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  show(t, ms = 4200) {
    const id = nextId++;
    set({ toasts: [...get().toasts.filter((x) => x.text !== t.text), { ...t, id }].slice(-4) });
    if (ms > 0) window.setTimeout(() => get().dismiss(id), ms);
    return id;
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export const toast = {
  info: (text: string, action?: Toast['action']) => useToasts.getState().show({ kind: 'info', text, action }),
  success: (text: string, action?: Toast['action']) => useToasts.getState().show({ kind: 'success', text, action }),
  error: (text: string, action?: Toast['action']) => useToasts.getState().show({ kind: 'error', text, action }, 7000),
};

export function ToastViewport() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  return (
    <div className="toasts" role="region" aria-live="polite" aria-label="Notifications">
      {toasts.map((t) => (
        <div key={t.id} className={`toast-card toast-card--${t.kind}`}>
          <span className="toast-card__icon">
            {t.kind === 'success' ? <CheckCircle2 size={18} /> : t.kind === 'error' ? <AlertCircle size={18} /> : <Info size={18} />}
          </span>
          <span className="toast-card__text">{t.text}</span>
          {t.action && (
            <button
              className="toast-card__action"
              onClick={() => {
                t.action!.run();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-card__close" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            <X size={15} />
          </button>
        </div>
      ))}
    </div>
  );
}
