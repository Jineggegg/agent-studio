import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router';
import { remember } from './device';
import { workbenchPaths } from './routes';

/**
 * `/projects/<id>` — where the home screen's project tiles lead. A project's
 * page is its workbench, with that project's conversations beside the chat,
 * so this only says so and hands over. The history entry is replaced: Back
 * returns to where the tile was pressed.
 */
export default function ProjectRedirect() {
  const { projectId } = useParams();
  useEffect(() => {
    // Opening a project by its tile means "this project", whatever list was showing last.
    if (projectId) remember({ scope: 'project', lastProjectId: projectId });
  }, [projectId]);
  return <Navigate to={projectId ? workbenchPaths.project(projectId) : workbenchPaths.root()} replace />;
}
