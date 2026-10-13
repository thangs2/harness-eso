/** @type {import('tailwindcss').Config} */
export default {
    content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
    theme: {
        extend: {
            colors: {
                surface: {
                    DEFAULT: '#0b0e14',
                    raised: '#131722',
                    card: '#131722',
                    border: '#253047',
                },
                accent: {
                    DEFAULT: '#2f4a7a',
                    soft: '#5aa9ff',
                    link: '#5aa9ff',
                },
                warn: '#e0b341',
                ok: '#4ec97a',
                danger: '#ff6b6b',
            },
            maxWidth: {
                /** Nearly full viewport on large monitors; cap avoids absurd line length on ultrawide */
                observe: 'min(2200px, calc(100vw - 2.5rem))',
            },
            fontFamily: {
                mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
            },
        },
    },
    plugins: [],
};
