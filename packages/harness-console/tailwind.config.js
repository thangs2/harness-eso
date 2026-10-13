/** @type {import('tailwindcss').Config} */
export default {
    content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
    theme: {
        extend: {
            colors: {
                surface: {
                    DEFAULT: '#0f1117',
                    raised: '#12151d',
                    card: '#141824',
                    border: '#2d3548',
                },
                accent: {
                    DEFAULT: '#2a4070',
                    soft: '#4a6cb0',
                    link: '#7eb8ff',
                },
                warn: '#c9a227',
            },
            fontFamily: {
                sans: ['system-ui', 'sans-serif'],
            },
            maxWidth: {
                console: '56rem',
            },
        },
    },
    plugins: [],
};
