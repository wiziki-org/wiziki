import { defineConfig } from 'vite';

// En développement : `npm run dev:web` (interface sur :5173) + `npm run dev` (API sur :3000)
const API = process.env.WIZIKI_API || 'http://localhost:3000';

export default defineConfig({
    build: {
        outDir: 'dist',
        emptyOutDir: true,
        assetsDir: 'assets',
    },
    server: {
        proxy: {
            '/api': API,
            '/media': API,
            '/uploads': API,
        },
    },
});
