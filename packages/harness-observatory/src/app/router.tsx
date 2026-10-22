import { createBrowserRouter, Navigate } from 'react-router-dom';
import { ShellLayout } from './ShellLayout';
import { RequestDetailPage } from '@/pages/RequestDetailPage';
import { RequestsListPage } from '@/pages/RequestsListPage';
import { CallsPage } from '@/pages/CallsPage';
import { DecisionsPage } from '@/pages/DecisionsPage';
import { GatePage } from '@/pages/GatePage';
import { ProjectsPage } from '@/pages/ProjectsPage';
import { StatusPage } from '@/pages/StatusPage';
import { BrainPage } from '@/pages/BrainPage';
import { StubPage } from '@/pages/StubPage';

export const appRouter = createBrowserRouter([
    {
        path: '/',
        element: <ShellLayout />,
        children: [
            { index: true, element: <Navigate to="/requests" replace /> },
            { path: 'projects', element: <ProjectsPage /> },
            { path: 'requests', element: <RequestsListPage /> },
            { path: 'requests/:id', element: <RequestDetailPage /> },
            { path: 'calls', element: <CallsPage /> },
            { path: 'brain', element: <BrainPage /> },
            { path: 'findings', element: <StubPage title="Findings" hint="L1 conformance overlay." /> },
            { path: 'targets', element: <StubPage title="Targets" hint="Hot files/rules in session." /> },
            { path: 'decisions', element: <DecisionsPage /> },
            { path: 'gate', element: <GatePage /> },
            { path: 'charts', element: <StubPage title="Charts" hint="Token/time buckets." /> },
            { path: 'status', element: <StatusPage /> },
        ],
    },
]);
