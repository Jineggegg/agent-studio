import { useEffect, useState } from 'react';
import type { InspectorPanelProps, InspectorRequest } from '../inspector/registry';

/** What a panel is given, written out — for looking at the inspector's container in development. */
export default function SamplePanel({ project, sessionId, active, presentation, request, onRequestHandled }: InspectorPanelProps) {
  const [mountedAt] = useState(() => new Date().toLocaleTimeString());
  const [handled, setHandled] = useState<InspectorRequest[]>([]);
  useEffect(() => {
    if (!request) return;
    setHandled((current) => [...current, request]);
    onRequestHandled();
  }, [request, onRequestHandled]);
  return (
    <div style={{ padding: 16, display: 'grid', gap: 8, alignContent: 'start', overflow: 'auto', height: '100%' }}>
      <p>
        <strong>presentation</strong> {presentation}
      </p>
      <p>
        <strong>project</strong> {project?.name ?? '—'}
      </p>
      <p>
        <strong>session</strong> <span className="u-mono">{sessionId ?? '—'}</span>
      </p>
      <p>
        <strong>active</strong> {String(active)} · <strong>mounted</strong> {mountedAt}
      </p>
      <p>
        <strong>requests</strong> {handled.length === 0 ? '—' : handled.map((entry) => entry.type).join(', ')}
      </p>
      {Array.from({ length: 30 }, (_, index) => (
        <p key={index} className="text-secondary">
          Row {index + 1}: content that makes the panel scroll inside itself.
        </p>
      ))}
    </div>
  );
}
