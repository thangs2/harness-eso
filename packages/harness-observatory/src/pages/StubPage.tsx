import { Link } from 'react-router-dom';
import { EmptyState } from '@/ui/Feedback';
import { PageHeader } from '@/ui/PageHeader';
import { Panel } from '@/ui/Panel';

type StubPageProps = {
    title: string;
    hint?: string;
};

export function StubPage({ title, hint }: StubPageProps) {
    return (
        <section>
            <PageHeader title={title} description={hint ?? 'API binding ships in W5 slices.'} />
            <Panel>
                <EmptyState
                    title="Coming soon"
                    hint="Use Requests and Status for x79 smoke today. Full tab parity: spec 16.harness-observatory-spec.md §2."
                />
                <p className="obs-sub mt-4 mb-0">
                    <Link to="/requests">Open requests</Link>
                    {' · '}
                    <Link to="/status">Ingest status</Link>
                </p>
            </Panel>
        </section>
    );
}
