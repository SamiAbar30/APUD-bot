import { useEffect, useState } from 'react';

export interface BotActivityState {
  phase: 'idle' | 'waiting' | 'preparing' | 'sending' | 'paused' | 'blocked' | 'offline';
  pendingCount?: number;
  startedAt?: number;
  replyAfter?: number;
  serverNow?: number;
}

export function BotActivity({ activity }: { activity: BotActivityState }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const received = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Date.now() - received), 1000);
    return () => window.clearInterval(timer);
  }, [activity]);
  if (activity.phase === 'idle') return null;
  const busy = ['waiting', 'preparing', 'sending'].includes(activity.phase);
  const now = (activity.serverNow ?? Date.now()) + elapsed;
  const seconds = Math.max(0, Math.ceil(((activity.replyAfter ?? now) - now) / 1000));
  const progress = activity.startedAt && activity.replyAfter
    ? Math.min(100, Math.max(0, (now - activity.startedAt) / Math.max(1, activity.replyAfter - activity.startedAt) * 100)) : 0;
  const label = {
    waiting: seconds > 0 ? `Te estoy leyendo · ${seconds} s para preparar la respuesta` : 'Preparando tu respuesta…',
    preparing: 'Preparando tu respuesta…',
    sending: 'Enviando la respuesta…',
    paused: 'Conversación en pausa · pendiente del equipo',
    blocked: 'La respuesta necesita revisión del equipo',
    offline: 'No se puede conectar con el bot',
    idle: '',
  }[activity.phase];
  return (
    <div data-testid="bot-activity" data-phase={activity.phase} className="border-t bg-emerald-50 px-4 py-3 text-emerald-950">
      <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs">
        {busy && <span className="flex gap-1" aria-hidden="true">{[0, 1, 2].map(i => <span key={i} className="h-1.5 w-1.5 rounded-full bg-emerald-600 motion-safe:animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />)}</span>}
        <span>{label}</span>
      </div>
      {activity.phase === 'waiting' && <>
        <p className="mt-1 text-xs text-emerald-800">Puedes seguir escribiendo. Leo tus mensajes juntos antes de responder.</p>
        <div className="mt-2 h-1 overflow-hidden rounded bg-emerald-100" aria-hidden="true"><div className="h-full bg-emerald-600 transition-all duration-1000 motion-reduce:transition-none" style={{ width: `${progress}%` }} /></div>
      </>}
    </div>
  );
}
