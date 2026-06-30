import { defineConfig } from 'vite';
import { getCertificate } from '@vitejs/plugin-basic-ssl';

export default defineConfig(async () => {
  const cert = await getCertificate('node_modules/.vite/basic-ssl');
  return {
    root: 'demo',
    server: {
      host: true,
      https: { cert, key: cert },
    },
  };
});
