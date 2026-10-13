import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ConfigPage } from '@/pages/ConfigPage';
import { HomePage } from '@/pages/HomePage';
import { PluginsPage } from '@/pages/PluginsPage';
import { PreviewPage } from '@/pages/PreviewPage';
import { ProvisionDonePage } from '@/pages/ProvisionDonePage';

export function App() {
    return (
        <BrowserRouter>
            <div className="shell min-h-screen">
                <header className="mb-2">
                    <h1>Harness Console</h1>
                    <p className="sub">Quản lý dự án · không phải Observatory monitor</p>
                </header>
                <main>
                    <Routes>
                        <Route path="/" element={<HomePage />} />
                        <Route path="/projects/:id/config" element={<ConfigPage />} />
                        <Route path="/projects/:id/plugins" element={<PluginsPage />} />
                        <Route path="/projects/:id/preview" element={<PreviewPage />} />
                        <Route path="/projects/:id/done" element={<ProvisionDonePage />} />
                    </Routes>
                </main>
            </div>
        </BrowserRouter>
    );
}
