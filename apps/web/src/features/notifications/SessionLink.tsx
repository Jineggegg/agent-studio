import { Navigate, useParams } from 'react-router';
import { workbenchPaths } from '@/features/workbench/routes';

/**
 * The addresses a notification carries — `/projects/<p>/sessions/<s>` and
 * `/sessions/<s>` (see `appLinks` in the protocol) — handed on to the
 * conversation in the workbench. The entry is replaced, so Back returns to
 * wherever the notification was tapped from.
 */
export default function SessionLink() {
  const { projectId, sessionId } = useParams();
  if (!sessionId) return <Navigate to="/" replace />;
  return <Navigate to={projectId ? workbenchPaths.session(projectId, sessionId) : workbenchPaths.lookup(sessionId)} replace />;
}
